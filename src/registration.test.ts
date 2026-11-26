import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server.js";
it("offers four voice services and keeps the API key as the only secret setting", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ data: { limit_remaining: null } }));
  const { bb, harness } = createFakePluginHost({
    pluginId: "dictation",
    experimental_hostEntry: false,
  });
  plugin(bb);
  expect(
    harness.registrations.aiServiceRegistrations.map(
      ({ id, displayName, complete }) => ({ id, displayName, complete }),
    ),
  ).toEqual([
    {
      id: "openrouter",
      displayName: "OpenRouter dictation",
      complete: undefined,
    },
    {
      id: "chatgpt",
      displayName: "ChatGPT subscription dictation",
      complete: undefined,
    },
    {
      id: "whisper",
      displayName: "Local Whisper dictation",
      complete: undefined,
    },
    {
      id: "x-gemini",
      displayName: "Gemini dictation (Antigravity CLI)",
      complete: undefined,
    },
  ]);
  const service = harness.registrations.aiServiceRegistrations[0];
  expect(await service.status!()).toEqual({
    ready: false,
    message: "Set the OpenRouter API key in Dictation settings.",
  });
  await harness.setSettings({ openrouterApiKey: "test-key" });
  expect(await service.status!()).toEqual({ ready: true });
  expect(Object.keys(harness.registrations.settingsDescriptors)).toEqual([
    "openrouterApiKey",
    "editTranscripts",
    "editModel",
    "whisperLanguage",
    "lexicon",
    "editInstructions",
    "saveHistory",
  ]);
  expect(harness.registrations.cli?.name).toBe("dictation");
  expect(
    Object.entries(harness.registrations.settingsDescriptors)
      .filter(([, descriptor]) => "secret" in descriptor && descriptor.secret)
      .map(([key]) => key),
  ).toEqual(["openrouterApiKey"]);
  await harness.dispose();
  vi.unstubAllGlobals();
});
