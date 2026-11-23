import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readCodexAuthCredentials } from "./codex-auth.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => fs.rm(tempDir, { force: true, recursive: true })),
  );
});

it("reports a missing auth.json as codex_auth_missing and an unparsable one as codex_auth_invalid", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-codex-home-"));
  tempDirs.push(homeDir);
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("USERPROFILE", homeDir);
  vi.stubEnv("CODEX_HOME", "");

  await expect(readCodexAuthCredentials()).rejects.toMatchObject({
    code: "auth_required",
    detailCode: "dictation_auth_missing",
  });

  const codexHome = path.join(homeDir, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "auth.json"), "{not json");
  await expect(readCodexAuthCredentials()).rejects.toMatchObject({
    code: "auth_required",
    detailCode: "dictation_auth_invalid",
  });
});

it("reads ChatGPT credentials with the account id from the access token claims", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-codex-home-"));
  tempDirs.push(homeDir);
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("USERPROFILE", homeDir);
  vi.stubEnv("CODEX_HOME", "");
  const base64UrlJson = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = `${base64UrlJson({ alg: "none" })}.${base64UrlJson({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "codex@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-123",
      chatgpt_account_is_fedramp: true,
    },
  })}.sig`;
  const codexHome = path.join(homeDir, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: accessToken, refresh_token: "refresh" },
    }),
  );

  await expect(readCodexAuthCredentials()).resolves.toEqual({
    type: "chatgpt",
    accessToken,
    accountId: "account-123",
    accountEmail: "codex@example.com",
    expired: false,
    isFedrampAccount: true,
  });
});

it("rejects an expired ChatGPT token and reports not ready", async () => {
  const homeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "dictation-expired-"),
  );
  tempDirs.push(homeDir);
  vi.stubEnv("CODEX_HOME", homeDir);
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.sig`;
  await fs.writeFile(
    path.join(homeDir, "auth.json"),
    JSON.stringify({
      tokens: { access_token: token, account_id: "expired-account" },
    }),
  );
  await expect(readCodexAuthCredentials()).rejects.toMatchObject({
    detailCode: "dictation_auth_expired",
  });
  const { createEngines } = await import("../engines.js");
  expect(await createEngines(async () => undefined).chatgpt.status()).toEqual({
    ready: false,
    message: "Codex access token expired. Run codex login on this server.",
  });
});
it("rejects API-key auth rather than using the subscription service", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "dictation-apikey-"));
  tempDirs.push(homeDir);
  vi.stubEnv("CODEX_HOME", homeDir);
  await fs.writeFile(
    path.join(homeDir, "auth.json"),
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fake-test-key" }),
  );
  await expect(readCodexAuthCredentials()).rejects.toMatchObject({
    detailCode: "dictation_auth_invalid",
  });
});
