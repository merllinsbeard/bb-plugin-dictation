import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  encodeParts,
  findFfmpeg,
  planAudioRanges,
  runFfmpeg,
  scanAudio,
} from "./audio.js";
let directory: string;
let source: string;
const signal = new AbortController().signal;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "dictation-audio-test-"));
  source = join(directory, "signal.wav");
  await runFfmpeg(
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=if(between(t\\,174\\,176)+between(t\\,354\\,356)\\,0\\,0.2*sin(2*PI*440*t)):s=16000:d=400",
      "-c:a",
      "pcm_s16le",
      source,
    ],
    signal,
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
it("uses decoded samples for duration and cuts at the known pauses", async () => {
  const scan = await scanAudio(source, directory, signal);
  expect(scan.samples).toBe(6400000);
  expect(scan.duration).toBe(400);
  const ranges = planAudioRanges(scan.duration, scan.silences);
  expect(ranges).toHaveLength(3);
  expect(ranges[0].startSeconds).toBe(0);
  expect(ranges[0].endSeconds).toBeCloseTo(175, 1);
  expect(ranges[1].endSeconds).toBeCloseTo(355, 1);
  expect(ranges[2].endSeconds).toBe(400);
  const parts = await encodeParts(scan.wav, ranges, directory, signal);
  expect(parts.map((part) => part.filename)).toEqual([
    "part-0.webm",
    "part-1.webm",
    "part-2.webm",
  ]);
  const partScan = await scanAudio(
    join(directory, "part-1.webm"),
    directory,
    signal,
  );
  expect(partScan.duration).toBeCloseTo(180, 1);
  expect(
    (await readFile(join(directory, "part-0.webm")))
      .subarray(0, 4)
      .toString("hex"),
  ).toBe("1a45dfa3");
});
it("plans fixed target cuts when no pauses exist", () => {
  expect(planAudioRanges(570, [])).toEqual([
    { startSeconds: 0, endSeconds: 180 },
    { startSeconds: 180, endSeconds: 360 },
    { startSeconds: 360, endSeconds: 570 },
  ]);
});
async function fakeFfmpegDir(): Promise<string> {
  const bin = await mkdtemp(join(directory, "bin-"));
  await symlink(process.execPath, join(bin, "ffmpeg"));
  return bin;
}
it("finds ffmpeg on PATH before the fallback locations", async () => {
  const bin = await fakeFfmpegDir();
  vi.stubEnv("PATH", bin);
  try {
    expect(await findFfmpeg()).toBe(join(bin, "ffmpeg"));
  } finally {
    vi.unstubAllEnvs();
  }
});
it("ignores relative PATH entries", async () => {
  const relativeBin = relative(process.cwd(), await fakeFfmpegDir());
  const absoluteBin = await fakeFfmpegDir();
  vi.stubEnv("PATH", [relativeBin, absoluteBin].join(delimiter));
  try {
    expect(await findFfmpeg()).toBe(join(absoluteBin, "ffmpeg"));
  } finally {
    vi.unstubAllEnvs();
  }
});
