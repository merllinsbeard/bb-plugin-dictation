import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_BLOCK_MS, createEngines } from "./engines.js";

const part = {
  bytes: new Uint8Array([1, 2, 3]),
  filename: "recording.webm",
  mimeType: "audio/webm",
  index: 0,
};
const options = () => ({
  hint: null,
  signal: new AbortController().signal,
  timeoutMs: 1000,
});
const engine = () => createEngines(async () => "stub-api-key").openrouter;

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouter engine with stub fetch test double", () => {
  it("returns the transcript and sends the transcription multipart request", async () => {
    const stubFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ text: "Полная расшифровка записи." }),
    );
    vi.stubGlobal("fetch", stubFetch);

    await expect(engine().transcribe(part, options())).resolves.toBe(
      "Полная расшифровка записи.",
    );
    const [url, request] = stubFetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(request?.method).toBe("POST");
    const form = request?.body as FormData;
    expect(form.get("model")).toBe("openai/gpt-transcribe");
    expect((form.get("file") as File).name).toBe("recording.webm");
  });

  it("includes the provider balance error and does not retry HTTP 402", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        {
          error: {
            message: "This request requires at least $0.50 in balance for audio",
            code: 402,
          },
        },
        { status: 402 },
      ),
    );
    await expect(engine().transcribe(part, options())).rejects.toMatchObject({
      message:
        "OpenRouter transcription failed with HTTP 402: This request requires at least $0.50 in balance for audio",
      retryable: false,
    });
  });

  it("preserves retry classification and Retry-After", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(null, { status: 503, headers: { "Retry-After": "2" } }),
    );
    await expect(engine().transcribe(part, options())).rejects.toMatchObject({
      message: "OpenRouter transcription failed with HTTP 503",
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it("reports the settings message when the key is missing", async () => {
    const missingKey = createEngines(async () => undefined).openrouter;
    expect(await missingKey.status()).toEqual({
      ready: false,
      message: "Set the OpenRouter API key in Dictation settings.",
    });
    await expect(missingKey.transcribe(part, options())).rejects.toMatchObject({
      message: "Set the OpenRouter API key in Dictation settings.",
      retryable: false,
    });
  });

  it("reports the per-request timeout", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: unknown, request: RequestInit) =>
        new Promise((_resolve, reject) => {
          request.signal!.addEventListener(
            "abort",
            () => reject(request.signal!.reason),
            { once: true },
          );
        }),
    );
    await expect(
      engine().transcribe(part, { ...options(), timeoutMs: 20 }),
    ).rejects.toMatchObject({
      message: "OpenRouter transcription timed out.",
      retryable: true,
    });
  });

  it("stops reading an oversized error body and preserves the HTTP failure", async () => {
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      async () => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(8192)));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 402 },
      ),
    );
    await expect(engine().transcribe(part, options())).rejects.toMatchObject({
      message: "OpenRouter transcription failed with HTTP 402",
      retryable: false,
    });
    expect(cancelled).toBe(true);
  });

  it("times out on a stalled error body even if cancellation never settles", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":'));
          },
          cancel() {
            return new Promise(() => {});
          },
        }),
        { status: 402 },
      ),
    );
    await expect(
      engine().transcribe(part, { ...options(), timeoutMs: 20 }),
    ).rejects.toMatchObject({
      message: "OpenRouter transcription timed out.",
      retryable: true,
    });
  });
  it("treats HTTP 408 as a retryable timeout", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 408 }));
    await expect(engine().transcribe(part, options())).rejects.toMatchObject({
      retryable: true,
    });
  });

  it.each([
    [401, "OpenRouter rejected the API key. Update it in Dictation settings."],
    [
      402,
      "OpenRouter balance is too low for audio. Top up the account; dictation retries in a few minutes.",
    ],
  ])(
    "reports not ready after HTTP %i until the key changes or time passes",
    async (status, message) => {
      let key = "first-key";
      const openrouter = createEngines(async () => key).openrouter;
      vi.stubGlobal("fetch", async () => new Response(null, { status }));
      await expect(openrouter.transcribe(part, options())).rejects.toThrow();
      expect(await openrouter.status()).toEqual({ ready: false, message });
      const now = performance.now();
      vi.spyOn(performance, "now").mockReturnValue(now + ACCOUNT_BLOCK_MS + 1);
      expect(await openrouter.status()).toEqual({ ready: true });
      vi.restoreAllMocks();
      await expect(openrouter.transcribe(part, options())).rejects.toThrow();
      key = "second-key";
      expect(await openrouter.status()).toEqual({ ready: true });
    },
  );

  it("becomes ready again after a successful request", async () => {
    const openrouter = engine();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 402 }));
    await expect(openrouter.transcribe(part, options())).rejects.toThrow();
    vi.stubGlobal("fetch", async () => Response.json({ text: "ok" }));
    await openrouter.transcribe(part, options());
    expect(await openrouter.status()).toEqual({ ready: true });
  });
});
