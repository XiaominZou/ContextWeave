# Session Graph and Context Pruning

## 1. Purpose

This document defines the agreed direction for:

- session organization beyond the canonical event timeline
- the dual-layer graph used for context retrieval and pruning
- session-level consolidation after a session is completed
- the relationship between session graph retrieval and memory retrieval

This document complements:

- `docs/architecture.md`
- `docs/context-platform-sdk-design.md`
- `docs/memory-strategy.md`
- `docs/memory-promotion-rules.md`
- `docs/design-discussion-log.md`

The goal is to make context loading precise and token-efficient without requiring an extra LLM call during every run start.

## 2. Core Direction

The platform should use this model:

> canonical truth stays as a layered timeline; the session graph is a derived dual-layer retrieval index.

This means:

- `Session`, `Task`, `Run`, `Event`, `Message`, and raw tool output remain the canonical source of truth
- the graph is not the primary persistence model
- the graph exists to support context selection, pruning, and compression
- graph objects must stay lighter than raw events and easier to rank than a pure timeline

## 3. Why Not Tree or Full DAG

A pure tree is too rigid:

- cross-task reuse is awkward
- shared artifacts or decisions do not fit cleanly
- pruning becomes overly structural and not relevance-aware

A full DAG as canonical truth is too heavy:

- every tool call would be tempted to become a first-class node
- graph size would grow too quickly
- ingestion, traversal, and mutation cost would rise before the context engine is stable

A pure timeline is also insufficient:

- recency alone is too weak for relevance
- older but important decisions are hard to recover precisely
- noisy tool output is difficult to prune cheaply

The compromise is:

- timeline for truth
- summaries and refs for compression
- graph indexes for selective retrieval

## 4. Dual-Layer Graph Model

### 4.1 Layer A: Structural Graph

Structural nodes are coarse-grained and stable.

Recommended node classes:

- `SessionNode`
- `TaskNode`
- `RunNode`
- `RunSummaryNode`
- `TaskSummaryNode`
- `SessionSummaryNode`
- `ArtifactRefNode`
- `DecisionRefNode`
- `ConstraintRefNode`
- `MemoryRefNode`

Recommended edge classes:

- `contains`
- `depends_on`
- `produced`
- `references`
- `supports`
- `supersedes`

This layer is optimized for:

- task dependency expansion
- summary-first retrieval
- artifact and decision tracing
- session-level consolidation

### 4.2 Layer B: Evidence Graph

Evidence nodes are lightweight references to expensive or noisy material.

Recommended node classes:

- `MessageSpanRef`
- `ToolCallRef`
- `ToolResultRef`
- `ArtifactSliceRef`

These are not heavyweight canonical entities.
They are compressed references that let the runtime choose one of three retention levels:

- `drop`
- `summary-only`
- `expand`

This layer is optimized for:

- fine-grained pruning
- keeping raw detail out of most prompts
- expanding evidence only when a current task truly depends on it

## 5. Graph Build Lifecycle

The graph should be built incrementally.
It should not be recomputed from scratch at every `runs.start()`.

### 5.1 During Run Execution

Persist canonical timeline data only:

- raw events
- normalized events
- messages
- tool calls
- tool results
- artifact references

No heavy graph reasoning is required on the hot path.

### 5.2 On `run.completed`

Create run-derived index objects:

- `RunSummaryNode`
- selected `ToolCallRef`
- selected `DecisionRefNode`
- selected `ConstraintRefNode`
- candidate `MemoryRefNode`

This is the right place to summarize noisy run detail into queryable refs.

### 5.3 On `task.completed`

Create task-level consolidation objects:

- `TaskSummaryNode`
- task-level decisions and constraints
- promoted or archived task-level memory refs
- dependency links to upstream tasks or artifacts

This is also the primary promotion boundary for `experience -> long_term` memory in V1.1.

### 5.4 On `session.completed`

Create session-level consolidation objects:

- `SessionSummaryNode`
- cross-task decision index
- cross-task constraint index
- cross-task reusable procedure and preference candidates

This stage should not dump the whole session into one giant memory record.
Its job is to distill stable cross-task signals and route them into the right memory layer or knowledge source.

## 6. Tool Call Indexing Rules

Tool calls should not all become graph nodes.
Only tool calls that materially affect future context should produce `ToolCallRef` objects.

Recommended rule-based inclusion signals:

- the tool output was referenced by a later assistant message
- the tool produced an artifact or file change
- the tool result changed the task direction or decision
- the tool output is large and benefits from a summary surrogate
- the tool failed in a way that created a reusable constraint

Low-value tool calls should remain only in the timeline.

## 7. Retrieval and Pruning Pipeline

Context loading should not ask, "is this whole past segment relevant?"
It should ask, "from the current focus, which nodes deserve what retention level?"

### 7.1 Focus Anchor

Every retrieval pass starts with an anchor:

- `workspaceId`
- `sessionId`
- current `taskId`
- current `runId`
- task objective
- prompt text
- explicitly referenced files, artifacts, or decisions

### 7.2 Hard Recall

Always include:

- current task
- current task summary when available
- current run summary when available
- active constraints and decisions linked to the task
- direct task dependencies
- explicitly referenced artifacts or files

### 7.3 Graph Expansion

Then expand outward by a small hop budget.

Recommended defaults:

- 0 hops: current task and its direct refs
- 1 hop: dependency tasks, produced artifacts, linked decisions
- 2 hops: selected supporting evidence only when budget allows

The default should be shallow expansion.

### 7.4 Memory Retrieval

Memory retrieval runs alongside graph retrieval, not instead of it.

Recommended behavior:

- use the same anchor to retrieve `long_term` memory
- add memory hits as `MemoryRefNode` candidates
- merge them with graph candidates before pruning
- never treat memory as the only source of relevance

### 7.5 Retention Decision

Each candidate receives one retention action:

- `drop`
- `summary-only`
- `expand`

The default should be `summary-only`, not `expand`.
Raw detail should be the exception.

## 8. Practical Relevance Scoring

A full learned reranker is optional later.
The first stable version should use a transparent score.

Recommended score components:

- `focusMatch`: direct match with current task, prompt, or explicit refs
- `graphProximity`: distance from current task and dependency chain
- `freshness`: recency with decay
- `evidenceValue`: whether the node is a summary, decision, constraint, artifact, or noisy evidence
- `memorySupport`: whether relevant long-term memory points at the same topic
- `statusPenalty`: invalidated, archived, expired, or superseded nodes lose score

Recommended interpretation:

- current-task summaries and active constraints usually win
- dependency-task summaries come next
- memory hits help rescue older but still-relevant conclusions
- raw tool output expands only when directly required

## 9. Irrelevance Rules

The runtime should treat a candidate as effectively irrelevant when all of these are true:

- it is outside the current task and dependency chain
- it is not explicitly referenced by the prompt, artifact, or memory hit set
- it has not been recently reused
- it is low-value evidence rather than a summary, decision, or constraint
- it has been superseded, invalidated, or archived

This should be implemented as a score and policy threshold, not as an opaque yes/no classifier.

## 10. Rendering Strategy

The graph is not rendered directly.
It produces a ranked set of `ContextBlock` candidates.

Recommended rendering order:

1. system and adapter-fixed prompt
2. stable profile and workspace constraints
3. current task summary and direct task context
4. dependency summaries and linked decisions
5. selected memory hits
6. selected evidence expansions
7. recent message history
8. current user input

This keeps structure stable and avoids burying high-value constraints in the middle of noisy context.

## 11. Session Completion and Memory Consolidation

`session.completed` should become a distinct consolidation boundary.
It serves a different purpose from `run.completed` and `task.completed`.

### 11.1 `run.completed`

Primary output:

- `experience` candidates
- run-level summaries
- run-level refs

### 11.2 `task.completed`

Primary output:

- task-level summaries
- task-level promotion evaluation
- `experience -> long_term` decisions for task-bounded patterns

### 11.3 `session.completed`

Primary output:

- `SessionSummaryNode`
- cross-task reusable procedures
- cross-task stable preferences
- repeated constraints that survived across tasks
- session-scoped experience that should remain visible within follow-up work

This stage should not blindly promote everything to `long_term`.
It should separate outputs into:

- `session`-scope `experience`
- `user` or `workspace` scope `long_term`
- external `knowledge source` material

## 12. Memory Relationship

The graph and memory system are related but not identical.

- graph nodes organize session-local relevance
- `experience memory` stores reusable learned context from runs, tasks, and sessions
- `long_term memory` stores stable promoted knowledge
- `knowledge source` remains external and does not participate in promotion

Recommended conversion path:

- run evidence -> `experience`
- repeated task pattern -> candidate for `long_term`
- repeated session-wide pattern -> stronger candidate for `long_term`
- large static deliverable or document -> `knowledge source`

## 13. Version Direction

### 13.1 Current Implemented Baseline

Current code already has:

- canonical timeline ownership
- `ContextSnapshot` assembly
- collector-based context sources for session preload, task, task summary, dependency task summary, prior run summaries, session summary, and memory hits
- `memory=platform` pre-run retrieval
- session-level profile preload cache
- `run.completed` experience extraction
- rule-based `RunSummary` generation
- minimal `ToolCallRef` generation for `isError || hasArtifact`
- rule-based `TaskSummary` generation on `task.completed`
- rule-based `SessionSummary` generation on `sessions.archive()`
- automatic settled-session consolidation while the session remains `active`
- minimal run/task/session graph index metadata persisted on derived entities
- graph-aware candidate scoring with `drop | summary-only | expand` retention decisions during snapshot assembly
- `task.completed` memory consolidation
- session archive consolidation into session-scope experience memory

Current code does not yet have:

- a standalone persisted dual-layer session graph store and graph-aware cross-session query expansion
- graph-aware evidence expansion beyond summary-first blocks
- richer automatic `session.completed` workflows beyond the current settled-session heuristic and explicit archive boundary

### 13.2 Next Implementation Slice

The next architecture-complete slice should add:

1. a standalone persisted session graph store only when graph consumers need cross-session query support
2. graph-aware evidence expansion beyond the current summary-first rendering
3. richer cross-session query expansion and ranking on top of the current metadata indexes
4. a richer automatic session-finish workflow beyond the current settled-session heuristic and explicit `sessions.archive()` boundary

## 14. Final Principle

The session graph should help the platform answer one question cheaply and consistently:

> for this run, which prior session knowledge deserves raw detail, which deserves only a summary, and which should stay out entirely?

That is the real purpose of the graph.
It is a retrieval and pruning structure, not a replacement for the canonical timeline.


