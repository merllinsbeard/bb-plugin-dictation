import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createDictationHistory,
  HISTORY_MIGRATIONS,
  type SqliteDatabase,
} from "./history.js";

function openMemoryHistory() {
  const db = new DatabaseSync(":memory:");
  for (const sql of HISTORY_MIGRATIONS) {
    db.exec(sql);
  }
  return createDictationHistory(() => db as unknown as SqliteDatabase);
}

describe("DictationHistory (SQLite)", () => {
  it("records raw transcript immediately and updates edited text after LLM pass", () => {
    const history = openMemoryHistory();
    const id = history.recordTranscribed({
      serviceId: "chatgpt",
      durationSec: 12.4,
      elapsedMs: 1850,
      audioBytes: 24000,
      mimeType: "audio/mp4",
      parts: 1,
      rawText: "эээ сделай авторетрай в бб",
      createdAt: "2026-11-23T15:00:00.000Z",
    });

    const beforeEdit = history.get(id);
    expect(beforeEdit).toMatchObject({
      id,
      serviceId: "chatgpt",
      status: "ok",
      rawText: "эээ сделай авторетрай в бб",
      editedText: "эээ сделай авторетрай в бб",
      editModel: null,
    });

    history.updateEdited({
      id,
      editedText: "Сделай авторетрай в bb.",
      editModel: "openai/gpt-6.1-terra",
      elapsedMs: 3200,
    });

    const afterEdit = history.get(id);
    expect(afterEdit).toMatchObject({
      rawText: "эээ сделай авторетрай в бб",
      editedText: "Сделай авторетрай в bb.",
      editModel: "openai/gpt-6.1-terra",
      elapsedMs: 3200,
    });
  });

  it("supports Unicode/Cyrillic case-insensitive search across raw and edited text", () => {
    const history = openMemoryHistory();
    history.recordTranscribed({
      serviceId: "chatgpt",
      durationSec: 5,
      elapsedMs: 900,
      audioBytes: 5000,
      mimeType: "audio/webm",
      parts: 1,
      rawText: "Привет, проверь OpenViking и Гермес",
      createdAt: "2026-11-23T15:01:00.000Z",
    });
    const id2 = history.recordTranscribed({
      serviceId: "openrouter",
      durationSec: 8,
      elapsedMs: 1100,
      audioBytes: 8000,
      mimeType: "audio/webm",
      parts: 1,
      rawText: "сохрани диктовки в скулайт",
      createdAt: "2026-11-23T15:02:00.000Z",
    });
    history.updateEdited({
      id: id2,
      editedText: "Сохрани диктовки в SQLite.",
      editModel: "openai/gpt-6.1-terra",
      elapsedMs: 2100,
    });

    expect(history.search("ГЕРМЕС")).toHaveLength(1);
    expect(history.search("скулайт").map((r) => r.id)).toEqual([id2]);
    expect(history.search("sqlite").map((r) => r.id)).toEqual([id2]);
  });

  it("filters list by date, service, and failure status, and computes stats", () => {
    const history = openMemoryHistory();
    history.recordTranscribed({
      serviceId: "openrouter",
      durationSec: 60,
      elapsedMs: 2000,
      audioBytes: 10000,
      mimeType: "audio/mp4",
      parts: 1,
      rawText: "Первая запись",
      createdAt: "2026-11-22T10:00:00.000Z",
    });
    history.recordFailure({
      serviceId: "chatgpt",
      elapsedMs: 4000,
      audioBytes: 12000,
      mimeType: "audio/mp4",
      errorMessage: "HTTP 503",
      createdAt: "2026-11-23T11:00:00.000Z",
    });

    expect(history.list()).toHaveLength(1);
    expect(history.list({ includeFailed: true })).toHaveLength(2);
    expect(history.list({ since: "2026-11-23", includeFailed: true })).toHaveLength(1);
    expect(history.list({ serviceId: "openrouter" })).toHaveLength(1);
    expect(history.stats()).toEqual({
      total: 2,
      ok: 1,
      failed: 1,
      totalDurationSec: 60,
      totalChars: "Первая запись".length,
    });
  });
});
