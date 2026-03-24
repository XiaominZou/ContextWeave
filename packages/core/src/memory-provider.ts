export type MemoryScopeV1_1 = "run" | "task" | "session" | "user" | "workspace" | "global";

export type MemoryLayer = "experience" | "long_term";

export type MemoryChannel = "profile" | "collection";

export type MemoryStatus = "active" | "candidate" | "invalidated" | "archived" | "expired";

export type MemoryKindV1_1 =
  | "fact"
  | "preference"
  | "procedure"
  | "constraint"
  | "insight"
  | "decision";

export type MemoryConfirmedBy = "system" | "user";

export interface MemorySourceRefV1_1 {
  type: "event" | "run" | "task" | "artifact" | "tool_call" | "message";
  id: string;
}

export type MemoryOwnerRefV1_1 =
  | { type: "run"; id: string }
  | { type: "task"; id: string }
  | { type: "session"; id: string }
  | { type: "user"; id: string }
  | { type: "workspace"; id: string }
  | { type: "global"; id: "global" };

export interface MemoryRecordDraftV1_1 {
  workspaceId: string;
  userId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  ownerRef: MemoryOwnerRefV1_1;
  scope: MemoryScopeV1_1;
  layer: MemoryLayer;
  channel: MemoryChannel;
  kind: MemoryKindV1_1;
  status?: MemoryStatus;
  title: string;
  content: string;
  summary?: string;
  importance?: number;
  confidence?: number;
  keywords?: string[];
  sourceRefs?: MemorySourceRefV1_1[];
  confirmedBy?: MemoryConfirmedBy;
  expiresAt?: string;
}

export interface MemoryRecordV1_1 extends MemoryRecordDraftV1_1 {
  id: string;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  promotedFrom?: string;
  invalidatedBy?: string;
  replacedBy?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface MemoryRecordPatchV1_1 {
  scope?: MemoryScopeV1_1;
  layer?: MemoryLayer;
  channel?: MemoryChannel;
  kind?: MemoryKindV1_1;
  status?: MemoryStatus;
  title?: string;
  content?: string;
  summary?: string;
  importance?: number;
  confidence?: number;
  keywords?: string[];
  sourceRefs?: MemorySourceRefV1_1[];
  confirmedBy?: MemoryConfirmedBy;
  expiresAt?: string;
  promotedFrom?: string;
  invalidatedBy?: string;
  replacedBy?: string;
  version?: number;
  archivedAt?: string;
}

export interface MemoryNamespaceSlice {
  scope: MemoryScopeV1_1;
  ownerId: string;
}

export interface ProviderSearchInput {
  workspaceId: string;
  namespaces: MemoryNamespaceSlice[];
  queryText?: string;
  queryEmbedding?: number[];
  layer?: MemoryLayer;
  channel?: MemoryChannel;
  kind?: MemoryKindV1_1[];
  status?: MemoryStatus[];
  limit: number;
}

export interface ProviderSearchHit {
  record: MemoryRecordV1_1;
  vectorScore?: number;
}

export interface MemoryProvider {
  get(id: string): Promise<MemoryRecordV1_1 | null>;
  search(input: ProviderSearchInput): Promise<ProviderSearchHit[]>;
  put(record: MemoryRecordDraftV1_1): Promise<MemoryRecordV1_1>;
  update(id: string, patch: MemoryRecordPatchV1_1): Promise<MemoryRecordV1_1>;
  archive(id: string, opts?: { replacedBy?: string; reason?: string }): Promise<void>;
  invalidate(id: string, opts?: { invalidatedBy?: string; reason?: string }): Promise<void>;
  delete(id: string): Promise<void>;
}

// Backward-compatible aliases. MemoryRecordV1_1 is now the canonical model.
export type MemoryScope = MemoryScopeV1_1;
export type MemoryLayerV1 = MemoryLayer;
export type MemoryChannelV1 = MemoryChannel;
export type MemoryStatusV1 = MemoryStatus;
export type MemoryKind = MemoryKindV1_1;
export type MemoryOwnerRef = MemoryOwnerRefV1_1;
export type MemorySourceRef = MemorySourceRefV1_1;
export type MemoryRecordDraft = MemoryRecordDraftV1_1;
export type MemoryRecord = MemoryRecordV1_1;
export type MemoryRecordPatch = MemoryRecordPatchV1_1;

