import { definePluginApp } from "@get-bb/plugin-sdk/app";
import {
  createAutoRetryController,
  FAILED_RECORDING_SELECTOR,
} from "./src/auto-retry.js";

function mount({ signal }: { signal: AbortSignal }) {
  const controller = createAutoRetryController({
    queryFailedGroups: () =>
      document.querySelectorAll<HTMLElement>(FAILED_RECORDING_SELECTOR),
    isVisible: () => document.visibilityState === "visible",
    isOnline: () => navigator.onLine !== false,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
  });

  let scheduled = false;
  const scheduleScan = () => {
    if (scheduled || signal.aborted) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!signal.aborted) controller.scan();
    });
  };

  const observer = new MutationObserver(() => {
    if (
      controller.trackedCount() === 0 &&
      document.querySelector(FAILED_RECORDING_SELECTOR) === null
    ) {
      return;
    }
    scheduleScan();
  });

  const root = document.body ?? document.documentElement;
  if (root) {
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
  }

  const opts = { signal };
  document.addEventListener("visibilitychange", scheduleScan, opts);
  window.addEventListener("online", scheduleScan, opts);
  window.addEventListener("offline", scheduleScan, opts);

  const cleanup = () => {
    observer.disconnect();
    controller.dispose();
  };
  signal.addEventListener("abort", cleanup, { once: true });

  controller.scan();
  return cleanup;
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "dictation-auto-retry", mount });
});
