import { transcribeCodexVoice } from "./ai/chatgpt-client.js";
import { readCodexAuthCredentials } from "./ai/codex-auth.js";
import { AiServiceFailure } from "./ai/failure.js";
import { suppressPromptEcho } from "./audio.js";
import type { AudioPart, Engine } from "./types.js";

const GLOSSARY_CHARS = 1000;

// The ChatGPT endpoint takes no keyword list, so the lexicon terms ride in the
// prompt ahead of the composer text, which stays last as the preceding context.
export function glossaryLine(terms: readonly string[]): string {
  let glossary = "";
  for (const term of terms) {
    const next = glossary ? `${glossary}, ${term}` : term;
    if (next.length > GLOSSARY_CHARS) break;
    glossary = next;
  }
  return glossary && `Glossary: ${glossary}.`;
}

export const ACCOUNT_BLOCK_MS = 5 * 60 * 1000;
const ACCOUNT_MESSAGES: Record<number, string> = {
  401: "OpenRouter rejected the API key. Update it in Dictation settings.",
  402: "OpenRouter balance is too low for audio. Top up the account; dictation retries in a few minutes.",
};

export function createEngines(
  getKey: () => Promise<string | undefined>,
): Record<"openrouter" | "chatgpt", Engine> {
  let accountBlock: { key: string; until: number; message: string } | undefined;
  const ENGINES: Record<"openrouter" | "chatgpt", Engine> = {
    openrouter: {
      concurrency: 10,
      async status() {
        const key = (await getKey())?.trim();
        if (!key)
          return {
            ready: false,
            message: "Set the OpenRouter API key in Dictation settings.",
          };
        if (
          accountBlock?.key === key &&
          performance.now() < accountBlock.until
        )
          return { ready: false, message: accountBlock.message };
        return { ready: true };
      },
      async transcribe(part, opts) {
        const key = (await getKey())?.trim();
        if (!key)
          throw new AiServiceFailure(
            "auth_required",
            "dictation_openrouter_key_missing",
            "Set the OpenRouter API key in Dictation settings.",
          );
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), opts.timeoutMs);
        const signal = AbortSignal.any([opts.signal, timeout.signal]);
        try {
          const body = new FormData();
          body.set(
            "file",
            new Blob([part.bytes], { type: part.mimeType }),
            part.filename,
          );
          body.set("model", "openai/gpt-transcribe");
          if (opts.hint !== null) body.set("prompt", opts.hint);
          for (const term of opts.terms) body.append("keyterms[]", term);
          const response = await fetch(
            "https://openrouter.ai/api/v1/audio/transcriptions",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${key}` },
              body,
              signal,
            },
          );
          if (!response.ok) {
            let providerMessage = "";
            const reader = response.body?.getReader();
            if (reader) {
              let onAbort: () => void = () => {};
              const aborted = new Promise<never>((_resolve, reject) => {
                onAbort = () => reject(signal.reason);
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) onAbort();
              });
              try {
                const bytes = new Uint8Array(4096);
                let length = 0;
                while (length < bytes.length) {
                  const { done, value } = await Promise.race([
                    reader.read(),
                    aborted,
                  ]);
                  if (done) break;
                  const chunk = value.subarray(0, bytes.length - length);
                  bytes.set(chunk, length);
                  length += chunk.length;
                }
                const value: unknown = JSON.parse(
                  new TextDecoder().decode(bytes.subarray(0, length)),
                );
                if (
                  typeof value === "object" &&
                  value !== null &&
                  "error" in value &&
                  typeof value.error === "object" &&
                  value.error !== null &&
                  "message" in value.error &&
                  typeof value.error.message === "string"
                ) {
                  providerMessage = value.error.message
                    .replace(/\s+/g, " ")
                    .trim();
                }
              } catch {
                if (signal.aborted) throw signal.reason;
              } finally {
                signal.removeEventListener("abort", onAbort);
                void reader.cancel().catch(() => {});
                reader.releaseLock();
              }
            }
            const accountMessage = ACCOUNT_MESSAGES[response.status];
            if (accountMessage)
              accountBlock = {
                key,
                until: performance.now() + ACCOUNT_BLOCK_MS,
                message: accountMessage,
              };
            const code =
              response.status === 401 || response.status === 403
                ? "auth_required"
                : response.status === 408
                  ? "timeout"
                  : response.status === 429
                    ? "rate_limited"
                    : response.status >= 500
                      ? "service_unavailable"
                      : "request_failed";
            const error = new AiServiceFailure(
              code,
              "dictation_openrouter_http",
              `OpenRouter transcription failed with HTTP ${response.status}${providerMessage ? `: ${providerMessage}` : ""}`,
            );
            const retry = response.headers.get("retry-after");
            if (retry !== null)
              error.retryAfterMs =
                Math.max(
                  0,
                  Number.isFinite(Number(retry))
                    ? Number(retry) * 1000
                    : Date.parse(retry) - Date.now(),
                ) || 0;
            throw error;
          }
          const value: unknown = await response.json();
          if (
            typeof value !== "object" ||
            value === null ||
            !("text" in value) ||
            typeof value.text !== "string"
          ) {
            throw new AiServiceFailure(
              "invalid_response",
              "dictation_openrouter_response",
              "OpenRouter response did not include transcript text.",
            );
          }
          accountBlock = undefined;
          return value.text;
        } catch (error) {
          if (opts.signal.aborted) throw opts.signal.reason;
          if (timeout.signal.aborted)
            throw new AiServiceFailure(
              "timeout",
              "dictation_openrouter_timeout",
              "OpenRouter transcription timed out.",
            );
          if (error instanceof TypeError)
            throw new AiServiceFailure(
              "service_unavailable",
              "dictation_openrouter_network",
              "OpenRouter network request failed.",
            );
          throw error;
        } finally {
          clearTimeout(timer);
        }
      },
    },
    chatgpt: {
      concurrency: 3,
      async status() {
        try {
          await readCodexAuthCredentials();
          return { ready: true };
        } catch (error) {
          return {
            ready: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
      async transcribe(part: AudioPart, opts) {
        const glossary = glossaryLine(opts.terms);
        const prompt = [glossary, opts.hint].filter(Boolean).join("\n\n") || null;
        try {
          const text = await transcribeCodexVoice(
            {
              model: "gpt-transcribe",
              audioBase64: Buffer.from(part.bytes).toString("base64"),
              filename: part.filename,
              mimeType: part.mimeType,
              hint: prompt,
              timeoutMs: opts.timeoutMs,
            },
            opts.signal,
          );
          return suppressPromptEcho(suppressPromptEcho(text, prompt), glossary);
        } catch (error) {
          if (error instanceof TypeError)
            throw new AiServiceFailure(
              "service_unavailable",
              "dictation_chatgpt_network",
              "ChatGPT network request failed.",
            );
          throw error;
        }
      },
    },
  };
  return ENGINES;
}
