import type { JsonValue } from "@get-bb/plugin-sdk";
import { fetchChatGpt, isCloudflareChallenge } from "./chatgpt-fetch.js";
import {
  parseJsonValue,
  readCodexAuthCredentials,
  toJsonObject,
  type CodexChatGptAuthCredentials,
} from "./codex-auth.js";
import { AiServiceFailure, type FailureCode } from "./failure.js";
export interface VoiceTranscribeCommand {
  model: string;
  audioBase64: string;
  mimeType: string;
  filename: string;
  hint: string | null;
  timeoutMs: number;
}
const CHATGPT_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const CODEX_ERROR_TEXT_MAX_BYTES = 4096;
const CODEX_TRANSCRIPTION_RESPONSE_MAX_BYTES = 1024 * 1024;
type ReadOverflowBehavior = "throw" | "truncate";
type CodexRequestOperation = "transcription";
interface CodexRequestDeadline {
  expiresAt: number;
  timeoutMs: number;
  signal: AbortSignal;
}
interface TimeoutFetchArgs {
  deadline: CodexRequestDeadline;
  work: (signal: AbortSignal) => Promise<Response>;
}
interface ReadChunkWithTimeoutArgs {
  deadline: CodexRequestDeadline;
  reader: ReadableStreamDefaultReader<Uint8Array>;
}
interface ReadLimitedResponseTextArgs {
  deadline: CodexRequestDeadline;
  maxBytes: number;
  overflowBehavior: ReadOverflowBehavior;
}
interface ChatGptTranscriptionFetchArgs {
  auth: CodexChatGptAuthCredentials;
  command: VoiceTranscribeCommand;
  deadline: CodexRequestDeadline;
}
interface CodexHttpErrorArgs {
  deadline: CodexRequestDeadline;
  operation: CodexRequestOperation;
  response: Response;
}
function optionalString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function createChatGptHeaders(auth: CodexChatGptAuthCredentials): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${auth.accessToken}`);
  headers.set("chatgpt-account-id", auth.accountId);
  headers.set("originator", "bb");
  headers.set("User-Agent", "bb-host-daemon");
  if (auth.isFedrampAccount) {
    headers.set("X-OpenAI-Fedramp", "true");
  }
  return headers;
}

function createCodexRequestDeadline(
  timeoutMs: number,
  signal: AbortSignal,
): CodexRequestDeadline {
  return {
    expiresAt: performance.now() + timeoutMs,
    timeoutMs,
    signal,
  };
}

function remainingCodexRequestTimeoutMs(
  deadline: CodexRequestDeadline,
): number {
  deadline.signal.throwIfAborted();
  const remainingMs = Math.ceil(deadline.expiresAt - performance.now());
  if (remainingMs <= 0) {
    throw codexRequestTimeoutError(deadline.timeoutMs);
  }
  return remainingMs;
}

async function runWithTimeout(args: TimeoutFetchArgs): Promise<Response> {
  const abortController = new AbortController();
  const timeoutMs = remainingCodexRequestTimeoutMs(args.deadline);
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  timeout.unref();
  const cancel = (): void => abortController.abort();
  args.deadline.signal.addEventListener("abort", cancel, { once: true });
  try {
    return await args.work(abortController.signal);
  } catch (error) {
    args.deadline.signal.throwIfAborted();
    if (abortController.signal.aborted) {
      throw codexRequestTimeoutError(args.deadline.timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    args.deadline.signal.removeEventListener("abort", cancel);
  }
}

function codexRequestTimeoutError(timeoutMs: number): AiServiceFailure {
  return new AiServiceFailure(
    "timeout",
    "dictation_request_timeout",
    `Codex request timed out after ${timeoutMs}ms`,
  );
}

function codexResponseTooLargeError(): AiServiceFailure {
  return new AiServiceFailure(
    "invalid_response",
    "dictation_response_too_large",
    "Codex response exceeded the maximum supported size.",
  );
}

async function readChunkWithTimeout({
  deadline,
  reader,
}: ReadChunkWithTimeoutArgs): ReturnType<
  ReadableStreamDefaultReader<Uint8Array>["read"]
> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let cancel: (() => void) | null = null;
  const timeoutMs = remainingCodexRequestTimeoutMs(deadline);
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(codexRequestTimeoutError(deadline.timeoutMs));
        }, timeoutMs);
        timeout.unref();
        cancel = () => reject(deadline.signal.reason);
        deadline.signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (cancel) {
      deadline.signal.removeEventListener("abort", cancel);
    }
  }
}

async function cancelReaderBestEffort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {}
}

async function readLimitedResponseText(
  response: Response,
  args: ReadLimitedResponseTextArgs,
): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const chunk = await readChunkWithTimeout({
        deadline: args.deadline,
        reader,
      });
      if (chunk.done) {
        break;
      }

      const value = chunk.value;
      totalBytes += value.byteLength;
      if (totalBytes > args.maxBytes) {
        if (args.overflowBehavior === "throw") {
          await cancelReaderBestEffort(reader);
          throw codexResponseTooLargeError();
        }
        const allowedBytes = value.byteLength - (totalBytes - args.maxBytes);
        if (allowedBytes > 0) {
          chunks.push(
            decoder.decode(value.slice(0, allowedBytes), {
              stream: true,
            }),
          );
        }
        truncated = true;
        await cancelReaderBestEffort(reader);
        break;
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return `${chunks.join("")}${truncated ? "..." : ""}`;
  } catch (error) {
    await cancelReaderBestEffort(reader);
    throw error;
  }
}

async function readErrorText(
  response: Response,
  deadline: CodexRequestDeadline,
): Promise<string> {
  const text = await readLimitedResponseText(response, {
    deadline,
    maxBytes: CODEX_ERROR_TEXT_MAX_BYTES,
    overflowBehavior: "truncate",
  }).catch(() => "");
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}

type FailureCodes = [generic: FailureCode, detail: string];

function codexRequestErrorCode(status: number): FailureCodes {
  if (status === 401) {
    return ["auth_required", "dictation_auth_failed"];
  }
  if (status === 408) {
    return ["timeout", "dictation_request_timeout"];
  }
  if (status === 429) {
    return ["rate_limited", "dictation_rate_limited"];
  }
  if (status >= 500) {
    return ["service_unavailable", "dictation_service_unavailable"];
  }
  return ["request_failed", "dictation_request_failed"];
}

function extractJsonErrorMessage(value: JsonValue): string | null {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractJsonErrorMessage(item);
      if (message) {
        return message;
      }
    }
    return null;
  }

  const object = toJsonObject(value);
  if (!object) {
    return null;
  }

  for (const key of ["message", "detail", "error"]) {
    const child = object[key];
    if (child === undefined) {
      continue;
    }
    const message = extractJsonErrorMessage(child);
    if (message) {
      return message;
    }
  }
  return null;
}

function extractProviderErrorMessage(rawText: string): string | null {
  const normalized = rawText.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  try {
    return extractJsonErrorMessage(parseJsonValue(normalized)) ?? normalized;
  } catch {
    return normalized;
  }
}

function isHtmlResponse(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("text/html") ?? false
  );
}

async function createCodexHttpError({
  deadline,
  operation,
  response,
}: CodexHttpErrorArgs): Promise<AiServiceFailure> {
  const prefix = `Codex ${operation} request failed with HTTP ${response.status}`;
  if (isCloudflareChallenge(response)) {
    return new AiServiceFailure(
      "service_unavailable",
      "dictation_service_unavailable",
      `${prefix}: chatgpt.com answered with a Cloudflare challenge that bb cannot solve. Retry, or choose another service in Settings → AI services.`,
    );
  }
  const providerMessage = isHtmlResponse(response)
    ? null
    : extractProviderErrorMessage(await readErrorText(response, deadline));
  const details = providerMessage ? `: ${providerMessage}` : "";
  const failure = new AiServiceFailure(
    ...codexRequestErrorCode(response.status),
    `${prefix}${details}`,
  );
  failure.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
  return failure;
}

function createChatGptTranscriptionHeaders(
  auth: CodexChatGptAuthCredentials,
  cloudflareHeaders: Headers,
): Headers {
  const headers = createChatGptHeaders(auth);
  for (const [key, value] of cloudflareHeaders) {
    headers.set(key, value);
  }
  return headers;
}

function buildAudioBlob(command: VoiceTranscribeCommand): Blob {
  const bytes = Buffer.from(command.audioBase64, "base64");
  return new Blob([bytes], {
    type: command.mimeType,
  });
}

function buildTranscriptionFormData(command: VoiceTranscribeCommand): FormData {
  const formData = new FormData();
  formData.set("file", buildAudioBlob(command), command.filename);
  formData.set("model", command.model);
  if (command.hint !== null) {
    formData.set("prompt", command.hint);
  }
  return formData;
}

function parseTranscriptionText(value: JsonValue): string {
  const object = toJsonObject(value);
  const text = object ? optionalString(object.text) : null;
  if (text === null) {
    throw new AiServiceFailure(
      "invalid_response",
      "dictation_response_invalid",
      "Codex transcription response did not include transcript text.",
    );
  }
  return text;
}

function parseTranscriptionResponse(rawText: string): JsonValue {
  try {
    return parseJsonValue(rawText);
  } catch {
    throw new AiServiceFailure(
      "invalid_response",
      "dictation_response_invalid",
      "Codex transcription response was not valid JSON.",
    );
  }
}

async function fetchChatGptTranscription(
  args: ChatGptTranscriptionFetchArgs,
): Promise<Response> {
  return runWithTimeout({
    deadline: args.deadline,
    work: (signal) =>
      fetchChatGpt({
        url: CHATGPT_TRANSCRIBE_URL,
        init: (headers) => ({
          method: "POST",
          headers: createChatGptTranscriptionHeaders(args.auth, headers),
          body: buildTranscriptionFormData(args.command),
          signal,
        }),
      }),
  });
}

export async function transcribeCodexVoice(
  command: VoiceTranscribeCommand,
  signal: AbortSignal,
): Promise<string> {
  const deadline = createCodexRequestDeadline(command.timeoutMs, signal);
  const auth = await readCodexAuthCredentials();
  const response = await fetchChatGptTranscription({ auth, command, deadline });

  if (!response.ok) {
    throw await createCodexHttpError({
      deadline,
      operation: "transcription",
      response,
    });
  }

  const responseText = await readLimitedResponseText(response, {
    deadline,
    maxBytes: CODEX_TRANSCRIPTION_RESPONSE_MAX_BYTES,
    overflowBehavior: "throw",
  });

  return parseTranscriptionText(parseTranscriptionResponse(responseText));
}

function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  return (
    Math.max(
      0,
      Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(value) - Date.now(),
    ) || 0
  );
}
