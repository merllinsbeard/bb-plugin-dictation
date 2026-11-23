export const FAILED_RECORDING_SELECTOR =
  '[data-promptbox-failed-voice-recordings] [role="group"][aria-label="Voice input failed"]';

export const DEFAULT_RETRY_DELAYS_MS = [1500, 4000, 10000] as const;
export const DEFAULT_RESUME_DELAY_MS = 500;

const PERMANENT_ERROR_PATTERNS = [
  /\bHTTP 40[12]\b/i,
  /\b(?:api key|balance is too low|not configured|turned off|not loaded|auth_required)\b/i,
  /\b(?:too large|exceeds \d+\s*mb|must not be empty|empty result|too short|no audio)\b/i,
  /\b(?:microphone|permission denied|not supported|insecure|not found|already in use)\b/i,
];

export function isRetryableVoiceError(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return true;
  return !PERMANENT_ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface RetryButtonLike {
  textContent: string | null;
  disabled: boolean;
  click(): void;
}

export interface FailedGroupLike {
  isConnected: boolean;
  textContent: string | null;
  querySelector(selector: string): { textContent: string | null } | null;
  querySelectorAll(selector: string): Iterable<RetryButtonLike>;
}

export interface AutoRetryEnv<TimerId = ReturnType<typeof setTimeout>> {
  queryFailedGroups(): Iterable<FailedGroupLike>;
  isVisible(): boolean;
  isOnline(): boolean;
  setTimer(fn: () => void, ms: number): TimerId;
  clearTimer(id: TimerId): void;
  delaysMs?: readonly number[];
  resumeDelayMs?: number;
}

interface Entry<TimerId> {
  attempts: number;
  timer: TimerId | null;
  waitingForReady: boolean;
}

function findRetryButton(group: FailedGroupLike): RetryButtonLike | null {
  for (const button of group.querySelectorAll("button")) {
    const label = button.textContent?.trim();
    if (label === "Retry" || label === "Retrying…") return button;
  }
  return null;
}

function readErrorText(group: FailedGroupLike): string {
  return (group.querySelector("p")?.textContent ?? group.textContent ?? "").trim();
}

export function createAutoRetryController<TimerId>(env: AutoRetryEnv<TimerId>) {
  const delaysMs = env.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const resumeDelayMs = env.resumeDelayMs ?? DEFAULT_RESUME_DELAY_MS;
  const entries = new Map<FailedGroupLike, Entry<TimerId>>();
  let disposed = false;

  const clearEntryTimer = (entry: Entry<TimerId>) => {
    if (entry.timer !== null) {
      env.clearTimer(entry.timer);
      entry.timer = null;
    }
  };

  const isReady = () => env.isVisible() && env.isOnline();

  const scan = () => {
    if (disposed) return;

    const active = new Set<FailedGroupLike>();
    for (const group of env.queryFailedGroups()) {
      if (group.isConnected) active.add(group);
    }

    for (const [group, entry] of entries) {
      if (!active.has(group) || !group.isConnected) {
        clearEntryTimer(entry);
        entries.delete(group);
      }
    }

    for (const group of active) {
      const button = findRetryButton(group);
      if (!button) continue;

      let entry = entries.get(group);
      if (!entry) {
        entry = { attempts: 0, timer: null, waitingForReady: false };
        entries.set(group, entry);
      }

      const label = button.textContent?.trim();
      if (button.disabled || label !== "Retry") {
        clearEntryTimer(entry);
        entry.waitingForReady = false;
        continue;
      }

      if (entry.attempts >= delaysMs.length) continue;

      if (!isRetryableVoiceError(readErrorText(group))) {
        clearEntryTimer(entry);
        entry.waitingForReady = false;
        continue;
      }

      if (!isReady()) {
        clearEntryTimer(entry);
        entry.waitingForReady = true;
        continue;
      }

      if (entry.timer !== null) continue;

      const waitMs = entry.waitingForReady
        ? resumeDelayMs
        : delaysMs[entry.attempts];
      entry.waitingForReady = false;
      const targetEntry = entry;
      targetEntry.timer = env.setTimer(() => {
        targetEntry.timer = null;
        if (disposed || !group.isConnected) {
          entries.delete(group);
          return;
        }
        const currentButton = findRetryButton(group);
        if (
          !currentButton ||
          currentButton.disabled ||
          currentButton.textContent?.trim() !== "Retry"
        ) {
          return;
        }
        if (!isRetryableVoiceError(readErrorText(group))) return;
        if (!isReady()) {
          targetEntry.waitingForReady = true;
          return;
        }
        targetEntry.attempts += 1;
        currentButton.click();
      }, waitMs);
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const entry of entries.values()) clearEntryTimer(entry);
    entries.clear();
  };

  return {
    scan,
    dispose,
    trackedCount: () => entries.size,
  };
}
