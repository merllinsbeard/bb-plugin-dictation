import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGeminiEngine } from "./gemini.js";

// A stand-in `agy-pool` on PATH: the tests check how the engine runs the CLI
// and handles its exit; the live bb check covers Gemini itself.
let directory: string;
const savedPath = process.env.PATH;
const part = { bytes: new Uint8Array([1, 2, 3]), filename: "part-0.webm", mimeType: "audio/webm", index: 0 };
const options = (signal = new AbortController().signal) => ({
  hint: "composer text",
  terms: ["Hermes", "OpenViking"],
  signal,
  timeoutMs: 100,
});

async function fakeAgy(script: string) {
  await writeFile(join(directory, "bin", "agy-pool"), `#!/bin/sh\n${script}\n`);
  await chmod(join(directory, "bin", "agy-pool"), 0o755);
}

beforeEach(async () => {
  // /tmp may be mounted noexec, so the stand-in lives under node_modules.
  const base = join(process.cwd(), "node_modules", ".cache");
  await mkdir(base, { recursive: true });
  directory = await mkdtemp(join(base, "gemini-test-"));
  await mkdir(join(directory, "bin"));
  process.env.PATH = `${join(directory, "bin")}:/usr/bin:/bin`;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(directory, { recursive: true, force: true });
});

describe("Gemini engine through the Antigravity CLI", () => {
  it("sends the audio file in its workspace with the lexicon in the prompt, and returns the reply", async () => {
    await fakeAgy(
      `pwd > "${directory}/cwd"; ls > "${directory}/files"; printf '%s\\n' "$@" > "${directory}/args"; sleep 0.3; echo "  Спроси у Hermes.  "`,
    );
    expect(await createGeminiEngine().transcribe(part, options())).toBe("Спроси у Hermes.");
    const args = await readFile(join(directory, "args"), "utf8");
    expect(args).toContain("Transcribe the speech in the audio file part-0.webm");
    expect(args).toContain("Glossary: Hermes, OpenViking.");
    expect(args).not.toContain("composer text");
    expect(args).toContain("--add-dir");
    expect((await readFile(join(directory, "files"), "utf8")).trim()).toBe("part-0.webm");
    expect(args).toContain((await readFile(join(directory, "cwd"), "utf8")).trim());
  });

  it("reports the CLI's last error line on a failed exit", async () => {
    await fakeAgy(`echo "quota exhausted for all accounts" >&2; exit 2`);
    await expect(createGeminiEngine().transcribe(part, options())).rejects.toMatchObject({
      message: "Antigravity CLI exited with code 2: quota exhausted for all accounts",
      retryable: false,
    });
  });

  it("kills the CLI and its children on cancellation", async () => {
    await fakeAgy(`sleep 30 & echo $! > "${directory}/child"; wait`);
    const controller = new AbortController();
    const outcome = createGeminiEngine().transcribe(part, options(controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const child = Number(await readFile(join(directory, "child"), "utf8"));
    controller.abort(new Error("budget spent"));
    await expect(outcome).rejects.toThrow("budget spent");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(child, 0)).toThrow();
  });
});
