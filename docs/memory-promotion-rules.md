# Memory Promotion Rules

## 1. Purpose

This document defines how `experience memory` is evaluated and promoted into `long-term memory`.

It is intentionally narrower than the full memory management design. Its goal is to make promotion behavior implementable and testable without waiting for the entire memory system to be finalized.

This document assumes the already agreed high-level model:

- `experience memory` is an experience repository, not a short-lived cache
- `long-term memory` stores stable, cross-context knowledge
- `knowledge source` is an external RAG-like source and does not participate in promotion

---

## 2. Scope

This document covers:

- promotion timing
- promotion actions
- profile vs collection channels
- novelty filtering
- admission scoring
- invalidation and archive behavior
- V1.1 simplifications

This document does not yet define:

- final `MemoryRecord` schema
- namespace hierarchy details
- provider-specific vector index implementation
- periodic sweep scheduling details

---

## 3. Core Principles

Promotion is governed by these principles:

1. Promotion is not append-only.
   Long-term memory must support `new`, `update`, `invalidate`, and `archive` semantics.

2. Promotion is not triggered for every extracted memory item.
   Extraction and promotion are separate phases.

3. Promotion should be conservative.
   A useful memory candidate is not automatically a long-term memory item.

4. Profile-like memory and collection-like memory must not share the same write semantics.

5. Promotion should not require a large-model hot-path call during context loading.

6. Long-term memory should not be polluted by duplicated or semantically equivalent fragments.

---

## 4. Promotion Pipeline

The promotion pipeline has 3 phases.

### 4.1 Phase 1: Extraction

Trigger:
- `run.completed`

Behavior:
- extract candidate memories from the completed run
- write them into `experience memory`
- mark eligible items for later promotion review

Phase 1 does not decide long-term promotion.

The output of Phase 1 is a set of `experience candidates` with metadata such as:
- source run
- source task
- channel hint
- importance
- confidence
- summary or normalized content

### 4.2 Phase 2: Consolidation

Primary trigger:
- `task.completed`

Behavior:
- collect promotable `experience candidates` produced within the task
- search existing long-term memory for similar entries
- compute novelty and admission score
- decide action

This is the primary promotion boundary for V1.1.

Rationale:
- run-level extraction is too noisy
- task completion is a more natural boundary for consolidating stable patterns
- this reduces cost and avoids over-insertion

### 4.3 Phase 3: Maintenance

Trigger:
- periodic sweep job

Behavior:
- merge semantically duplicated long-term entries
- archive inactive entries
- clean up expired experience candidates
- accumulate additional evidence if needed

This phase is important but can remain lightweight in V1.1.

---

## 5. Promotion Channels

Long-term promotion uses 2 channels.

### 5.1 Profile Channel

Use for structured, stable, updatable memory such as:
- user preferences
- project conventions
- stable workspace defaults
- identity-like persistent facts

Behavior:
- typically `upsert by key`
- prefers `PROMOTE_UPDATE` over repeated `PROMOTE_NEW`
- should remain small and high-signal

Examples:
- "The user prefers Chinese for explanations"
- "This repository uses pnpm"
- "OpenCode on Windows should be invoked via .cmd"

### 5.2 Collection Channel

Use for reusable but unbounded long-term entries such as:
- reusable engineering经验
- rules of thumb
- stable constraints
- process summaries
- decision summaries

Behavior:
- append with dedupe
- entries may coexist
- archive or invalidate when outdated

Examples:
- "For this monorepo, tests usually require generated schema first"
- "In this project, adapter debugging is easier through OpenCode before Claude Code"

### 5.3 Channel Classification in V1.1

V1.1 should use rule-based classification, not LLM classification.

Recommended field:

```ts
channel: "profile" | "collection"
```

Recommended V1.1 rules:
- stable user preference -> `profile`
- stable project/workspace convention -> `profile`
- reusable procedure/constraint/experience -> `collection`
- decision summary -> `collection`
- anything strongly tied to one task only -> remain `experience`, do not promote

V1.2 may replace or augment this with LLM-based classification.

---

## 6. Promotion Actions

The promotion engine should emit one of these actions:

- `NONE`
- `ADD_CANDIDATE`
- `PROMOTE_NEW`
- `PROMOTE_UPDATE`
- `PROMOTE_INVALIDATE`
- `PROMOTE_ARCHIVE`

### 6.1 `NONE`

Meaning:
- do nothing
- the candidate remains only in experience memory or is discarded later

Typical reasons:
- too task-specific
- too weakly supported
- low reuse value
- low novelty

### 6.2 `ADD_CANDIDATE`

Meaning:
- keep the item as a promotion candidate, but do not make it active long-term memory yet

Typical reasons:
- promising but insufficient evidence
- possibly stable, but not yet proven

### 6.3 `PROMOTE_NEW`

Meaning:
- create a new active long-term memory entry

Typical reasons:
- highly reusable
- semantically novel
- stable enough
- no strong matching existing entry

### 6.4 `PROMOTE_UPDATE`

Meaning:
- update an existing long-term entry instead of creating a new one

Typical reasons:
- profile-like memory with same semantic key
- near-duplicate collection entry with better evidence or newer wording
- corrected or enriched version of an existing long-term item

### 6.5 `PROMOTE_INVALIDATE`

Meaning:
- mark an existing long-term entry as superseded or no longer valid, then create or activate a newer replacement

Typical reasons:
- the new evidence contradicts a stable existing item
- the previous long-term fact or preference is no longer valid

### 6.6 `PROMOTE_ARCHIVE`

Meaning:
- retire an existing long-term entry without treating it as logically false

Typical reasons:
- no longer useful
- outdated convention
- low reuse over time

---

## 7. Novelty Filtering

Novelty filtering is the first gate before admission scoring.

Pipeline:

1. take an `experience candidate`
2. search similar long-term memory entries
3. compare candidate to top similar matches
4. decide whether the candidate is likely:
   - genuinely new
   - better treated as an update
   - too similar to justify insertion

Why this gate is required:
- prevents over-insertion
- reduces semantic duplicates
- keeps collection channel clean

### 7.1 V1.1 Novelty Gate

V1.1 should use embedding-based similarity search against long-term memory.

Suggested behavior:
- `profile` candidates always search for similar existing entries
- `collection` candidates search if they meet minimum `importance` or `confidence` thresholds

Suggested interpretation:
- high similarity -> prefer `PROMOTE_UPDATE` or `NONE`
- medium similarity -> candidate may still be useful if evidence is stronger or wording is materially better
- low similarity -> candidate is eligible for `PROMOTE_NEW`

The exact threshold should remain implementation-tunable rather than hard-coded in the spec.

---

## 8. Admission Scoring

After novelty filtering, the promotion engine computes an admission score.

Recommended formula:

```ts
admissionScore =
  futureUtility    * 0.30 +
  evidenceStrength * 0.25 +
  semanticNovelty  * 0.20 +
  importance       * 0.15 +
  confidence       * 0.10
```

### 8.1 Score Dimensions

#### `futureUtility`

Question:
- is this likely to help future tasks or future sessions?

Examples of high score:
- stable preference
- repeatable engineering rule
- reusable project convention

#### `evidenceStrength`

Question:
- how strongly is this supported by independent evidence?

Examples of higher evidence:
- repeated across runs
- repeated across tasks
- cited by summaries or artifacts
- explicitly confirmed by user

#### `semanticNovelty`

Question:
- how different is this from existing long-term memory?

Higher novelty means:
- adds genuinely new long-term value
- is not just another paraphrase of what is already stored

#### `importance`

Question:
- how important is this candidate according to extraction-time scoring?

This can reuse existing `MemoryRecord.importance` semantics.

#### `confidence`

Question:
- how confident are we that the candidate is valid?

This can reuse existing `MemoryRecord.confidence` semantics.

### 8.2 V1.1 Thresholds

Recommended V1.1 thresholds:

- `admissionScore >= 0.65` -> `PROMOTE_NEW` or `PROMOTE_UPDATE`
- `0.40 <= admissionScore < 0.65` -> `ADD_CANDIDATE`
- `admissionScore < 0.40` -> `NONE`

These thresholds should remain configurable.

---

## 9. Fast Path for User Confirmation

Certain user actions should bypass normal conservative promotion.

Fast-path triggers:
- explicit user preference statement
- explicit user correction
- explicit user instruction to remember something

Examples:
- "以后都用中文回答"
- "不是 Redis，是 PostgreSQL"
- "记住这个项目统一用 pnpm"

Fast-path behavior:
- classify channel
- search for similar long-term entries
- choose `PROMOTE_NEW`, `PROMOTE_UPDATE`, or `PROMOTE_INVALIDATE`
- do not wait for `task.completed`

This should still respect update and invalidation semantics.

---

## 10. Decision Table

### 10.1 High-Level Table

| Situation | Channel | Novelty | Score | Recommended Action |
| --- | --- | --- | --- | --- |
| Task-specific workaround | collection-like content | any | low | `NONE` |
| Reusable but weakly supported insight | collection | medium/high | medium | `ADD_CANDIDATE` |
| Stable new engineering rule | collection | high | high | `PROMOTE_NEW` |
| Better version of existing rule | collection | low/medium | high | `PROMOTE_UPDATE` |
| Stable user preference | profile | medium/high | high | `PROMOTE_NEW` or `PROMOTE_UPDATE` |
| Correction of existing preference/fact | profile | medium | high | `PROMOTE_INVALIDATE` + replacement |
| Stale long-term item with low reuse | either | n/a | n/a | `PROMOTE_ARCHIVE` |

### 10.2 Channel-Specific Default Behavior

| Channel | Default Write Mode | Typical Action Bias |
| --- | --- | --- |
| `profile` | upsert-by-key | update / invalidate |
| `collection` | append-with-dedupe | new / archive / invalidate |

---

## 11. Conflict Handling

V1.1 should not introduce a heavy conflict workflow.

Recommended simplification:
- if the new candidate clearly replaces an old long-term item -> `PROMOTE_INVALIDATE` old + promote new
- if the new candidate mildly refines an old long-term item -> `PROMOTE_UPDATE`
- only user-confirmed memory that is later challenged should require a review flag

This avoids building a permanent unresolved conflict queue too early.

---

## 12. V1.1 Implementation Guidance

V1.1 should include:
- run-level candidate extraction
- task-level promotion consolidation
- `profile` and `collection` channels
- novelty filtering
- admission scoring
- support for `new`, `update`, `invalidate`, `archive`

V1.1 should avoid:
- LLM-based channel classification
- fully general conflict workflow
- promotion on every run boundary
- overly aggressive automatic long-term insertion

---

## 13. Relationship to Other Docs

This document should be read together with:
- `docs/design-discussion-log.md`
- `docs/memory-strategy.md`
- `docs/context-platform-sdk-design.md`

This document is intended to become the basis for:
- `MemoryRecord` schema refinement
- `MemoryEngine` SPI refinement
- memory-related testing strategy
