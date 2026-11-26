import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  claudeBackend,
  createEditor,
  type EditBackend,
  openRouterBackend,
  splitForEditing,
} from "./edit.js";

const log = { info: vi.fn(), warn: vi.fn() };
const config = {
  lexicon: "Hermes: гермес",
  instructions: "Keep «короче».",
};
// The text-only view most tests need; the model label has its own tests.
const editor = (model = "vendor/editor", more: EditBackend[] = []) => {
  const edit = createEditor(
    config,
    [openRouterBackend("stub-key", model), ...more],
    log,
  );
  return async (text: string, opts: { signal: AbortSignal; deadline: number }) =>
    (await edit(text, opts)).text;
};
const later = (ms = 10000) => performance.now() + ms;
const reply = (content: string) =>
  Response.json({ choices: [{ message: { content } }] });
function hang(_url: unknown, request: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) =>
    request.signal!.addEventListener(
      "abort",
      () => reject(request.signal!.reason),
      { once: true },
    ),
  );
}
const body = (call: unknown[]) =>
  JSON.parse((call[1] as RequestInit).body as string);

afterEach(() => {
  vi.unstubAllGlobals();
  log.warn.mockClear();
});

describe("editing with a stub OpenRouter", () => {
  it("returns the edited text and sends lexicon, instructions and transcript", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () =>
      reply("Спроси у Hermes."),
    );
    vi.stubGlobal("fetch", fetchStub);
    const edit = editor();
    expect(
      await edit("спроси у гермеса", {
        signal: new AbortController().signal,
        deadline: later(),
      }),
    ).toBe("Спроси у Hermes.");
    const sent = body(fetchStub.mock.calls[0]);
    expect(sent.model).toBe("vendor/editor");
    expect(sent.messages[0].content).toContain("Lexicon:\nHermes: гермес");
    expect(sent.messages[0].content).toContain("Keep «короче».");
    expect(sent.messages[1].content).toBe(
      "<transcript>\nспроси у гермеса\n</transcript>",
    );
  });

  it.each([
    ["an HTTP error", async () => new Response(null, { status: 503 })],
    [
      "a network error",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["an empty reply", async () => reply("")],
    [
      "a reply that answers instead of editing",
      async () => reply("Готово."),
    ],
  ])("inserts the raw transcript after %s", async (_name, stub) => {
    vi.stubGlobal("fetch", stub);
    const raw = "удали временные файлы. ".repeat(12).trim();
    expect(
      await editor()(raw, {
        signal: new AbortController().signal,
        deadline: later(),
      }),
    ).toBe(raw);
    expect(log.warn).toHaveBeenCalledTimes(2);
    for (const [message] of log.warn.mock.calls) expect(message).not.toContain("удали");
  });

  it("gives up at the deadline and inserts the raw transcript", async () => {
    vi.stubGlobal("fetch", hang);
    const started = performance.now();
    expect(
      await editor()("сырой текст", {
        signal: new AbortController().signal,
        deadline: started + 1600,
      }),
    ).toBe("сырой текст");
    expect(performance.now() - started).toBeLessThan(2500);
    expect(log.warn.mock.calls[0][0]).toContain("timed out");
  });

  it("does not call the model when the budget is already spent", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => reply("edited"));
    vi.stubGlobal("fetch", fetchStub);
    expect(
      await editor()("сырой текст", {
        signal: new AbortController().signal,
        deadline: later(500),
      }),
    ).toBe("сырой текст");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("edits long text in parallel parts and keeps the raw text only where a part failed", async () => {
    const sentence = (n: number) => `предложение номер ${n} ${"слово ".repeat(40).trim()}.`;
    const raw = Array.from({ length: 30 }, (_, i) => sentence(i)).join(" ");
    const parts = splitForEditing(raw);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join(" ")).toBe(raw);
    let active = 0;
    let peak = 0;
    vi.stubGlobal("fetch", async (_url: unknown, request: RequestInit) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      const chunk = JSON.parse(request.body as string).messages[1].content;
      if (chunk.includes("номер 0 ")) return new Response(null, { status: 500 });
      return reply(chunk.replace(/<\/?transcript>/g, "").trim().toUpperCase());
    });
    const edited = await editor()(raw, {
      signal: new AbortController().signal,
      deadline: later(),
    });
    expect(edited).toBe(
      [parts[0], ...parts.slice(1).map((part) => part.toUpperCase())].join(" "),
    );
    expect(peak).toBe(parts.length);
  });

  it("retries with minimal reasoning for a model that cannot disable it and remembers the model", async () => {
    const fetchStub = vi.fn<typeof fetch>(async (_url, request) =>
      JSON.parse(request!.body as string).reasoning.enabled === false
        ? Response.json(
            {
              error: {
                message:
                  "Reasoning is mandatory for this endpoint and cannot be disabled.",
              },
            },
            { status: 400 },
          )
        : reply("edited"),
    );
    vi.stubGlobal("fetch", fetchStub);
    const edit = editor("vendor/thinker");
    const opts = { signal: new AbortController().signal, deadline: later() };
    expect(await edit("raw", opts)).toBe("edited");
    expect(await edit("raw", opts)).toBe("edited");
    expect(fetchStub.mock.calls.map((call) => body(call).reasoning)).toEqual([
      { enabled: false },
      { effort: "minimal" },
      { effort: "minimal" },
    ]);
  });

  it("propagates cancellation instead of inserting text", async () => {
    vi.stubGlobal("fetch", hang);
    const controller = new AbortController();
    const outcome = editor()("raw", {
      signal: controller.signal,
      deadline: later(),
    });
    controller.abort(new Error("owner canceled"));
    await expect(outcome).rejects.toThrow("owner canceled");
  });
});

describe("editing falls back to the next backend", () => {
  const stub = (name: string, edit: EditBackend["edit"]): EditBackend => ({ name, edit });
  const opts = () => ({ signal: new AbortController().signal, deadline: later() });

  it("uses the second backend when OpenRouter refuses and labels the result with it", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { message: "Insufficient credits" } }, { status: 402 }),
    );
    const second = vi.fn(async () => "Спроси у Hermes.");
    const edit = createEditor(
      config,
      [openRouterBackend("stub-key", "vendor/editor"), stub("claude-code/haiku", second)],
      log,
    );
    expect(await edit("спроси у гермеса", opts())).toEqual({
      text: "Спроси у Hermes.",
      model: "claude-code/haiku",
    });
    expect((second.mock.calls[0] as unknown as [string])[0]).toContain("Lexicon:\nHermes: гермес");
    expect(log.warn.mock.calls[0][0]).toContain("vendor/editor failed (HTTP 402");
  });

  it("inserts the raw transcript and labels it raw when every backend fails", async () => {
    const failing = stub("a", async () => {
      throw new Error("down");
    });
    const edit = createEditor(config, [failing, { ...failing, name: "b" }], log);
    expect(await edit("сырой текст", opts())).toEqual({ text: "сырой текст", model: "raw" });
    expect(log.warn).toHaveBeenCalledTimes(3);
  });
});

describe("Claude Code backend with a stand-in claude executable", () => {
  let directory: string;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function fakeClaude(script: string): Promise<string> {
    // /tmp may be mounted noexec, so the stand-in lives under node_modules.
    const base = join(process.cwd(), "node_modules", ".cache");
    await mkdir(base, { recursive: true });
    directory = await mkdtemp(join(base, "fake-claude-"));
    const path = join(directory, "claude");
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it("sends the prompt as the system prompt, the transcript on stdin, and returns stdout", async () => {
    const command = await fakeClaude(
      `for a in "$@"; do last="$a"; done; printf '%s|' "$2" "$4" "$last" > "$(dirname "$0")/args"; cat | sed 's/гермеса/Hermes/'`,
    );
    const text = await claudeBackend(command).edit(
      "SYSTEM",
      "спроси у гермеса",
      new AbortController().signal,
    );
    expect(text).toBe("спроси у Hermes");
    expect(await readFile(join(directory, "args"), "utf8")).toBe("--safe-mode|haiku|SYSTEM|");
  });

  it("reports a non-zero exit with the last stderr line", async () => {
    const command = await fakeClaude(`echo "Not logged in" >&2; exit 1`);
    await expect(
      claudeBackend(command).edit("S", "x", new AbortController().signal),
    ).rejects.toThrow("claude exited with code 1: Not logged in");
  });

  it("says Claude Code is missing when the command does not exist", async () => {
    await expect(
      claudeBackend("/nonexistent/claude").edit("S", "x", new AbortController().signal),
    ).rejects.toThrow("Claude Code is not installed");
  });
});
