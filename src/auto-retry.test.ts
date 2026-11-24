import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutoRetryController,
  isRetryableVoiceError,
  type FailedGroupLike,
  type RetryButtonLike,
} from "./auto-retry.js";

function makeGroup(errorMessage: string, opts?: { disabled?: boolean; label?: string }) {
  let clicks = 0;
  const button: RetryButtonLike = {
    textContent: opts?.label ?? "Retry",
    disabled: opts?.disabled ?? false,
    click() {
      clicks++;
      button.disabled = true;
      button.textContent = "Retrying…";
    },
  };
  const group: FailedGroupLike = {
    isConnected: true,
    textContent: `Voice input failed · ${errorMessage}`,
    querySelector: (selector) =>
      selector === "p"
        ? { textContent: `Voice input failed · ${errorMessage}` }
        : null,
    querySelectorAll: (selector) => (selector === "button" ? [button] : []),
  };
  return {
    group,
    button,
    get clicks() {
      return clicks;
    },
    failAgain() {
      button.disabled = false;
      button.textContent = "Retry";
    },
  };
}

describe("isRetryableVoiceError", () => {
  it("retries transient network, timeout, and dropped-connection errors", () => {
    expect(isRetryableVoiceError("Voice input failed · Transcription did not finish")).toBe(true);
    expect(isRetryableVoiceError("Voice input failed · Load failed")).toBe(true);
    expect(isRetryableVoiceError("Voice input failed · Failed to fetch")).toBe(true);
    expect(isRetryableVoiceError("Voice input failed · Voice transcription timed out")).toBe(true);
    expect(isRetryableVoiceError("Voice input failed · HTTP 503: service unavailable")).toBe(true);
    expect(isRetryableVoiceError("Voice input failed · Cloudflare challenge")).toBe(true);
  });

  it("does not retry permanent auth, balance, size, or microphone errors", () => {
    expect(
      isRetryableVoiceError(
        "Voice input failed · OpenRouter transcription failed with HTTP 402: balance is too low",
      ),
    ).toBe(false);
    expect(
      isRetryableVoiceError(
        "Voice input failed · OpenRouter rejected the API key. Update it in Dictation settings.",
      ),
    ).toBe(false);
    expect(isRetryableVoiceError("Voice input failed · Audio file exceeds 25MB limit")).toBe(false);
    expect(isRetryableVoiceError("Voice input failed · Microphone permission denied")).toBe(false);
    expect(isRetryableVoiceError("Voice input failed · Turned off in Settings")).toBe(false);
  });

  it("does not retry a recording that ffmpeg or the provider cannot decode", () => {
    // Banner text for the 968 KB webm that failed on 2026-11-24 (data.db rows 10-19).
    expect(
      isRetryableVoiceError(
        "Voice input failed · OpenRouter: ffmpeg failed (1): /tmp/dictation-MqRoNW/recording: Invalid data found when processing input",
      ),
    ).toBe(false);
    expect(
      isRetryableVoiceError(
        "Voice input failed · OpenRouter: OpenRouter transcription failed with HTTP 400: Audio file might be corrupted or unsupported",
      ),
    ).toBe(false);
  });

  it("still retries ffmpeg when it was killed rather than rejecting the file", () => {
    expect(isRetryableVoiceError("Voice input failed · OpenRouter: ffmpeg failed (null): ")).toBe(true);
  });
});

describe("createAutoRetryController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-retries up to 3 times with backoff and then stops", () => {
    const item = makeGroup("Load failed");
    const groups = [item.group];
    const ctrl = createAutoRetryController({
      queryFailedGroups: () => groups,
      isVisible: () => true,
      isOnline: () => true,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
    });

    ctrl.scan();
    vi.advanceTimersByTime(1499);
    expect(item.clicks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(item.clicks).toBe(1);

    // Fails again -> second retry after 4000ms
    item.failAgain();
    ctrl.scan();
    vi.advanceTimersByTime(3999);
    expect(item.clicks).toBe(1);
    vi.advanceTimersByTime(1);
    expect(item.clicks).toBe(2);

    // Fails again -> third retry after 10000ms
    item.failAgain();
    ctrl.scan();
    vi.advanceTimersByTime(10000);
    expect(item.clicks).toBe(3);

    // Exhausted -> leaves manual Retry alone
    item.failAgain();
    ctrl.scan();
    vi.advanceTimersByTime(60000);
    expect(item.clicks).toBe(3);

    ctrl.dispose();
  });

  it("waits until visible and online, then retries quickly on resume", () => {
    const item = makeGroup("Transcription did not finish");
    let visible = false;
    let online = true;
    const ctrl = createAutoRetryController({
      queryFailedGroups: () => [item.group],
      isVisible: () => visible,
      isOnline: () => online,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
    });

    ctrl.scan();
    vi.advanceTimersByTime(20000);
    expect(item.clicks).toBe(0);

    // Page returns to foreground -> resumes after 500ms
    visible = true;
    ctrl.scan();
    vi.advanceTimersByTime(499);
    expect(item.clicks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(item.clicks).toBe(1);

    // Goes offline before second retry -> waits until online
    item.failAgain();
    online = false;
    ctrl.scan();
    vi.advanceTimersByTime(20000);
    expect(item.clicks).toBe(1);

    online = true;
    ctrl.scan();
    vi.advanceTimersByTime(500);
    expect(item.clicks).toBe(2);

    ctrl.dispose();
  });

  it("skips permanent errors and cancels timers on discard or dispose", () => {
    const perm = makeGroup("OpenRouter transcription failed with HTTP 402: low balance");
    const transient = makeGroup("Failed to fetch");
    const groups = [perm.group, transient.group];
    const ctrl = createAutoRetryController({
      queryFailedGroups: () => groups,
      isVisible: () => true,
      isOnline: () => true,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id),
    });

    ctrl.scan();
    // User discards the transient recording before the timer fires
    transient.group.isConnected = false;
    ctrl.scan();
    vi.advanceTimersByTime(20000);

    expect(perm.clicks).toBe(0);
    expect(transient.clicks).toBe(0);

    ctrl.dispose();
  });
});
