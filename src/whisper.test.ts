import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWhisperEngine, MODEL_MISSING, WHISPER_MODEL } from "./whisper.js";

// A stand-in `uv` on PATH: the tests check how the engine runs the worker and
// handles its exit, not Whisper itself, which the live bb check covers.
let directory: string;
const saved = { PATH: process.env.PATH, HF_HUB_CACHE: process.env.HF_HUB_CACHE };
const part = { bytes: new Uint8Array([1, 2, 3]), filename: "recording.webm", mimeType: "audio/webm", index: 0 };
const options = (timeoutMs = 5000, signal = new AbortController().signal) => ({
  hint: "composer text",
  terms: ["Hermes"],
  signal,
  timeoutMs,
});

async function fakeUv(script: string) {
  await writeFile(join(directory, "bin", "uv"), `#!/bin/sh\n${script}\n`);
  await chmod(join(directory, "bin", "uv"), 0o755);
}

beforeEach(async () => {
  // /tmp may be mounted noexec, so the stand-in uv lives under node_modules.
  const base = join(process.cwd(), "node_modules", ".cache");
  await mkdir(base, { recursive: true });
  directory = await mkdtemp(join(base, "whisper-test-"));
  await mkdir(join(directory, "bin"));
  await mkdir(join(directory, "hub", `models--${WHISPER_MODEL.replace("/", "--")}`, "snapshots", "rev"), { recursive: true });
  process.env.PATH = `${join(directory, "bin")}:${saved.PATH}`;
  process.env.HF_HUB_CACHE = join(directory, "hub");
});
afterEach(async () => {
  process.env.PATH = saved.PATH;
  if (saved.HF_HUB_CACHE === undefined) delete process.env.HF_HUB_CACHE;
  else process.env.HF_HUB_CACHE = saved.HF_HUB_CACHE;
  await rm(directory, { recursive: true, force: true });
});

describe("local Whisper engine", () => {
  it("is ready with uv and a downloaded model, and explains how to download a missing one", async () => {
    await fakeUv("exit 0");
    expect(await createWhisperEngine(async () => "").status()).toEqual({ ready: true });
    process.env.HF_HUB_CACHE = join(directory, "empty");
    expect(await createWhisperEngine(async () => "").status()).toEqual({ ready: false, message: MODEL_MISSING });
  });

  it("passes the audio file and language to the worker and returns its transcript", async () => {
    await fakeUv(`for a in "$@"; do echo "$a"; done > "${directory}/args"; printf '{"text":"Спроси у Гермеса."}'`);
    const text = await createWhisperEngine(async () => "ru").transcribe(part, options());
    expect(text).toBe("Спроси у Гермеса.");
    const args = (await readFile(join(directory, "args"), "utf8")).trim().split("\n");
    expect(args.slice(0, 5)).toEqual(["run", "--no-project", "--quiet", "--with", "faster-whisper==1.2.1"]);
    expect(args.at(-3)).toBe(WHISPER_MODEL);
    expect(args.at(-1)).toBe("ru");
    expect(args.at(-4)).toMatch(/recording\.webm$/);
    expect(args.join(" ")).not.toContain("composer text");
  });

  it("reports the worker's last error line on a failed exit", async () => {
    await fakeUv(`echo "Traceback" >&2; echo "RuntimeError: model broke" >&2; exit 1`);
    await expect(createWhisperEngine(async () => "").transcribe(part, options())).rejects.toMatchObject({
      message: "Local Whisper exited with code 1: RuntimeError: model broke",
      retryable: false,
    });
  });

  it("kills the worker and its children on timeout", async () => {
    await fakeUv(`sleep 30 & echo $! > "${directory}/child"; wait`);
    const started = performance.now();
    await expect(createWhisperEngine(async () => "").transcribe(part, options(500))).rejects.toMatchObject({
      message: "Local Whisper transcription timed out.",
      retryable: true,
    });
    expect(performance.now() - started).toBeLessThan(3000);
    const child = Number(await readFile(join(directory, "child"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(child, 0)).toThrow();
  });

  it("propagates cancellation", async () => {
    await fakeUv("sleep 30");
    const controller = new AbortController();
    const outcome = createWhisperEngine(async () => "").transcribe(part, options(5000, controller.signal));
    setTimeout(() => controller.abort(new Error("owner canceled")), 100);
    await expect(outcome).rejects.toThrow("owner canceled");
  });
});
