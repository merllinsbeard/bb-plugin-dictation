import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { runFfmpeg } from "./audio.js";
import { createEditor } from "./edit.js";
import { attemptTimeoutMs, transcribe } from "./pipeline.js";
import type { AudioPart, Engine } from "./types.js";
let directory: string;
let long: File;
let short: File;
const log = { info: vi.fn(), warn: vi.fn() };
const opts = {
  signal: new AbortController().signal,
  hint: null,
  terms: [] as string[],
};
function engine(fn: Engine["transcribe"]): Engine {
  return {
    transcribe: fn,
    concurrency: 3,
    status: async () => ({ ready: true }),
  };
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "dictation-pipeline-test-"));
  const source = join(directory, "source.wav");
  await runFfmpeg(
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000:duration=550",
      "-c:a",
      "pcm_s16le",
      source,
    ],
    opts.signal,
  );
  long = new File([await readFile(source)], "recording.wav", {
    type: "audio/wav",
  });
  const shortSource = join(directory, "short.mp4");
  await runFfmpeg(
    ["-v", "error", "-i", source, "-t", "1", "-c:a", "aac", shortSource],
    opts.signal,
  );
  short = new File([await readFile(shortSource)], "original.mp4", {
    type: "audio/mp4",
  });
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("joins parts in source order even when completion order differs", async () => {
  const seen: Array<[number, string | null]> = [];
  const result = await transcribe(
    long,
    { ...opts, hint: "x".repeat(510) },
    engine(async (part, options) => {
      seen.push([part.index, options.hint]);
      await delay((3 - part.index) * 10);
      return `part-${part.index}`;
    }),
    log,
  );
  expect(result).toBe("part-0 part-1 part-2");
  expect(seen).toEqual([
    [0, "x".repeat(500)],
    [1, null],
    [2, null],
  ]);
});
it("sends the lexicon terms with every part, not only the first", async () => {
  const seen: Array<readonly string[]> = [];
  await transcribe(
    long,
    { ...opts, terms: ["Hermes", "OpenViking"] },
    engine(async (part, options) => {
      seen[part.index] = options.terms;
      return `part-${part.index}`;
    }),
    log,
  );
  expect(seen).toEqual([
    ["Hermes", "OpenViking"],
    ["Hermes", "OpenViking"],
    ["Hermes", "OpenViking"],
  ]);
});
it("edits the joined transcript within the 64-second budget", async () => {
  const before = performance.now();
  let received: { text: string; deadline: number } | undefined;
  const result = await transcribe(
    long,
    opts,
    engine(async (part) => `part-${part.index}`),
    log,
    async (text, { deadline }) => {
      received = { text, deadline };
      return text.toUpperCase();
    },
  );
  expect(result).toBe("PART-0 PART-1 PART-2");
  expect(received?.text).toBe("part-0 part-1 part-2");
  expect(received!.deadline - before).toBeLessThanOrEqual(64000);
  expect(received!.deadline - before).toBeGreaterThan(60000);
});
it("returns the raw transcript without calling the editor model when transcription used the budget", async () => {
  const fetchStub = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchStub);
  const realNow = performance.now.bind(performance);
  let skipped = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + skipped);
  try {
    const result = await transcribe(
      short,
      opts,
      engine(async () => {
        skipped = 62000;
        return "сырой текст";
      }),
      log,
      createEditor({ key: "k", model: "vendor/editor", lexicon: "", instructions: "" }, log),
    );
    expect(result).toBe("сырой текст");
    expect(fetchStub).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
});
it("retries transient failures up to three times before rejecting", async () => {
  let attempts = 0;
  log.warn.mockClear();
  await expect(
    transcribe(
      short,
      opts,
      engine(async () => {
        attempts++;
        throw Object.assign(new Error("transient"), {
          retryable: true,
          retryAfterMs: 1,
        });
      }),
      log,
    ),
  ).rejects.toThrow("transient");
  expect(attempts).toBe(4);
  expect(log.warn).toHaveBeenCalledTimes(4);
});
it("recovers when a later transient retry succeeds", async () => {
  let attempts = 0;
  const result = await transcribe(
    short,
    opts,
    engine(async () => {
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error("upstream 503"), {
          retryable: true,
          retryAfterMs: 1,
        });
      }
      return "recovered";
    }),
    log,
  );
  expect(attempts).toBe(3);
  expect(result).toBe("recovered");
});
it("gives earlier attempts room to retry and gives the final attempt the remaining budget", () => {
  expect(attemptTimeoutMs(60000, 0, 4)).toBe(25000);
  expect(attemptTimeoutMs(20000, 1, 4)).toBe(12000);
  expect(attemptTimeoutMs(20000, 3, 4)).toBe(19500);
  expect(attemptTimeoutMs(40000, 3, 4)).toBe(30000);
});
it("accepts empty parts and preserves the rest", async () => {
  expect(
    await transcribe(
      long,
      opts,
      engine(async (part) => (part.index === 1 ? "" : `part-${part.index}`)),
      log,
    ),
  ).toBe("part-0 part-2");
});
it("passes original mp4 bytes, filename and MIME for short recordings and suppresses hint echo", async () => {
  let received: AudioPart | undefined;
  const result = await transcribe(
    short,
    { ...opts, hint: "Hello, world." },
    engine(async (part) => {
      received = part;
      return "hello world";
    }),
    log,
  );
  expect(result).toBe("");
  expect(received?.filename).toBe("original.mp4");
  expect(received?.mimeType).toBe("audio/mp4");
  expect(Buffer.from(received!.bytes)).toEqual(
    Buffer.from(await short.arrayBuffer()),
  );
});
it("cancels other fetches immediately after a permanent failure", async () => {
  let canceled = false;
  await expect(
    transcribe(
      long,
      opts,
      engine(async (part, options) => {
        if (part.index === 0) {
          await delay(10);
          throw Object.assign(new Error("auth failed"), { retryable: false });
        }
        return new Promise<string>((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => {
              canceled = true;
              reject(options.signal.reason);
            },
            { once: true },
          ),
        );
      }),
      log,
    ),
  ).rejects.toThrow("auth failed");
  expect(canceled).toBe(true);
});
async function matchingChildren(root: string): Promise<number[]> {
  const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "pid=,command="]);
  return stdout
    .split("\n")
    .filter((line) => line.includes("ffmpeg") && line.includes(root))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}
it("kills a real ffmpeg child and deletes its temporary files after abort", async () => {
  const root = await mkdtemp(join(directory, "abort-"));
  vi.stubEnv("TMPDIR", root);
  const controller = new AbortController();
  let called = false;
  const outcome = transcribe(
    long,
    { signal: controller.signal, hint: null, terms: [] },
    engine(async () => {
      called = true;
      return "unexpected";
    }),
    log,
  ).then(
    () => null,
    (error) => error,
  );
  let children: number[] = [];
  for (let i = 0; i < 100 && children.length === 0; i++) {
    children = await matchingChildren(root);
    if (!children.length) await delay(2);
  }
  controller.abort(new Error("owner canceled"));
  const error = await outcome;
  vi.unstubAllEnvs();
  expect(children.length).toBeGreaterThan(0);
  expect(error.message).toBe("owner canceled");
  expect(called).toBe(false);
  expect(await matchingChildren(root)).toEqual([]);
  expect(await readdir(root)).toEqual([]);
});
