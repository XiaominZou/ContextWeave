import type {
  ConsolidateTaskInput,
  MemoryRecordDraftV1_1,
  MemoryRecordPatchV1_1,
  MemoryRecordV1_1,
  MemorySearchQuery,
  MemorySearchResult,
  PromoteMemoryInput,
  PromotionResult,
  WriteConfirmedInput,
  WriteExperienceInput,
} from "@ctx/core";
import type { MemoryAPI, MemoryBindings } from "../contracts";
import { throwPlatformError } from "./errors";

function requireProvider(bindings?: MemoryBindings) {
  const provider = bindings?.provider;
  if (!provider) {
    throwPlatformError("NOT_ENABLED", "memory provider is not configured");
  }
  return provider;
}

function requireEngine(bindings?: MemoryBindings) {
  const engine = bindings?.engine;
  if (!engine) {
    throwPlatformError("NOT_ENABLED", "memory engine is not configured");
  }
  return engine;
}

function requireRecord(record: MemoryRecordV1_1 | null, id: string): MemoryRecordV1_1 {
  if (record) {
    return record;
  }

  throwPlatformError("MEMORY_NOT_FOUND", `Memory not found: ${id}`);
}

export function createMemoryAPI(bindings?: MemoryBindings): MemoryAPI {
  return {
    async get(id: string): Promise<MemoryRecordV1_1> {
      return requireRecord(await requireProvider(bindings).get(id), id);
    },

    async put(input: MemoryRecordDraftV1_1): Promise<MemoryRecordV1_1> {
      return requireProvider(bindings).put(input);
    },

    async update(id: string, patch: MemoryRecordPatchV1_1): Promise<MemoryRecordV1_1> {
      return requireProvider(bindings).update(id, patch);
    },

    async search(query: MemorySearchQuery): Promise<MemorySearchResult> {
      return requireEngine(bindings).search(query);
    },

    async writeExperience(input: WriteExperienceInput): Promise<MemoryRecordV1_1> {
      return requireEngine(bindings).writeExperience(input);
    },

    async writeConfirmed(input: WriteConfirmedInput): Promise<MemoryRecordV1_1> {
      return requireEngine(bindings).writeConfirmed(input);
    },

    async consolidateTask(input: ConsolidateTaskInput): Promise<PromotionResult[]> {
      return requireEngine(bindings).consolidateTask(input);
    },

    async promote(input: PromoteMemoryInput): Promise<PromotionResult> {
      return requireEngine(bindings).promote(input);
    },

    async archive(id: string, opts?: { replacedBy?: string; reason?: string }): Promise<void> {
      return requireProvider(bindings).archive(id, opts);
    },

    async invalidate(id: string, opts?: { invalidatedBy?: string; reason?: string }): Promise<void> {
      return requireProvider(bindings).invalidate(id, opts);
    },

    async delete(id: string): Promise<void> {
      return requireProvider(bindings).delete(id);
    },
  };
}

