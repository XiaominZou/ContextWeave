import type {
  MemoryChannel,
  MemoryConfirmedBy,
  MemoryKindV1_1,
  MemoryLayer,
  MemoryNamespaceSlice,
  MemoryRecordDraftV1_1,
  MemoryRecordV1_1,
} from "./memory-provider";

export interface MemoryNamespaceAnchor {
  workspaceId: string;
  userId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
}

export interface MemorySearchQuery {
  anchor: MemoryNamespaceAnchor;
  queryText: string;
  layer?: MemoryLayer;
  channel?: MemoryChannel;
  kind?: MemoryKindV1_1[];
  maxResults?: number;
}

export interface MemorySearchHit {
  record: MemoryRecordV1_1;
  finalScore: number;
}

export interface MemorySearchResult {
  hits: MemorySearchHit[];
  namespacesSearched: MemoryNamespaceSlice[];
}

export interface WriteExperienceInput {
  record: MemoryRecordDraftV1_1;
}

export interface WriteConfirmedInput {
  record: MemoryRecordDraftV1_1 & {
    confirmedBy: MemoryConfirmedBy;
  };
}

export interface ConsolidateTaskInput {
  workspaceId: string;
  taskId: string;
  sessionId?: string;
  userId?: string;
  maxCandidates?: number;
}

export interface PromoteMemoryInput {
  memoryId: string;
  workspaceId: string;
  targetScope?: MemoryRecordV1_1["scope"];
  targetChannel?: MemoryChannel;
}

export type PromotionAction =
  | "PROMOTE_NEW"
  | "PROMOTE_UPDATE"
  | "PROMOTE_INVALIDATE"
  | "PROMOTE_ARCHIVE"
  | "ADD_CANDIDATE"
  | "NONE";

export interface PromotionResult {
  memoryId: string;
  action: PromotionAction;
  targetId?: string;
  resultRecordId?: string;
  admissionScore?: number;
  reason?: string;
}

export interface MemoryEngine {
  search(query: MemorySearchQuery): Promise<MemorySearchResult>;
  writeExperience(input: WriteExperienceInput): Promise<MemoryRecordV1_1>;
  writeConfirmed(input: WriteConfirmedInput): Promise<MemoryRecordV1_1>;
  consolidateTask(input: ConsolidateTaskInput): Promise<PromotionResult[]>;
  promote(input: PromoteMemoryInput): Promise<PromotionResult>;
}
