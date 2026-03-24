# Memory Engine SPI

## 1. Purpose

This document defines the V1.1 direction for:

- the `MemoryProvider` SPI
- the `MemoryEngine` strategy layer
- namespace-aware retrieval contracts
- provider vs engine search result responsibilities
- V1.1 runtime guards for reserved features such as `global` scope

This document should be read together with:
- `docs/memory-namespace-and-record-model.md`
- `docs/memory-strategy.md`
- `docs/memory-promotion-rules.md`
- `docs/design-discussion-log.md`

---

## 2. Design Goal

The key architectural goal is:

> provider-specific storage and search behavior must remain replaceable, while memory governance and runtime policy remain stable in the platform.

This leads to a deliberate two-layer split:

- `MemoryProvider`: storage-facing SPI
- `MemoryEngine`: platform policy and orchestration layer

This is intentionally parallel to the existing runtime architecture:

- adapters are runtime-specific and replaceable
- capability routing remains platform-owned and stable

---

## 3. Two-Layer Boundary

### 3.1 `MemoryProvider`

`MemoryProvider` is the low-level SPI.

Responsibilities:

- store canonical `MemoryRecord` objects
- perform provider-native search
- update record state
- support delete for compliance or hard-removal workflows

Non-responsibilities:

- promotion policy
- namespace expansion rules
- admission scoring
- novelty gate decisions
- context injection policy

### 3.2 `MemoryEngine`

`MemoryEngine` is the platform strategy layer.

Responsibilities:

- expand runtime-readable namespaces from an anchor
- call provider search with explicit namespace slices
- rerank provider hits using platform scoring
- handle experience write path vs confirmed fast path
- run promotion and consolidation logic
- enforce V1.1 guards and policy constraints

Non-responsibilities:

- raw vector index implementation
- provider-specific storage schema details
- provider-specific embedding identifiers

---

## 4. Package Placement

The SPI should remain dependency-light and live in `@ctx/core`.

Recommended placement:

- `MemoryProvider` -> `packages/core/src/memory-provider.ts`
- `MemoryEngine` -> `packages/core/src/memory-engine.ts`

Concrete implementations should live outside `@ctx/core`, for example:

- `packages/client/src/internal/...`
- future `packages/memory/...`

This keeps the platform consistent with the current rule that `@ctx/core` exposes contracts, not implementations.

---

## 5. Namespace Expansion Model

### 5.1 Anchor Input

Callers should not pass raw `scope[]` filters into the provider-facing path.

Instead, callers pass a namespace anchor:

```ts
interface MemoryNamespaceAnchor {
  workspaceId: string;
  userId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
}
```

This anchor describes the current execution context, not the final provider query.

### 5.2 Expanded Namespace Slices

The engine expands an anchor into explicit readable namespace slices:

```ts
interface MemoryNamespaceSlice {
  scope: "run" | "task" | "session" | "user" | "workspace" | "global";
  ownerId: string;
}
```

Examples:

- `run` search from an active run may expand to:
  - `{ scope: "run", ownerId: runId }`
  - `{ scope: "task", ownerId: taskId }`
  - `{ scope: "session", ownerId: sessionId }`
  - `{ scope: "user", ownerId: userId }` when stable identity exists
  - `{ scope: "workspace", ownerId: workspaceId }`

This means retrieval is based on explicit `(scope, ownerId)` slices, not bare scope enums.

### 5.3 Why Expansion Stays in the Engine

Keeping namespace expansion in `MemoryEngine` ensures:

- read visibility rules are centralized
- provider implementations do not invent policy
- callers cannot bypass scope traversal by manually constructing broad filters

---

## 6. `global` Scope Guard

The canonical type may retain `global` for forward compatibility.

However, V1.1 should treat `global` as reserved.

Recommended runtime rule:

```ts
if (scope === "global") {
  throw new PlatformError("NOT_ENABLED", "global scope is reserved for future use");
}
```

Interpretation:

- `global` remains in the model for future expansion
- V1.1 write paths must reject it
- V1.1 retrieval planning should not include it

This avoids ambiguity with the current `workspaceId: string` requirement while preserving future design space.

---

## 7. Provider SPI Draft

```ts
interface MemoryProvider {
  get(id: string): Promise<MemoryRecordV1_1 | null>;

  search(input: ProviderSearchInput): Promise<ProviderSearchHit[]>;

  put(record: MemoryRecordV1_1): Promise<MemoryRecordV1_1>;

  update(id: string, patch: MemoryRecordPatch): Promise<MemoryRecordV1_1>;

  archive(
    id: string,
    opts?: { replacedBy?: string; reason?: string },
  ): Promise<void>;

  invalidate(
    id: string,
    opts?: { invalidatedBy?: string; reason?: string },
  ): Promise<void>;

  delete(id: string): Promise<void>;
}
```

### 7.1 Provider Search Input

```ts
interface ProviderSearchInput {
  workspaceId: string;
  namespaces: MemoryNamespaceSlice[];
  queryText?: string;
  queryEmbedding?: number[];
  layer?: "experience" | "long_term";
  channel?: "profile" | "collection";
  kind?: Array<MemoryRecordV1_1["kind"]>;
  status?: Array<MemoryRecordV1_1["status"]>;
  limit: number;
}
```

Notes:

- providers receive already-expanded namespace slices
- providers may use keyword, vector, or hybrid search internally
- providers should not decide upward visibility policy themselves

### 7.2 Provider Search Hit

```ts
interface ProviderSearchHit {
  record: MemoryRecordV1_1;
  vectorScore?: number;
}
```

Interpretation:

- `vectorScore` is provider-native similarity output
- it is not the final platform retrieval score

---

## 8. Engine SPI Draft

```ts
interface MemoryEngine {
  search(query: MemorySearchQuery): Promise<MemorySearchResult>;

  writeExperience(input: WriteExperienceInput): Promise<MemoryRecordV1_1>;

  writeConfirmed(input: WriteConfirmedInput): Promise<MemoryRecordV1_1>;

  consolidateTask(input: ConsolidateTaskInput): Promise<PromotionResult[]>;

  promote(input: PromoteMemoryInput): Promise<PromotionResult>;
}
```

### 8.1 Why These Names

- `writeExperience` is the normal experience-memory write path
- `writeConfirmed` is the fast path for explicit user-confirmed memory

These names are preferred over `writeLocal` and `fastPathWrite` because they describe semantic intent rather than storage locality or implementation timing.

---

## 9. Engine Search Contract

### 9.1 Query Shape

```ts
interface MemorySearchQuery {
  anchor: MemoryNamespaceAnchor;
  queryText: string;
  layer?: "experience" | "long_term";
  channel?: "profile" | "collection";
  kind?: Array<MemoryRecordV1_1["kind"]>;
  maxResults?: number;
}
```

### 9.2 Search Result Shape

```ts
interface MemorySearchResult {
  hits: Array<{
    record: MemoryRecordV1_1;
    finalScore: number;
  }>;
  namespacesSearched: MemoryNamespaceSlice[];
}
```

Interpretation:

- provider hits are raw retrieval candidates
- engine results are post-policy, post-rerank outputs
- `namespacesSearched` is retained for debug, audit, and retrieval explanation

### 9.3 Engine Ranking

V1.1 engine ranking should remain compatible with the memory strategy direction:

```ts
finalScore =
  relevance  * 0.45 +
  importance * 0.25 +
  confidence * 0.15 +
  recency    * 0.15
```

Interpretation:

- `relevance` may incorporate provider similarity or keyword match
- `importance` and `confidence` come from the canonical record
- `recency` remains explicit so older memories do not dominate forever

The exact implementation remains tunable, but the provider must not own this final score.

---

## 10. Promotion Contract

### 10.1 Promotion Result

```ts
interface PromotionResult {
  memoryId: string;
  action:
    | "PROMOTE_NEW"
    | "PROMOTE_UPDATE"
    | "PROMOTE_INVALIDATE"
    | "PROMOTE_ARCHIVE"
    | "ADD_CANDIDATE"
    | "NONE";
  targetId?: string;
  resultRecordId?: string;
  admissionScore?: number;
  reason?: string;
}
```

Interpretation:

- `memoryId` is the source experience or candidate record being evaluated
- `targetId` is the existing long-term target when update/archive/invalidate acts on an existing record
- `resultRecordId` is the record created or updated by the action when that is useful to expose

### 10.2 Consolidation Role

`consolidateTask()` is the task-bounded promotion boundary for V1.1.

It should:

1. collect promotable experience records for the task
2. classify channel using rule-based logic
3. search similar long-term entries through the provider
4. compute novelty and admission score
5. emit `PromotionResult[]`

---

## 11. Write Path Semantics

### 11.1 `writeExperience`

Use for:

- run-completed extraction output
- ordinary experience retention
- candidate creation before later promotion review

Expected default characteristics:

- writes into local scope
- usually uses `experience` layer
- may set `status = "candidate"` when promotion review is intended

### 11.2 `writeConfirmed`

Use for:

- explicit preference statements
- explicit corrections
- explicit "remember this" instructions
- user-confirmed rules

Expected default characteristics:

- bypasses conservative task-completion timing
- may promote directly to long-term memory
- should still respect dedupe, update, invalidation, and archive semantics

---

## 12. Status Transition Semantics

Provider methods should not collapse all state changes into one generic mutation.

V1.1 should keep these meanings distinct:

- `invalidate`: old memory is no longer valid
- `archive`: old memory is retired, but not necessarily false
- `delete`: hard removal for compliance or explicit destructive workflows

The record fields:

- `invalidatedBy?: string`
- `replacedBy?: string`

remain canonical lineage fields and are not the same thing as method names.

---

## 13. Constraints to Preserve

The following constraints should remain stable:

- `scope` remains explicitly stored on the record
- `ownerRef` and `scope` remain separate concepts
- `channel` remains explicit on canonical records
- provider-specific implementation fields stay out of `MemoryRecord`
- `ToolCallRef` remains outside `MemoryRecord` and is linked through provenance

---

## 14. Recommended V1.1 Next Step

After this document, the next design topic should be:

- concrete TypeScript contract files in `@ctx/core`
- validation rules for `writeExperience` and `writeConfirmed`
- `MemorySearchQuery` and retrieval explanation tests
- interaction points between `ContextEngine` and `MemoryEngine`
