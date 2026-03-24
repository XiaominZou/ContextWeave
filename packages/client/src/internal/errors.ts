import type { Run } from "@ctx/core";

export function throwPlatformError(code: string, message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  throw error;
}

export function asSerializedError(error: unknown): Run["error"] {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string; details?: unknown; retriable?: boolean };
    return {
      code: withCode.code ?? "UNKNOWN_ERROR",
      message: error.message,
      details: withCode.details,
      retriable: withCode.retriable,
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: String(error),
  };
}

export function mustFind<T>(value: T | undefined, entity: string, id: string): T {
  if (typeof value !== "undefined") {
    return value;
  }

  const error = new Error(`${entity} not found: ${id}`) as Error & { code: string };
  error.code = `${entity.toUpperCase()}_NOT_FOUND`;
  throw error;
}

