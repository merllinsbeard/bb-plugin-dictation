import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, splitForEditing } from "./edit.js";

const log = { info: vi.fn(), warn: vi.fn() };
const config = {
  key: "stub-key",
  model: "vendor/editor",
  lexicon: "Hermes: гермес",
  instructions: "Keep «короче».",
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
    const edit = createEditor(config, log);
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
      await createEditor(config, log)(raw, {
        signal: new AbortController().signal,
        deadline: later(),
      }),
    ).toBe(raw);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0][0]).not.toContain("удали");
  });

  it("gives up at the deadline and inserts the raw transcript", async () => {
    vi.stubGlobal("fetch", hang);
    const started = performance.now();
    expect(
      await createEditor(config, log)("сырой текст", {
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
      await createEditor(config, log)("сырой текст", {
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
    const edited = await createEditor(config, log)(raw, {
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
    const edit = createEditor({ ...config, model: "vendor/thinker" }, log);
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
    const outcome = createEditor(config, log)("raw", {
      signal: controller.signal,
      deadline: later(),
    });
    controller.abort(new Error("owner canceled"));
    await expect(outcome).rejects.toThrow("owner canceled");
  });
});
