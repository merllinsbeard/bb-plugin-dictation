import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { AudioPart, AudioRange } from "./types.js";

export const FFMPEG_MISSING =
  "ffmpeg was not found. Install it (brew install ffmpeg, or apt install ffmpeg) on the machine that runs the bb server.";
export async function findFfmpeg(): Promise<string | undefined> {
  const directories = [
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter((dir) => isAbsolute(dir)),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  for (const directory of directories) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}
export async function runFfmpeg(
  args: string[],
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error(FFMPEG_MISSING);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-nostdin", "-hide_banner", "-nostats", ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const cancel = () => child.kill("SIGKILL");
    signal.addEventListener("abort", cancel, { once: true });
    for (const [stream, append] of [
      [
        child.stdout,
        (chunk: string) => {
          stdout += chunk;
        },
      ],
      [
        child.stderr,
        (chunk: string) => {
          stderr += chunk;
        },
      ],
    ] as const) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        append(chunk);
        if (stdout.length + stderr.length > 16 * 1024 * 1024) {
          overflow = true;
          cancel();
        }
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) reject(signal.reason);
      else if (overflow) reject(new Error("ffmpeg output exceeded 16 MiB"));
      else if (code !== 0)
        reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-1200)}`));
      else resolve({ stdout, stderr });
    });
  });
}

export function planAudioRanges(
  duration: number,
  silences: AudioRange[],
): AudioRange[] {
  const ranges: AudioRange[] = [];
  let start = 0;
  while (duration - start > 210) {
    const target = start + 180;
    const candidates = silences
      .filter(
        (pause) =>
          pause.endSeconds >= start + 150 && pause.startSeconds <= start + 210,
      )
      .map((pause) =>
        pause.startSeconds <= target && pause.endSeconds >= target
          ? target
          : Math.max(
              start + 150,
              Math.min(
                start + 210,
                (pause.startSeconds + pause.endSeconds) / 2,
              ),
            ),
      )
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);
    const end = candidates[0] ?? target;
    ranges.push({ startSeconds: start, endSeconds: end });
    start = end;
  }
  ranges.push({ startSeconds: start, endSeconds: duration });
  return ranges;
}

export async function scanAudio(
  source: string,
  directory: string,
  signal: AbortSignal,
) {
  const wav = join(directory, "decoded.wav");
  const scan = await runFfmpeg(
    [
      "-v",
      "info",
      "-i",
      source,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-af",
      "aresample=16000,asetpts=N/SR/TB,silencedetect=noise=-35dB:d=0.3,ametadata=mode=print:file=-,astats=measure_perchannel=none:measure_overall=Number_of_samples",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-y",
      wav,
    ],
    signal,
  );
  const samples = Number(scan.stderr.match(/Number of samples:\s*(\d+)/)?.[1]);
  const duration = samples / 16000;
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("ffmpeg decoded no audio");
  const silences: AudioRange[] = [];
  let pauseStart: number | undefined;
  for (const match of scan.stdout.matchAll(
    /lavfi\.silence_(start|end)=([\d.]+)/g,
  )) {
    if (match[1] === "start") pauseStart = Number(match[2]);
    else {
      silences.push({
        startSeconds: pauseStart ?? 0,
        endSeconds: Number(match[2]),
      });
      pauseStart = undefined;
    }
  }
  if (pauseStart !== undefined)
    silences.push({ startSeconds: pauseStart, endSeconds: duration });
  return { duration, samples, silences, wav };
}

export async function encodeParts(
  wav: string,
  ranges: AudioRange[],
  directory: string,
  signal: AbortSignal,
): Promise<AudioPart[]> {
  const results = await Promise.allSettled(
    ranges.map(async (range, index) => {
      const filename = `part-${index}.webm`;
      const output = join(directory, filename);
      await runFfmpeg(
        [
          "-v",
          "error",
          "-ss",
          String(range.startSeconds),
          "-t",
          String(range.endSeconds - range.startSeconds),
          "-i",
          wav,
          "-map",
          "0:a:0",
          "-c:a",
          "libopus",
          "-b:a",
          "32k",
          "-compression_level",
          "0",
          "-y",
          output,
        ],
        signal,
      );
      return {
        bytes: new Uint8Array(await readFile(output)),
        filename,
        mimeType: "audio/webm",
        index,
      };
    }),
  );
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

export function suppressPromptEcho(text: string, hint: string | null): string {
  const normalize = (value: string) =>
    value.replace(/[,.\s]/g, "").toLowerCase();
  return hint && normalize(text) === normalize(hint) ? "" : text;
}
