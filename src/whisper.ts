import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { AiServiceFailure } from "./ai/failure.js";
import { findFfmpeg } from "./audio.js";
import type { AudioPart, Engine } from "./types.js";

export const WHISPER_MODEL = "mobiuslabsgmbh/faster-whisper-large-v3-turbo";
export const FASTER_WHISPER = "faster-whisper==1.2.1";
const THREADS = Math.max(1, Math.min(8, availableParallelism()));

export const UV_MISSING =
  "uv was not found. Install it (https://docs.astral.sh/uv/) on the machine that runs the bb server.";
export const MODEL_MISSING = `The local Whisper model is not downloaded yet. Run once on the bb server: uv run --no-project --with ${FASTER_WHISPER} python -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"`;

// faster-whisper decodes through PyAV, and PyAV 19 rejects its open() call, so
// the worker decodes with ffmpeg itself. It gets neither the lexicon nor the
// composer hint: on the owner's recordings both raised the word error rate
// (hotwords 16% → 38%, an initial prompt 16% → 17%); the editor restores terms.
const WORKER = `
import json, subprocess, sys
import numpy as np
from faster_whisper import WhisperModel
ffmpeg, audio, model_id, threads, language = sys.argv[1:6]
pcm = subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-i", audio, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], capture_output=True, check=True).stdout
samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
model = WhisperModel(model_id, device="cpu", compute_type="int8", cpu_threads=int(threads), local_files_only=True)
segments, _ = model.transcribe(samples, language=language or None, vad_filter=True)
sys.stdout.write(json.dumps({"text": " ".join(s.text.strip() for s in segments)}))
`;

async function findUv(): Promise<string | undefined> {
  const home = homedir();
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir)),
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  for (const directory of directories) {
    const candidate = join(directory, "uv");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

async function modelCached(): Promise<boolean> {
  const hub =
    process.env.HF_HUB_CACHE ??
    join(process.env.HF_HOME ?? join(homedir(), ".cache", "huggingface"), "hub");
  const snapshots = join(
    hub,
    `models--${WHISPER_MODEL.replace("/", "--")}`,
    "snapshots",
  );
  try {
    return (await readdir(snapshots)).length > 0;
  } catch {
    return false;
  }
}

function runWorker(
  uv: string,
  args: string[],
  signal: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // uv starts Python as its own child, so the worker runs in a process
    // group of its own and cancellation kills the whole group.
    const child = spawn(uv, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_OFFLINE: "1" },
    });
    let stdout = "";
    let stderr = "";
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    signal.addEventListener("abort", kill, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (error) => {
      signal.removeEventListener("abort", kill);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      resolve({ code, stdout, stderr });
    });
  });
}

export function createWhisperEngine(
  getLanguage: () => Promise<string>,
): Engine {
  return {
    concurrency: 1,
    async status() {
      if (!(await findUv())) return { ready: false, message: UV_MISSING };
      if (!(await modelCached())) return { ready: false, message: MODEL_MISSING };
      return { ready: true };
    },
    async transcribe(part: AudioPart, opts) {
      const [uv, ffmpeg] = await Promise.all([findUv(), findFfmpeg()]);
      if (!uv)
        throw new AiServiceFailure("service_unavailable", "dictation_whisper_uv", UV_MISSING);
      if (!ffmpeg)
        throw new AiServiceFailure("service_unavailable", "dictation_whisper_ffmpeg", "ffmpeg was not found.");
      const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
      const directory = await mkdtemp(join(tmpdir(), "dictation-whisper-"));
      try {
        const audio = join(directory, part.filename.replace(/[^\w.-]/g, "_") || "part");
        await writeFile(audio, part.bytes);
        const language = (await getLanguage()).trim();
        const { code, stdout, stderr } = await runWorker(
          uv,
          [
            "run",
            "--no-project",
            "--quiet",
            "--with",
            FASTER_WHISPER,
            "python",
            "-I",
            "-c",
            WORKER,
            ffmpeg,
            audio,
            WHISPER_MODEL,
            String(THREADS),
            language,
          ],
          signal,
        );
        if (opts.signal.aborted) throw opts.signal.reason;
        if (signal.aborted)
          throw new AiServiceFailure("timeout", "dictation_whisper_timeout", "Local Whisper transcription timed out.");
        if (code !== 0) {
          const last = stderr.trim().split("\n").at(-1) ?? "";
          throw new AiServiceFailure(
            "request_failed",
            "dictation_whisper_exit",
            `Local Whisper exited with code ${code}${last ? `: ${last.slice(0, 300)}` : ""}`,
          );
        }
        const value: unknown = JSON.parse(stdout);
        if (
          typeof value !== "object" ||
          value === null ||
          !("text" in value) ||
          typeof value.text !== "string"
        )
          throw new AiServiceFailure("invalid_response", "dictation_whisper_output", "Local Whisper printed no transcript.");
        return value.text;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
