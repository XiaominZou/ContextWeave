# Design Discussion Log

## 1. Purpose

This document records the outcomes of design discussions that are intentionally kept outside the main specification documents.

Use this file to preserve:
- decisions that have already been made
- rationale behind those decisions
- open questions and pending topics
- the current discussion order

This document is not the canonical SDK spec.
The canonical spec remains:

- `docs/context-platform-sdk-design.md`
- `docs/architecture.md`
- `docs/memory-strategy.md`
- `docs/testing-strategy.md`

This document exists to prevent design drift during long discussions and future context compression.

---

## 2. Discussion Scope

We identified 4 major design tracks:

1. Session organization structure
2. Context loading and pruning strategy
3. Memory layers and boundaries
4. Memory namespace, governance, lifecycle, and SPI

At the current point in the discussion, track 1 has a stable conclusion and track 2 has an important implementation direction. Track 3 is now the active topic.

---

## 3. Decisions Already Made

### 3.1 Canonical Runtime Direction

Current platform direction remains:

- The platform is always the canonical owner of `Session`, `Task`, and `Run`
- Business code enters execution only through `RunAPI`
- Adapters are internal runtime integration layers
- Event capture is always on
- Capabilities are progressively activated through `CapabilityPolicy`

Already implemented in code:

- canonical `Session / Task / Run / Event` runtime path
- `RunAPI.start()` orchestration
- adapter registry
- normalized event pipeline
- automatic terminal-state ownership
- first real adapter: `OpenCodeAdapter`

Not yet implemented:

- context engine
- memory engine
- artifact capture-store
- task mirroring / platform tools
- checkpoint / resume

---

## 4. Topic 1: Session Organization Structure

### 4.1 Problem Statement

The original question was whether session structure should be modeled as a tree or a graph.

The discussion concluded that this framing was too narrow.

The real requirement is:

- preserve canonical session truth
- support precise context pruning
- reduce token usage
- allow removal of irrelevant task history
- allow removal or compression of low-value tool calls
- avoid another expensive LLM call during context loading

### 4.2 Final Direction

The chosen direction is:

> `Layered Timeline + lightweight index objects`

This replaces the earlier tree-vs-graph framing.

### 4.3 Why This Was Chosen

A pure tree was rejected because:

- shared context is hard to represent cleanly
- cross-task reuse becomes awkward
- tool outputs and artifacts do not naturally fit a strict hierarchy

A full DAG as the primary session representation was not chosen because:

- it is too heavy for V1.1
- all tool calls as first-class graph nodes would explode graph size
- it increases implementation cost before the context engine and memory engine are stable

A pure event stream was also not enough because:

- it preserves time, but not enough relevance structure
- pruning would become overly dependent on recency
- older but important task outputs or artifacts would be hard to retrieve precisely

The compromise is:

- canonical truth remains time-oriented
- compression happens in layers
- selective indexes provide precise retrieval where needed

### 4.4 Session Structure Model

The session is treated as a layered timeline:

- Layer 0: raw events, messages, tool calls, tool results
- Layer 1: run summaries and key run-level artifacts
- Layer 2: task summaries and task outcomes
- Layer 3: extracted memory and knowledge-layer outputs

This means session organization is primarily temporal, not purely hierarchical.

### 4.5 Context Pruning Model

Context pruning should work like this:

1. Start from the current request focus:
   - current `taskId`
   - current `runId`
   - current prompt / objective

2. Select a time window:
   - recent runs can use lower compression
   - older runs should use summaries instead of raw detail

3. Apply structured relevance:
   - current task first
   - task dependencies next
   - referenced artifacts next
   - relevant memory and knowledge sources next

4. Apply token-aware retention:
   - keep summaries first
   - only expand expensive raw content when necessary

This gives the platform a way to reduce token usage without needing another large-model inference pass.

---

## 5. Topic 1A: Tool Call Handling

### 5.1 Problem Statement

Tool calls are a major token cost source because tool results often get included in model context.

The key requirement is:

- tool calls must be prunable
- tool calls must be rankable
- tool calls must be compressible
- the platform must avoid keeping all raw tool output in every context load

### 5.2 Decision

The chosen direction is the **enhanced version**:

> tool calls must be selectively indexable for pruning

This means:

- tool calls should not remain only as raw events
- tool calls should not all become heavyweight graph nodes either
- instead, important tool calls should produce lightweight index objects

### 5.3 Chosen Pattern

The selected pattern is:

> raw tool events in timeline + derived lightweight index object

Working name:

- `ToolCallRef`

### 5.4 `ToolCallRef` Role

`ToolCallRef` is intended to be:

- not just a raw event
- not a full heavyweight session node
- a compressed, queryable, rankable reference to a tool call and its result

This object exists so that context loading can decide:

- drop the tool call completely
- keep only its summary
- expand the original result when truly needed

### 5.5 Why This Was Chosen

This solves the core pruning requirement better than either extreme:

If tool calls stay only in raw events:

- they are hard to prune precisely
- the runtime has to revisit noisy raw data too often

If all tool calls become top-level graph nodes:

- the graph becomes huge
- many low-value tool calls pollute the structure
- storage and traversal complexity rises too quickly

`ToolCallRef` is the middle path.

### 5.6 Context Loading Strategy for Tool Calls

The chosen runtime direction is:

- recent or highly relevant tool calls may be included
- older tool calls should prefer summary form
- low-value tool calls should be dropped

Retention levels:

- `drop`
- `summary-only`
- `expand`

Expansion should be rare and only happen when:

- the current task explicitly depends on the result
- the tool call produced a key artifact
- the result is the authoritative source for the current answer
- the current query semantically matches the tool result strongly

---

## 6. Topic 1B: Hot-Path Relevance Strategy

### 6.1 Constraint

The platform should not trigger another expensive LLM call just to decide what context to load.

### 6.2 Decision

The selected hot-path strategy is:

> structural filtering + embedding-based ranking + token-aware retention

Explicitly rejected for the hot path:

- another large-model inference
- reranker model in V1.1

### 6.3 Hot-Path Pipeline

The chosen load-time pipeline is:

1. Structural filtering
2. Embedding ranking
3. Token-aware retention

### 6.4 Structural Filtering

This stage should use only low-cost structure and metadata, such as:

- current `taskId`
- current `runId`
- task dependencies
- artifact references
- recent run window
- summary coverage
- `ToolCallRef` metadata

This is the first pass that removes obviously irrelevant material.

### 6.5 Embedding Ranking

This stage should use:

- one query embedding for the current request
- precomputed embeddings for candidate summaries, memory items, and `ToolCallRef` summaries

No reranker is used in this stage.

### 6.6 Token-Aware Retention

Even relevant candidates should not all survive.

The runtime should prefer:

1. summaries
2. artifact summaries
3. selected tool-call summaries
4. raw tool results only when necessary

### 6.7 Why This Was Chosen

This approach gives the best current tradeoff:

- much cheaper than another LLM pass
- more precise than pure rules
- simple enough for V1.1
- compatible with later improvements

---

## 7. Topic 2: Memory Layers and Boundaries

This is the active topic now.

### 7.1 Current State

We have not yet fully completed the memory management model.

What has already been discussed:

- memory integration strategy
- when to retrieve memory
- when to inject memory
- when to write memory
- task cache / freshness
- write-after-read constraint
- `memory=tool-bridge` is pure on-demand
- `memory=platform` owns pre-run retrieval

What has not yet been finalized:

- exact layer boundaries
- promotion rules
- namespace hierarchy
- governance rules
- lifecycle rules
- MemoryEngine SPI details
- relationship between `ToolCallRef` and `MemoryRecord`

### 7.2 Early Direction Already Chosen

A major preference has already been stated:

> `experience memory` should be treated as an experience repository, not just a short-lived cache.

Reasoning:

- very recent context is already covered inside an active session
- the value of experience memory is in preserving reusable short- to mid-term learning
- it should support retrieval and future promotion, not only temporary buffering

This means `experience memory` should likely be:

- automatically extractable
- queryable
- compressible
- expirable
- a source for long-term promotion
- more stable than a pure working cache
- less strict than long-term memory

### 7.3 Candidate Layer Model Under Discussion

The working candidate structure is:

1. `experience memory`
2. `long-term memory`
3. `knowledge source`

Current intuition:

- `experience memory`: reusable short- to mid-term learned context from runs/tasks/sessions
- `long-term memory`: stable facts, preferences, conventions, confirmed knowledge
- `knowledge source`: static RAG-style external knowledge, managed separately from memory write-back

No final decision has yet been made on exact boundaries.

---

## 8. Pending Topics

The following topics are still open:

### 8.1 Memory Layer Boundaries

Need to define:

- what belongs in `experience memory`
- what belongs in `long-term memory`
- what belongs in `knowledge source`
- what can move between them

### 8.2 Promotion Rules

Need to define:

- when `experience memory` can be promoted
- whether promotion is automatic, user-confirmed, or policy-driven
- what metadata must be attached to promoted items

### 8.3 Namespace Model

Need to define how memory is organized across:

- `user`
- `workspace`
- `session`
- `task`
- `run`

### 8.4 Lifecycle and Governance

Need to define:

- creation
- dedupe
- conflict
- expiration
- archive
- merge
- overwrite policy

### 8.5 Memory SPI

Need to define the provider abstraction so that the memory system is not tightly coupled to the current runtime.

---

## 9. Working Principles To Preserve

These principles should remain stable unless explicitly changed:

- do not re-run a large LLM during context loading
- preserve canonical runtime ownership in the platform
- keep memory implementation replaceable behind an SPI
- separate session structure from memory layer
- separate memory from static knowledge sources
- prefer summary over raw replay when budget is tight
- keep the hot path cheap and deterministic enough for production use

---

## 10. Immediate Next Discussion Topic

Next topic:

> define the exact boundaries between `experience memory`, `long-term memory`, and `knowledge source`

The next discussion should cover:

- inputs
- write path
- retrieval path
- lifetime
- promotion path
- relationship to session timeline and `ToolCallRef`

---

## 11. Topic 2A: Promotion Rules

This topic has now been narrowed significantly.

### 11.1 Current Direction

The agreed direction is:

- `experience memory` is extracted at `run.completed`
- promotion is primarily evaluated at `task.completed`
- promotion must not be append-only
- long-term memory must support `new`, `update`, `invalidate`, and `archive`
- long-term memory is split into `profile` and `collection` channels

### 11.2 Promotion Channels

Two long-term channels are now part of the working design:

- `profile`
- `collection`

`profile` is intended for stable, schema-like memory such as:
- user preferences
- project conventions
- stable defaults

`collection` is intended for reusable but unbounded entries such as:
- reusable经验
- engineering rules
- process summaries
- decision summaries

### 11.3 Promotion Timing

The current promotion timing is:

- `run.completed`: extract experience candidates only
- `task.completed`: run consolidation and promotion evaluation
- periodic sweep: dedupe, archive, cleanup

This means promotion is task-bounded rather than run-bounded.

### 11.4 Promotion Pipeline

The working pipeline is:

1. extract `experience candidates`
2. classify channel (`profile` or `collection`)
3. search similar long-term memory entries
4. compute admission score
5. choose action

### 11.5 Promotion Actions

The current action set is:

- `NONE`
- `ADD_CANDIDATE`
- `PROMOTE_NEW`
- `PROMOTE_UPDATE`
- `PROMOTE_INVALIDATE`
- `PROMOTE_ARCHIVE`

### 11.6 Novelty Gate

A novelty filter is now considered mandatory before long-term promotion.

Purpose:
- prevent over-insertion
- reduce semantic duplicates
- decide whether the candidate should be treated as `new`, `update`, or `none`

V1.1 direction:
- use embedding-based similarity search against long-term memory
- always check novelty for `profile`
- selectively check novelty for `collection`

### 11.7 Admission Score

The current working formula is:

```ts
admissionScore =
  futureUtility    * 0.30 +
  evidenceStrength * 0.25 +
  semanticNovelty  * 0.20 +
  importance       * 0.15 +
  confidence       * 0.10
```

Current thresholds:

- `>= 0.65` -> `PROMOTE_NEW` or `PROMOTE_UPDATE`
- `0.40 ~ 0.65` -> `ADD_CANDIDATE`
- `< 0.40` -> `NONE`

### 11.8 Fast Path

User-confirmed preferences and corrections should use a fast path.

Examples:
- explicit preference statements
- explicit factual corrections
- explicit "remember this" instructions

These do not need to wait for `task.completed`.

### 11.9 V1.1 Simplification

V1.1 should avoid a heavy conflict workflow.

Working simplification:
- clear replacement -> `PROMOTE_INVALIDATE` + replacement
- mild refinement -> `PROMOTE_UPDATE`
- only user-confirmed memory that is later challenged may need a review flag

### 11.10 Next Pending Topic

The next unresolved design topic is now:

> define the concrete memory namespace model and the final `MemoryRecord` field model

---

## 12. Topic 2B: Namespace Model and MemoryRecord Draft

A first concrete draft now exists for the namespace model and `MemoryRecord` field model.

### 12.1 Namespace Direction

Current working direction:

```ts
run -> task -> session -> user -> workspace -> global
```

Interpretation:
- reads move upward by default
- writes are local by default
- upward movement happens through promotion

`user` is now part of the working namespace model and is considered necessary for future profile memory.

### 12.2 Ownership vs Visibility

The current draft keeps both:
- `ownerRef`
- `scope`

Reason:
- `ownerRef` captures origin/ownership
- `scope` captures visibility

These are intentionally not collapsed into a single field.

### 12.3 Record Layers, Channels, and Status

Current draft fields:
- `layer`: `experience | long_term`
- `channel`: `profile | collection`
- `status`: `active | candidate | invalidated | archived | expired`

### 12.4 Memory Kind Draft

Current draft kinds:
- `fact`
- `preference`
- `procedure`
- `constraint`
- `insight`
- `decision`

`insight` replaced the earlier `summary` kind to avoid ambiguity.

### 12.5 Fields Explicitly Removed From the Canonical Draft

The current draft intentionally excludes:
- `evidenceCount`
- `futureUtility`
- `semanticNovelty`
- `tags`
- `lastAccessedAt`
- `invalidates: string[]`
- `promotionEligible`
- `embeddingId`

Reason:
- these are either runtime signals, provider details, or premature V1.1 metadata

### 12.6 Relationship Direction

The current draft prefers:
- `invalidatedBy?: string`
- `replacedBy?: string`

rather than a forward `invalidates[]` field.

### 12.7 Versioning

`version` is now part of the working draft and should increment on update-style promotion.

### 12.8 Remaining Open Questions

Still open:
- whether `channel` is mandatory on all experience records
- whether some record kinds should require `summary`
- whether `scope` should always be explicitly persisted
- how runtime readable scopes are computed in the retrieval contract

---

## 13. Topic 2C: MemoryEngine SPI and Retrieval Contract

The namespace and record draft is now considered stable enough to define the first concrete SPI direction.

### 13.1 Two-Layer SPI Split

The working direction is now:

- `MemoryProvider`
- `MemoryEngine`

Interpretation:

- `MemoryProvider` is the storage-facing, provider-replaceable SPI
- `MemoryEngine` is the platform strategy and governance layer

This split is considered a key architecture decision and should remain aligned with the broader platform pattern:

- adapters are replaceable runtime integrations
- platform routing and policy remain stable above them

### 13.2 Namespace Input Model

The retrieval contract should not ask callers to pass raw `scope[]`.

Instead, callers pass a `MemoryNamespaceAnchor` describing the current execution context.

The engine then expands the anchor into explicit readable namespace slices:

- `(scope = run, ownerId = runId)`
- `(scope = task, ownerId = taskId)`
- `(scope = session, ownerId = sessionId)`
- `(scope = user, ownerId = userId)` when stable identity exists
- `(scope = workspace, ownerId = workspaceId)`

This means provider-facing search uses expanded `(scope, ownerId)` slices rather than bare scope enums.

### 13.3 `scope` Persistence

The current direction is to keep `scope` explicitly stored.

Reason:

- `ownerRef` answers origin/ownership
- `scope` answers visibility

These fields remain intentionally separate and should not be collapsed or derived away in V1.1.

### 13.4 `channel` Direction

The current preference is:

- `channel` remains explicit on canonical records
- `long_term` records should always have `channel`
- `experience` records may default to `collection`

This keeps indexing and promotion logic simpler than a nullable-channel design.

### 13.5 `global` Scope Guard

The canonical type may retain `global` for future compatibility.

However, V1.1 should not activate it.

Working runtime rule:

- write paths reject `scope = global` with `NOT_ENABLED`
- retrieval planning does not include `global`

This keeps the model forward-compatible without introducing ambiguity in the current workspace-bound design.

### 13.6 Provider Method Semantics

The provider layer should keep `archive`, `invalidate`, and `delete` distinct.

Current direction:

- `archive(id, opts?: { replacedBy?: string; reason?: string })`
- `invalidate(id, opts?: { invalidatedBy?: string; reason?: string })`
- `delete(id)`

This avoids mixing:

- replacement lineage
- invalidation semantics
- hard deletion semantics

### 13.7 Engine Method Names

The current preferred engine method names are:

- `search`
- `writeExperience`
- `writeConfirmed`
- `consolidateTask`
- `promote`

These names are preferred over earlier names such as `writeLocal` because they describe semantic write paths rather than implementation locality.

### 13.8 Search Result Layering

The provider and engine search outputs should remain distinct.

Provider layer:

- `ProviderSearchHit { record, vectorScore? }`

Engine layer:

- `MemorySearchResult { hits[], namespacesSearched[] }`

Interpretation:

- provider hits are raw retrieval candidates
- engine results are reranked platform outputs
- `namespacesSearched` is retained for debug, audit, and retrieval explanation

### 13.9 Promotion Result Type

A concrete `PromotionResult` type is now considered necessary.

Minimum working direction:

- `memoryId`
- `action`
- `targetId?`
- `resultRecordId?`
- `admissionScore?`
- `reason?`

This supports:

- audit trail
- promotion debugging
- update/new/invalidate lineage visibility

### 13.10 Package Placement

The current preferred package placement is:

- contracts in `@ctx/core`
- implementations outside `@ctx/core`

Recommended files:

- `packages/core/src/memory-provider.ts`
- `packages/core/src/memory-engine.ts`

### 13.11 Next Pending Topic

The next unresolved design topic is now:

> translate the SPI draft into concrete TypeScript contract files and validation rules
