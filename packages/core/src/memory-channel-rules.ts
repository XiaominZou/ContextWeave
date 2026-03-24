import type {
  MemoryChannel,
  MemoryKindV1_1,
  MemoryRecordDraftV1_1,
  MemoryScopeV1_1,
} from "./memory-provider";

export interface MemoryChannelRule {
  defaultChannel: MemoryChannel;
}

export const DEFAULT_CHANNEL_RULES: Record<MemoryKindV1_1, MemoryChannelRule> = {
  fact: { defaultChannel: "collection" },
  preference: { defaultChannel: "profile" },
  procedure: { defaultChannel: "collection" },
  constraint: { defaultChannel: "collection" },
  insight: { defaultChannel: "collection" },
  decision: { defaultChannel: "collection" },
};

export function resolveDefaultMemoryChannel(kind: MemoryKindV1_1): MemoryChannel {
  return DEFAULT_CHANNEL_RULES[kind].defaultChannel;
}

export function isStableProfileScope(scope: MemoryScopeV1_1): boolean {
  return scope === "user" || scope === "workspace" || scope === "global";
}

export function validateMemoryChannelPolicy(record: MemoryRecordDraftV1_1): void {
  if (record.channel !== "profile") {
    return;
  }

  if (!isStableProfileScope(record.scope)) {
    throw createMemoryValidationError(
      "INVALID_MEMORY_WRITE",
      "profile channel requires user/workspace/global scope",
    );
  }

  if (record.layer !== "long_term" && record.confirmedBy !== "user") {
    throw createMemoryValidationError(
      "INVALID_MEMORY_WRITE",
      "profile channel requires user confirmation unless writing long_term memory",
    );
  }
}

function createMemoryValidationError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
