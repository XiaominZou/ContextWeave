import type {
  MemoryOwnerRefV1_1,
  MemoryRecordDraftV1_1,
  MemoryScopeV1_1,
} from "./memory-provider";
import type { WriteConfirmedInput, WriteExperienceInput } from "./memory-engine";
import { validateMemoryChannelPolicy } from "./memory-channel-rules";

function createMemoryValidationError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function assertIdForScope(record: MemoryRecordDraftV1_1, scope: MemoryScopeV1_1): void {
  if (scope === "run" && !record.runId) {
    throw createMemoryValidationError("INVALID_MEMORY_WRITE", "run scope requires runId");
  }

  if (scope === "task" && !record.taskId) {
    throw createMemoryValidationError("INVALID_MEMORY_WRITE", "task scope requires taskId");
  }

  if (scope === "session" && !record.sessionId) {
    throw createMemoryValidationError("INVALID_MEMORY_WRITE", "session scope requires sessionId");
  }

  if (scope === "user" && !record.userId) {
    throw createMemoryValidationError("INVALID_MEMORY_WRITE", "user scope requires userId");
  }
}

function assertIdForOwner(record: MemoryRecordDraftV1_1, ownerRef: MemoryOwnerRefV1_1): void {
  if (ownerRef.type === "run" && record.runId !== ownerRef.id) {
    throw createMemoryValidationError("INVALID_MEMORY_WRITE", "ownerRef.type=run requires matching runId");
  }

  if (ownerRef.type === "task" && record.taskId !== ownerRef.id) {
    throw createMemoryValidationError("INVALID_MEMORY_WRITE", "ownerRef.type=task requires matching taskId");
  }

  if (ownerRef.type === "session" && record.sessionId !== ownerRef.id) {
    throw createMemoryValidationError("INVALID_MEMORY_WRITE", "ownerRef.type=session requires matching sessionId");
  }

  if (ownerRef.type === "user" && record.userId !== ownerRef.id) {
    throw createMemoryValidationError("INVALID_MEMORY_WRITE", "ownerRef.type=user requires matching userId");
  }

  if (ownerRef.type === "workspace" && record.workspaceId !== ownerRef.id) {
    throw createMemoryValidationError("INVALID_MEMORY_WRITE", "ownerRef.type=workspace requires matching workspaceId");
  }

  if (ownerRef.type === "global") {
    throw createMemoryValidationError("NOT_ENABLED", "global scope is reserved for future use");
  }
}

export function validateMemoryRecordDraftV1_1(record: MemoryRecordDraftV1_1): void {
  if (record.scope === "global") {
    throw createMemoryValidationError("NOT_ENABLED", "global scope is reserved for future use");
  }

  assertIdForScope(record, record.scope);
  assertIdForOwner(record, record.ownerRef);
  validateMemoryChannelPolicy(record);
}

export function validateWriteExperienceInput(input: WriteExperienceInput): void {
  validateMemoryRecordDraftV1_1(input.record);
}

export function validateWriteConfirmedInput(input: WriteConfirmedInput): void {
  validateMemoryRecordDraftV1_1(input.record);

  if (!input.record.confirmedBy) {
    throw createMemoryValidationError("INVALID_MEMORY_WRITE", "confirmed writes require confirmedBy");
  }
}
