import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonValue } from "@get-bb/plugin-sdk";
import type { JsonObject } from "@get-bb/plugin-sdk/provider-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeCodexVoice } from "./chatgpt-client.js";
import { resetChatGptCloudflareCookiesForTests } from "./chatgpt-fetch.js";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const tempDirs: string[] = [];

interface WriteCodexAuthArgs {
  homeDir: string;
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  openAiApiKey?: string;
}

interface CreateAccessTokenArgs {
  expSeconds: number;
  accountId: string;
}

async function makeTempHome(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-codex-auth-"));
  tempDirs.push(tempDir);
  vi.stubEnv("CODEX_HOME", path.join(tempDir, ".codex"));
  vi.stubEnv("HOME", tempDir);
  vi.stubEnv("USERPROFILE", tempDir);
  return tempDir;
}

function base64UrlJson(value: JsonValue): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createJwt(payload: JsonObject): string {
  return `${base64UrlJson({ alg: "none", typ: "JWT" })}.${base64UrlJson(payload)}.sig`;
}

async function writeCodexAuth(args: WriteCodexAuthArgs): Promise<string> {
  const authDir = path.join(args.homeDir, ".codex");
  await fs.mkdir(authDir, { recursive: true });
  const authPath = path.join(authDir, "auth.json");
  await fs.writeFile(
    authPath,
    `${JSON.stringify(
      {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: args.openAiApiKey,
        tokens: {
          access_token: args.accessToken,
          refresh_token: args.refreshToken,
          account_id: args.accountId,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return authPath;
}

function createAccessToken(args: CreateAccessTokenArgs): string {
  return createJwt({
    exp: args.expSeconds,
    "https://api.openai.com/auth": {
      chatgpt_account_id: args.accountId,
    },
  });
}

function setupFetchMock(): FetchMock {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requiredFetchCall(fetchMock: FetchMock, index: number) {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Missing fetch call at index ${index}`);
  }
  return call;
}

function headersFromInit(init: RequestInit | undefined): Headers {
  const headers = init?.headers;
  if (!(headers instanceof Headers)) {
    throw new Error("Expected request headers to be a Headers instance");
  }
  return headers;
}

function formDataBodyFromInit(init: RequestInit | undefined): FormData {
  const body = init?.body;
  if (!(body instanceof FormData)) {
    throw new Error("Expected request body to be FormData");
  }
  return body;
}

describe("Codex ChatGPT client", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetChatGptCloudflareCookiesForTests();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((tempDir) => fs.rm(tempDir, { force: true, recursive: true })),
    );
  });

  it("retries ChatGPT transcription once with allowed Cloudflare cookies", async () => {
    const homeDir = await makeTempHome();
    const accessToken = createAccessToken({
      accountId: "account-123",
      expSeconds: Math.floor(Date.now() / 1000) + 3600,
    });
    await writeCodexAuth({
      homeDir,
      accessToken,
      refreshToken: "refresh-token",
    });
    const fetchMock = setupFetchMock();
    fetchMock
      .mockResolvedValueOnce(
        new Response("challenge", {
          status: 403,
          headers: {
            "cf-mitigated": "challenge",
            "set-cookie": "__cf_bm=cloudflare-cookie; Path=/; Secure; HttpOnly",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "hello world" }), {
          status: 200,
        }),
      );

    const result = await transcribeCodexVoice(
      {
        model: "gpt-transcribe",
        audioBase64: Buffer.from("audio").toString("base64"),
        mimeType: "audio/webm",
        filename: "prompt.webm",
        hint: null,
        timeoutMs: 30000,
      },
      new AbortController().signal,
    );

    expect(result).toBe("hello world");
    const [, retryInit] = requiredFetchCall(fetchMock, 1);
    const retryHeaders = headersFromInit(retryInit);
    expect(retryHeaders.get("cookie")).toBe("__cf_bm=cloudflare-cookie");
    expect(retryHeaders.get("authorization")).toBe(`Bearer ${accessToken}`);
    const form = formDataBodyFromInit(retryInit);
    expect(form.get("model")).toBe("gpt-transcribe");
    const file = form.get("file") as File;
    expect(file.name).toBe("prompt.webm");
    expect(file.type).toBe("audio/webm");
    expect(await file.text()).toBe("audio");
  });

  it("classifies a persistent Cloudflare challenge as transient without leaking the challenge page", async () => {
    const homeDir = await makeTempHome();
    const accessToken = createAccessToken({
      accountId: "account-123",
      expSeconds: Math.floor(Date.now() / 1000) + 3600,
    });
    await writeCodexAuth({
      homeDir,
      accessToken,
      refreshToken: "refresh-token",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockImplementation(
      async () =>
        new Response(
          `<html>\n<head>\n<meta name="viewport" content="width=device-width" />\n<title>Just a moment...</title>\n<style>body{font-family:Arial}</style>\n</head><body>${"x".repeat(2000)}</body></html>`,
          {
            status: 403,
            headers: {
              "content-type": "text/html; charset=UTF-8",
              "cf-mitigated": "challenge",
              server: "cloudflare",
              "set-cookie":
                "__cf_bm=cloudflare-cookie; Path=/; Secure; HttpOnly",
            },
          },
        ),
    );

    let thrown: Error | null = null;
    try {
      await transcribeCodexVoice(
        {
          model: "gpt-transcribe",
          audioBase64: Buffer.from("audio").toString("base64"),
          mimeType: "audio/webm",
          filename: "prompt.webm",
          hint: null,
          timeoutMs: 30000,
        },
        new AbortController().signal,
      );
    } catch (error) {
      if (!(error instanceof Error)) {
        throw new Error("Expected Error from challenged transcription");
      }
      thrown = error;
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(thrown).toMatchObject({
      detailCode: "dictation_service_unavailable",
      message:
        "Codex transcription request failed with HTTP 403: chatgpt.com answered with a Cloudflare challenge that bb cannot solve. Retry, or choose another service in Settings → AI services.",
    });
  });

  it("omits HTML error pages from Codex error messages", async () => {
    const homeDir = await makeTempHome();
    const accessToken = createAccessToken({
      accountId: "account-123",
      expSeconds: Math.floor(Date.now() / 1000) + 3600,
    });
    await writeCodexAuth({
      homeDir,
      accessToken,
      refreshToken: "refresh-token",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response("<html><body>Access denied (error 1020)</body></html>", {
        status: 403,
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
    );

    await expect(
      transcribeCodexVoice(
        {
          model: "gpt-transcribe",
          audioBase64: Buffer.from("audio").toString("base64"),
          mimeType: "audio/webm",
          filename: "prompt.webm",
          hint: null,
          timeoutMs: 30000,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      detailCode: "dictation_request_failed",
      message: "Codex transcription request failed with HTTP 403",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports ChatGPT transcription rate limits with the nested provider message", async () => {
    const homeDir = await makeTempHome();
    const accessToken = createAccessToken({
      accountId: "account-123",
      expSeconds: Math.floor(Date.now() / 1000) + 3600,
    });
    await writeCodexAuth({
      homeDir,
      accessToken,
      refreshToken: "refresh-token",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          detail: {
            detail:
              "Transcription is temporarily unavailable. Please try again later.",
          },
        }),
        {
          status: 429,
        },
      ),
    );

    await expect(
      transcribeCodexVoice(
        {
          model: "gpt-transcribe",
          audioBase64: Buffer.from("audio").toString("base64"),
          mimeType: "audio/webm",
          filename: "prompt.webm",
          hint: null,
          timeoutMs: 30000,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      detailCode: "dictation_rate_limited",
      message:
        "Codex transcription request failed with HTTP 429: Transcription is temporarily unavailable. Please try again later.",
    });
  });

  it("rejects oversized Codex transcription responses", async () => {
    const homeDir = await makeTempHome();
    await writeCodexAuth({
      homeDir,
      accessToken: createAccessToken({
        accountId: "account-123",
        expSeconds: Math.floor(Date.now() / 1000) + 3600,
      }),
      refreshToken: "refresh",
    });
    const fetchMock = setupFetchMock();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          text: "x".repeat(1024 * 1024),
        }),
        {
          status: 200,
        },
      ),
    );

    await expect(
      transcribeCodexVoice(
        {
          model: "gpt-transcribe",
          audioBase64: Buffer.from("audio").toString("base64"),
          mimeType: "audio/webm",
          filename: "prompt.webm",
          hint: null,
          timeoutMs: 30000,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      detailCode: "dictation_response_too_large",
    });
  });
  it.each(["timeout", "abort"])(
    "cancels a stalled transcription body on %s",
    async (mode) => {
      const homeDir = await makeTempHome();
      await writeCodexAuth({
        homeDir,
        accessToken: createAccessToken({
          accountId: "account-123",
          expSeconds: Math.floor(Date.now() / 1000) + 3600,
        }),
        refreshToken: "refresh",
      });
      let canceled = false;
      const controller = new AbortController();
      setupFetchMock().mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              if (mode === "abort")
                setTimeout(
                  () =>
                    controller.abort(
                      new Error("Dictation exceeded 64-second budget"),
                    ),
                  20,
                );
            },
            cancel() {
              canceled = true;
            },
          }),
        ),
      );
      await expect(
        transcribeCodexVoice(
          {
            model: "gpt-transcribe",
            audioBase64: "YXVkaW8=",
            mimeType: "audio/webm",
            filename: "prompt.webm",
            hint: null,
            timeoutMs: mode === "timeout" ? 30 : 1000,
          },
          controller.signal,
        ),
      ).rejects.toMatchObject(
        mode === "timeout"
          ? { detailCode: "dictation_request_timeout" }
          : { message: "Dictation exceeded 64-second budget" },
      );
      expect(canceled).toBe(true);
    },
  );
  it("treats HTTP 408 as a retryable timeout", async () => {
    const homeDir = await makeTempHome();
    await writeCodexAuth({
      homeDir,
      accessToken: createAccessToken({
        accountId: "account-123",
        expSeconds: Math.floor(Date.now() / 1000) + 3600,
      }),
      refreshToken: "refresh",
    });
    setupFetchMock().mockResolvedValueOnce(new Response("", { status: 408 }));
    await expect(
      transcribeCodexVoice(
        {
          model: "gpt-transcribe",
          audioBase64: "YXVkaW8=",
          mimeType: "audio/webm",
          filename: "prompt.webm",
          hint: null,
          timeoutMs: 1000,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
  });
});
