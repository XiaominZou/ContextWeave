export type PlatformErrorCode =
  | "NOT_ENABLED"
  | "POLICY_CONFLICT"
  | "CAPABILITY_NOT_SUPPORTED"
  | "BUDGET_EXCEEDED"
  | "ADAPTER_UNAVAILABLE"
  | "MEMORY_EXTRACTION_FAILED"
  | "CHECKPOINT_INVALID";

export interface SerializedError {
  code: string;
  message: string;
  details?: unknown;
  retriable?: boolean;
}

export interface PlatformError extends SerializedError {
  code: PlatformErrorCode | string;
}
