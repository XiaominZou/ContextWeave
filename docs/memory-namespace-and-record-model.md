# Memory Namespace and Record Model

## 1. Purpose

This document defines the first concrete draft for:

- the memory namespace model
- the `MemoryRecord` field model
- the relationship between `ownerRef`, `scope`, `layer`, and `channel`

The goal is to provide a stable V1.1-level schema direction that is expressive enough for retrieval and governance, but still lightweight enough to implement without overfitting to a specific memory provider.

This document should be read together with:
- `docs/memory-strategy.md`
- `docs/memory-promotion-rules.md`
- `docs/design-discussion-log.md`

---

## 2. Design Goals

The schema should satisfy these goals:

1. It must not tightly couple memory management to the current runtime implementation.
2. It must support both short-to-mid-term `experience memory` and promoted `long-term memory`.
3. It must preserve enough provenance for promotion, invalidation, and audit.
4. It must keep provider-specific concerns, such as vector index internals, out of the canonical record where possible.
5. It must distinguish ownership from visibility.

---

## 3. Namespace Model

### 3.1 Scope Hierarchy

The working namespace hierarchy is:

```ts
type MemoryScope =
  | "run"
  | "task"
  | "session"
  | "user"
  | "workspace"
  | "global";
```

Interpretation:
- `run`: local to one execution attempt
- `task`: visible within a task and its immediate continuation context
- `session`: visible throughout the session
- `user`: visible across sessions for the same user
- `workspace`: visible across a workspace or project boundary
- `global`: visible everywhere by policy

### 3.2 Read Rule

Default read behavior is upward:

`run -> task -> session -> user -> workspace -> global`

A runtime should typically read:
- the current scope
- any broader scope above it

### 3.3 Write Rule

Default write behavior is local:
- newly extracted memories are written into their local scope
- upward movement is not ordinary write behavior
- upward movement happens through promotion

Examples:
- run-derived experience usually writes to `run`, `task`, or `session`
- long-term promoted memory usually lands in `user`, `workspace`, or `global`

---

## 4. Ownership vs Visibility

The model keeps `ownerRef` and `scope` as separate fields.

### 4.1 Why Both Are Needed

These two fields answer different questions:

- `ownerRef`: who owns or produced the record
- `scope`: where the record is allowed to be visible

This separation becomes important when a memory is promoted beyond the scope of its origin.

Examples:
- a task-derived insight promoted to session scope
- a session-derived preference promoted to user scope
- a workspace-level admin action producing a global record

### 4.2 Owner Model

```ts
type MemoryOwnerRef =
  | { type: "run"; id: string }
  | { type: "task"; id: string }
  | { type: "session"; id: string }
  | { type: "user"; id: string }
  | { type: "workspace"; id: string }
  | { type: "global"; id: "global" };
```

### 4.3 Practical Guidance

Typical cases:
- run extraction: `ownerRef.type = "run"`
- task-level consolidated experience: `ownerRef.type = "task"`
- user preference: `ownerRef.type = "user"`
- workspace convention: `ownerRef.type = "workspace"`

The `scope` may match `ownerRef.type`, but does not have to.

---

## 5. Memory Layer Model

The working model uses two canonical layers:

```ts
type MemoryLayer = "experience" | "long_term";
```

Interpretation:
- `experience`: reusable short-to-mid-term project memory derived from runs, tasks, and sessions
- `long_term`: more stable, cross-context memory retained after promotion

`knowledge source` is intentionally not represented as `MemoryRecord`.
It remains an external retrieval source.

---

## 6. Memory Channel Model

Long-term memory uses two channels:

```ts
type MemoryChannel = "profile" | "collection";
```

Interpretation:
- `profile`: structured, stable, update-oriented memory
- `collection`: unbounded, reusable entries such as rules, insights, and decisions

Guidance:
- `profile` should usually be small and high-signal
- `collection` can grow, but must be deduped and governed

For V1.1, channel classification should be rule-based.

---

## 7. Record Status Model

```ts
type MemoryStatus =
  | "active"
  | "candidate"
  | "invalidated"
  | "archived"
  | "expired";
```

Interpretation:
- `active`: currently usable
- `candidate`: extracted or retained for future promotion review
- `invalidated`: superseded by newer memory
- `archived`: retained for history but no longer active
- `expired`: no longer valid due to time-based expiry

V1.1 should avoid a heavy conflict workflow.
If a new memory clearly replaces an old one, prefer invalidation/update semantics over introducing a long-lived conflict queue.

---

## 8. Memory Kind Model

```ts
type MemoryKind =
  | "fact"
  | "preference"
  | "procedure"
  | "constraint"
  | "insight"
  | "decision";
```

Interpretation:
- `fact`: stable factual knowledge
- `preference`: user or workspace preference
- `procedure`: repeatable way of doing something
- `constraint`: limitation, invariant, or rule that must be respected
- `insight`: distilled learning or reusable conclusion derived from experience
- `decision`: explicit decision that may affect future work

`insight` is preferred over `summary` to avoid confusion with the `summary` field and to better express extracted learning rather than raw recap.

V1.1 should not add a separate `event` kind unless a real use case proves it is necessary.

---

## 9. Canonical V1.1 Record Draft

```ts
interface MemoryRecordV1_1 {
  id: string;

  workspaceId: string;
  userId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;

  ownerRef: MemoryOwnerRef;
  scope: MemoryScope;

  layer: "experience" | "long_term";
  channel: "profile" | "collection";
  kind: "fact" | "preference" | "procedure" | "constraint" | "insight" | "decision";
  status: "active" | "candidate" | "invalidated" | "archived" | "expired";

  title: string;
  content: string;
  summary?: string;

  importance: number;
  confidence: number;

  keywords?: string[];

  sourceRefs?: Array<{
    type: "event" | "run" | "task" | "artifact" | "tool_call" | "message";
    id: string;
  }>;

  promotedFrom?: string;
  invalidatedBy?: string;
  replacedBy?: string;
  confirmedBy?: "system" | "user";

  version: number;

  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  archivedAt?: string;
}
```

---

## 10. Field Rationale

### 10.1 Identity and Provenance Fields

- `workspaceId`
- `userId?`
- `sessionId?`
- `taskId?`
- `runId?`
- `ownerRef`
- `sourceRefs?`

These fields support:
- provenance
- retrieval filtering
- audit
- promotion tracing

### 10.2 Governance Fields

- `layer`
- `channel`
- `status`
- `confirmedBy?`
- `version`

These fields govern how the record is managed, not how it is ranked at retrieval time.

### 10.3 Content Fields

- `title`
- `content`
- `summary?`
- `kind`
- `keywords?`

These fields support:
- human readability
- retrieval
- prompt assembly
- downstream summarization or promotion

### 10.4 Relationship Fields

- `promotedFrom?`
- `invalidatedBy?`
- `replacedBy?`

These fields support:
- promotion lineage
- invalidation lineage
- replacement tracking

---

## 11. Deliberately Excluded From V1.1

The following fields are intentionally excluded from the canonical V1.1 record:

- `evidenceCount`
- `futureUtility`
- `semanticNovelty`
- `tags`
- `lastAccessedAt`
- `invalidates: string[]`
- `promotionEligible`
- `embeddingId`

### 11.1 Why They Are Excluded

#### Runtime scoring signals

These should be computed during promotion or retrieval, not permanently stored on the record:
- `evidenceCount`
- `futureUtility`
- `semanticNovelty`

#### Redundant or premature metadata

These are useful later, but not necessary in V1.1:
- `tags`
- `lastAccessedAt`
- `promotionEligible`

#### Provider-specific implementation details

These should stay in the memory engine or provider layer rather than the canonical schema:
- `embeddingId`

#### Directionally awkward relationship field

This is replaced by inverse invalidation linkage:
- `invalidates: string[]` -> replaced by `invalidatedBy?: string`

---

## 12. Guidance for `importance` and `confidence`

These two fields are retained in V1.1.

However, they should be interpreted carefully.

### 12.1 `importance`

`importance` is:
- an assessment signal
- useful for budget-aware context pruning
- useful for promotion scoring

It is not:
- the final runtime retrieval score
- an immutable truth

### 12.2 `confidence`

`confidence` is:
- a governance signal
- a proxy for trust in the validity of the memory
- influenced by confirmation source and evidence quality

It is not:
- the same thing as relevance

Both fields may be updated as evidence accumulates.

---

## 13. V1.1 Constraints

Recommended constraints:

- `experience` memory should usually remain in `run`, `task`, or `session` scope
- `long_term` memory should usually land in `user`, `workspace`, or `global` scope
- `profile` should usually appear in `long_term`
- `collection` may exist in both `experience` and `long_term`
- `knowledge source` remains outside `MemoryRecord`

---

## 14. Open Questions

The following questions remain open:

1. Should `channel` be mandatory for all `experience` records, or only for promotion-eligible records?
2. Should `summary` be optional for all records, or required for `insight` and `decision`?
3. Should `scope` be explicitly stored forever, or can some providers derive it from `ownerRef` plus promotion lineage?
4. How should namespace-readable scope sets be computed in the runtime API?

---

## 15. Next Step

After this document, the next design topic should be:

- `MemoryEngine` SPI
- search query model
- write/update/archive/promote semantics
- namespace-aware retrieval contract
