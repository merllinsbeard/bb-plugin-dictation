export type FailureCode =
  | "auth_required"
  | "rate_limited"
  | "service_unavailable"
  | "request_failed"
  | "timeout"
  | "invalid_response";
export class AiServiceFailure extends Error {
  retryAfterMs?: number;
  constructor(
    readonly code: FailureCode,
    readonly detailCode: string,
    message: string,
  ) {
    super(message);
    this.name = "DictationAiServiceFailure";
  }
  get retryable(): boolean {
    return ["rate_limited", "service_unavailable", "timeout"].includes(
      this.code,
    );
  }
}
