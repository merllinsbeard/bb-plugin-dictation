import type { PluginAiServiceStatus, PluginLogger } from "@get-bb/plugin-sdk";
export type Status = PluginAiServiceStatus;
export type AudioRange = { startSeconds: number; endSeconds: number };
export type AudioPart = {
  bytes: Uint8Array<ArrayBuffer>;
  filename: string;
  mimeType: string;
  index: number;
};
export type EngineError = {
  retryable: boolean;
  message: string;
  retryAfterMs?: number;
};
export type Engine = {
  transcribe(
    part: AudioPart,
    opts: { hint: string | null; signal: AbortSignal; timeoutMs: number },
  ): Promise<string>;
  status(): Promise<Status>;
  concurrency: number;
};
export type Logger = Pick<PluginLogger, "info" | "warn">;
