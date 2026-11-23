import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  encodeParts,
  planAudioRanges,
  scanAudio,
  suppressPromptEcho,
} from "./audio.js";
import type { Editor } from "./edit.js";
import type { AudioPart, Engine, EngineError, Logger } from "./types.js";

function engineError(error: unknown): EngineError {
  if (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    typeof error.retryable === "boolean" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return {
      retryable: error.retryable,
      message: error.message,
      retryAfterMs:
        "retryAfterMs" in error && typeof error.retryAfterMs === "number"
          ? error.retryAfterMs
          : undefined,
    };
  }
  return {
    retryable: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function transcribe(
  file: File,
  opts: { signal: AbortSignal; hint: string | null; terms: readonly string[] },
  engine: Engine,
  log: Logger,
  edit?: Editor,
): Promise<string> {
  const start = performance.now();
  const deadline = start + 64000;
  const controller = new AbortController();
  const cancel = () => controller.abort(opts.signal.reason);
  opts.signal.throwIfAborted();
  opts.signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Dictation exceeded 64-second budget")),
    64000,
  );
  const signal = controller.signal;
  let directory: string | undefined;
  const timing = (stage: string, since: number) =>
    log.info(`${stage} ${Math.round(performance.now() - since)}ms`);
  try {
    directory = await mkdtemp(join(tmpdir(), "dictation-"));
    const source = join(directory, "recording");
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal.throwIfAborted();
    await writeFile(source, bytes, { signal });
    const scanStart = performance.now();
    const scan = await scanAudio(source, directory, signal);
    timing("scan", scanStart);
    const encodeStart = performance.now();
    const parts: AudioPart[] =
      scan.duration <= 200
        ? [{ bytes, filename: file.name, mimeType: file.type, index: 0 }]
        : await encodeParts(
            scan.wav,
            planAudioRanges(scan.duration, scan.silences),
            directory,
            signal,
          );
    timing(`encode ${parts.length} parts`, encodeStart);
    const texts: string[] = new Array(parts.length);
    let next = 0;
    let failure: unknown;
    const sendStart = performance.now();
    async function worker() {
      while (next < parts.length && !signal.aborted) {
        const part = parts[next++];
        const hint = part.index === 0 ? opts.hint?.slice(-500) || null : null;
        for (let attempt = 0; attempt < 2; attempt++) {
          signal.throwIfAborted();
          const remaining = deadline - performance.now();
          if (remaining <= 0)
            throw new Error("Dictation exceeded 64-second budget");
          try {
            const text = await engine.transcribe(part, {
              hint,
              terms: opts.terms,
              signal,
              timeoutMs: Math.min(remaining / 2, 25000),
            });
            if (text.length > 6000)
              log.warn(
                `Part ${part.index} returned ${text.length} characters; possible transcription ceiling`,
              );
            texts[part.index] = suppressPromptEcho(text, hint).trim();
            break;
          } catch (error) {
            const classified = engineError(error);
            if (signal.aborted || !classified.retryable || attempt === 1)
              throw error;
            const wait = classified.retryAfterMs ?? 250;
            if (wait >= deadline - performance.now()) throw error;
            await delay(wait, undefined, { signal });
          }
        }
      }
    }
    await Promise.allSettled(
      Array.from(
        { length: Math.min(engine.concurrency, parts.length) },
        async () => {
          try {
            await worker();
          } catch (error) {
            if (failure === undefined) failure = error;
            controller.abort(error);
          }
        },
      ),
    );
    if (failure !== undefined) throw failure;
    signal.throwIfAborted();
    timing("transcribe", sendStart);
    const raw = texts.filter(Boolean).join(" ");
    if (!edit || !raw) return raw;
    const editStart = performance.now();
    // Editing gets whatever transcription left of the budget and falls back
    // to the raw text, so a slow model never costs the user the transcript.
    const edited = await edit(raw, {
      signal: opts.signal,
      deadline: deadline - 1000,
    });
    timing("edit", editStart);
    return edited;
  } finally {
    controller.abort();
    clearTimeout(timeout);
    opts.signal.removeEventListener("abort", cancel);
    if (directory) await rm(directory, { recursive: true, force: true });
    timing("total", start);
  }
}
