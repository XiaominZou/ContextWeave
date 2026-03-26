# Context Platform Architecture

## 1. Goal

This document explains how the Context Platform is structured at runtime and how requests flow through the system.

It is aligned with:

- `docs/context-platform-sdk-design.md`
- `docs/testing-strategy.md`
- `docs/session-graph-and-context-pruning.md`
- `docs/adapter-support-matrix.md`
- `docs/transparent-runtime-integration.md`
- `docs/opencode-transparent-integration-assessment.md`

The architecture is centered on four invariants:

- The platform always owns canonical `Session`, `Task`, and `Run`
- Business code enters execution only through `RunAPI`
- Adapters are internal runtime components, not business-facing SDK objects
- Event capture is unconditional regardless of capability mode


## 2. System Overview

```text
Business Application
  -> @ctx/client
     -> SessionAPI / TaskAPI / RunAPI / EventAPI / experimental{...}
        -> CapabilityRouter
           -> Platform runtime
              -> AdapterRegistry (internal)
              -> Event pipeline
              -> Store layer
              -> Optional capability engines
```

High-level data flow:

```text
Business App
  -> client.runs.start()
     -> resolve policy
     -> validate policy and adapter support
     -> optionally preload stable user-profile memory when identity exists
     -> build context if enabled
     -> retrieve task-relevant memory when memory=platform
     -> render adapter payload
     -> create adapter run
     -> capture, normalize, store, and emit events
     -> auto-close run on terminal event
      -> optionally extract memory asynchronously after completion
```

### 2.1 Agent-First Target Topology

The product target for transparent runtime integration is not only
`platform -> agent`.

For OpenCode and OpenClaw, the intended user-facing topology is:

```text
                                User
                                 |
                +----------------+----------------+
                |                                 |
                v                                 v
         +--------------+                  +--------------+
         | OpenCode CLI |                  | OpenClaw CLI |
         | / UI / Hooks |                  | / UI / Hooks |
         +------+-------+                  +------+-------+
                |                                 |
                | native user turn / runtime state|
                +----------------+----------------+
                                 |
                                 v
              +-------------------------------------------+
              | Agent Hook / Bridge Layer                 |
              |-------------------------------------------|
              | - runtime plugin / hook                   |
              | - attach workspace and native session ref |
              | - send current turn to platform           |
              | - receive platform-owned context          |
              +-------------------+-----------------------+
                                  |
                                  v
              +-------------------------------------------+
              | Context Platform Gateway                  |
              |-------------------------------------------|
              | - ingress for agent-originated requests   |
              | - bind workspace / session / task / run   |
              | - accept post-turn messages and events    |
              | - return assembled context before turn    |
              +-------------------+-----------------------+
                                  |
                                  v
              +-------------------------------------------+
              | Context Platform Core                     |
              |-------------------------------------------|
              | - canonical Session / Task / Run          |
              | - context assembly                        |
              | - memory retrieval and consolidation      |
              | - summaries / graph / pruning             |
              | - artifacts / checkpoints / audit trail   |
              +-------------------+-----------------------+
                                  |
                                  v
                platform-owned context back into agent turn
```

This means the CLI remains the user entry point, while the platform becomes
the context control plane behind both agent runtimes.

### 2.2 Ownership Split In The Target Shape

In this target shape:

- OpenCode and OpenClaw still own native model execution and native UX
- the platform owns canonical `Session`, `Task`, `Run`, memory, and context assembly
- hooks and bridge layers are transport surfaces, not canonical storage
- native runtime session/todo/history may remain runtime-local mirrors until a deeper takeover exists


## 3. Main Components

### 3.1 `@ctx/client`

Business-facing SDK.

Responsibilities:

- expose `SessionAPI`, `TaskAPI`, `RunAPI`, `EventAPI`
- expose `experimental.memory/context/artifacts` for not-yet-stable features
- hide adapter internals from application code
- drive execution through `RunAPI.start()`

### 3.2 CapabilityRouter

Internal orchestration component inside the client/runtime boundary.

Responsibilities:

- resolve effective `CapabilityPolicy`
- validate policy conflicts
- validate requested modes against adapter capability support
- route to platform-owned capability handlers when enabled
- otherwise stay passive and let the agent behave natively

### 3.3 Platform Runtime

Internal execution layer.

Responsibilities:

- own the adapter registry
- instantiate runs
- start and manage the event pipeline
- update canonical run state
- expose an internal bootstrap surface for runtime registration

Example internal shape:

```ts
interface PlatformRuntime {
  adapters: AdapterRegistryAPI;
  stores: PlatformStores;
  eventPipeline: EventPipeline;
}
```

### 3.4 Adapters

Runtime-specific integration modules.

The architecture now distinguishes two adapter classes:

- `black-box adapters`: spawn or call a runtime externally, observe events, and apply only limited interception
- `transparent runtime adapters`: integrate at the runtime context plane and transparently hand context ownership to the platform

This distinction is central to the product goal described in [Transparent Runtime Integration](/e:/vibecoding/sdk/V1/docs/transparent-runtime-integration.md). MCP or tool bridges are supplemental mechanisms, not the primary architecture for transparent ownership.

Current target adapters:

- `adapter-openclaw`
- `adapter-claude-code`
- `adapter-opencode`

Responsibilities:

- render adapter-specific payloads
- create native runs
- normalize raw runtime events
- expose capability support declarations

Non-responsibilities:

- canonical session/task/run ownership
- business semantics
- platform policy decisions

### 3.5 Store Layer

Persistence layer for canonical state and large blobs.

Recommended split:

- PostgreSQL for canonical entities and transactional metadata
- Object store for raw events, checkpoints, and large artifacts
- Redis for optional hot cache / transient state
- Vector store or pgvector for semantic memory in later phases

### 3.6 Optional Capability Engines

These are introduced incrementally.

- `@ctx/context-engine` in V1.1
- `@ctx/memory` in V1.1+

They are behind capability modes and must not be required for the V1 run pipeline to work.

### 3.7 Session Organization and Context Pruning

The canonical session truth remains time-oriented:

- session
- task
- run
- normalized events
- messages
- tool calls and tool results

Context pruning should not mutate or replace that timeline.
Instead, the platform should maintain a derived retrieval structure defined in
`docs/session-graph-and-context-pruning.md`.

The agreed direction is:

- canonical truth stays as a layered timeline
- a dual-layer graph is derived for retrieval and pruning
- summaries and lightweight refs are preferred over raw expansion
- context loading decides `drop`, `summary-only`, or `expand` per candidate

This keeps auditability simple while still enabling token-efficient context assembly.


## 4. Canonical Control Plane

The platform control plane starts at `RunAPI.start()`.

### 4.1 `runs.start()` Runtime Flow

```text
1. Validate input references (workspace/session/task/adapter)
2. Create canonical Run record in queued state
3. Resolve effective CapabilityPolicy
4. Validate policy semantics
5. Validate adapter capability support
6. If requested feature is not enabled in this version, fail with NOT_ENABLED
7. If context mode requires it, build ContextSnapshot
8. Render adapter payload
9. Create adapter run
10. Update Run to running and attach externalRef
11. Start background event pipeline
12. Return RunHandle to the business layer
```

### 4.2 Failure Before Adapter Invocation

The following failures happen before the adapter is invoked:

- `POLICY_CONFLICT`
- `CAPABILITY_NOT_SUPPORTED`
- `NOT_ENABLED`
- adapter not found / adapter unavailable during bootstrap resolution

Current architecture assumption:

- a canonical `Run` record may still be created before start
- if validation fails, the run is marked failed-before-start in canonical storage
- no external run is created in the agent runtime

This must remain consistent with the SDK design and tests.

### 4.3 RunHandle

The business layer receives a `RunHandle`, not an adapter handle.

```ts
interface RunHandle {
  runId: string;
  externalRef?: string;
  streamEvents(): AsyncIterable<AgentEventEnvelope>;
  interrupt(): Promise<void>;
  checkpoint(): Promise<Checkpoint>; // V2
}
```

The business layer never calls adapter methods directly.


## 5. Data Plane and Event Pipeline

The event pipeline is the core runtime loop.

### 5.1 Principle

Adapters produce raw runtime events. The platform normalizes them, stores them, and emits canonical events to the business layer.

```text
raw runtime event
  -> adapter.normalizeEvent(raw)
  -> canonical event envelope
  -> schema validation
  -> persistence
  -> RunHandle.streamEvents()
```

### 5.2 Event Pipeline Stages

```text
1. receive raw event from adapter stream
2. preserve raw event reference when configured
3. normalize to canonical event
4. validate envelope and payload
5. persist event to run_events
6. derive side effects if needed
7. emit canonical event to RunHandle subscribers
8. update run terminal state when terminal event is observed
```

### 5.3 Side Effects Triggered by Events

Depending on capability modes and version support, the pipeline may also:

- append normalized messages
- create artifact records
- record usage
- update `externalRef`
- transition run state to `completed`, `failed`, or `cancelled`

### 5.4 Terminal State Ownership

Run completion is owned by the platform runtime.

That means:

- business code does not call `complete()` or `fail()` on runs
- terminal state is inferred from terminal events or terminal stream failure
- if the stream fails unexpectedly without a terminal event, the platform must close the run as `failed`


## 6. Capability Routing Model

The platform owns all canonical entities, but capability behavior is incremental.

### 6.1 Effective Policy Resolution

```text
Run.capabilityPolicy
  > AgentProfile.capabilityPolicy
  > defaultCapabilityPolicy
```

### 6.2 Context Capability

Modes:

- `native`
- `inject`
- `replace`

Runtime meaning:

- `native`: no snapshot built, agent manages its own context
- `inject`: platform builds snapshot and prepends platform content
- `replace`: platform builds snapshot and fully owns the sent context

Current implemented baseline:

- `native`, `inject`, and `replace` are active
- `buildContextSnapshot()` currently uses a collector pipeline over task context, task summary, prior run summaries, and memory hits

### 6.3 Memory Capability

Modes:

- `off`
- `tool-bridge`
- `platform`

Runtime meaning:

- `off`: observe only
- `tool-bridge`: expose platform memory tools at runtime as a pure on-demand path; do not pre-inject memory in this mode
- `platform`: retrieve task-relevant memory before execution, and asynchronously extract candidate memory after completion

Constraints:

- `memory=platform` requires `context=inject|replace`
- long-term memory write-back must occur after run completion, not during the same retrieval cycle
- violating that yields `POLICY_CONFLICT`

Current implemented baseline:

- `off`, `tool-bridge`, and `platform` are active
- `tool-bridge` now ships a minimal executable path: the runtime starts a local bridge host, CLI adapters receive MCP server wiring, and SDK adapters can reuse the same tool executor semantics
- `platform` currently supports session-level profile preload, pre-run retrieval, post-run extraction, task-level consolidation, and session archive consolidation

Detailed timing, caching, and dedupe policy are defined in `docs/memory-strategy.md`.

### 6.4 Tasks Capability

Modes:

- `observe-native`
- `mirror-native`
- `platform-tools`

Runtime meaning:

- `observe-native`: record native task-related events only
- `mirror-native`: mirror native task state into canonical task state
- `platform-tools`: replace native task tooling with platform tools

In V1:

- `observe-native` is the active baseline
- `mirror-native` is active through native todo tool result mirroring into task metadata and conservative task-status sync
- `platform-tools` is active through task bridge tools

### 6.5 Artifacts Capability

Modes:

- `observe`
- `capture-store`

Runtime meaning:

- `observe`: record artifact events and references
- `capture-store`: persist normalized `Artifact` records and expose them through the experimental artifact API

Current implemented baseline:

- `observe` emits artifact events and references when tool outputs expose artifact-like payloads
- `capture-store` persists normalized artifact records from tool results and keeps the richer API surface under `experimental`

### 6.6 Capability Support vs Policy

Policy expresses what the platform wants to do.
Adapter capability support expresses what the runtime can actually intercept.

If policy asks for interception but adapter says `observe-only`, the platform must fail fast with `CAPABILITY_NOT_SUPPORTED`.

The platform must never silently downgrade requested modes.


## 7. Adapter Invocation Modes

The architecture supports multiple invocation modes.

### 7.1 SDK Mode

Used by OpenClaw.

Characteristics:

- direct SDK or HTTP integration
- full control of system prompt, messages, and tool schema
- raw events typically come from SSE or SDK stream callbacks

Payload shape:

```ts
interface SdkAdapterPayload {
  mode: 'sdk';
  systemPrompt: string;
  messages: CanonicalMessage[];
  tools?: ToolSchema[];
}
```

### 7.2 CLI Process Mode

Used by Claude Code and OpenCode.

Characteristics:

- spawn CLI process
- capture stream-json output
- use hooks and MCP for interception and tool bridging

Payload shape:

```ts
interface CliAdapterPayload {
  mode: 'cli-process';
  argv: string[];
  env: Record<string, string>;
  stdin?: string;
  configFileInjection?: string;
  mcpServers?: McpServerConfig[];
}
```

### 7.3 HTTP SSE Mode

Reserved for runtimes that want direct HTTP event streams without a full SDK wrapper.

```ts
interface HttpSseAdapterPayload {
  mode: 'http-sse';
  url: string;
  body: unknown;
  headers: Record<string, string>;
}
```


## 8. Runtime-Specific Notes

### 8.1 OpenClaw

Best first adapter because it has the least infrastructure noise.

Architecture fit:

- no process lifecycle complexity
- no hook bridge required
- easiest environment to validate run lifecycle and event pipeline

### 8.2 Claude Code

Architecture fit:

- CLI process adapter
- needs stream-json ingestion
- can later use hooks for task mirroring and artifact capture
- can later use MCP for tool bridging

### 8.3 OpenCode

Current bootstrap fit:

- CLI-process black-box adapter for baseline lifecycle validation
- own raw event fixtures and own contract tests
- should not reuse Claude Code fixtures blindly

Target transparent-fit judgment:

- likely not solvable by prompt injection or tool exposure alone
- likely requires `server-host` integration or a source-level patch/fork if the product goal is transparent context ownership
- should now be evaluated using the decision framework in [Transparent Runtime Integration](/e:/vibecoding/sdk/V1/docs/transparent-runtime-integration.md)


## 9. Persistence Model

### 9.1 Canonical Tables

Recommended canonical relational tables:

- `workspaces`
- `agent_profiles`
- `sessions`
- `tasks`
- `runs`
- `messages`
- `memory_records`
- `memory_links`
- `artifacts`
- `checkpoints`
- `context_policies`
- `context_snapshots`
- `context_snapshot_blocks`
- `run_events`
- `run_event_raw_refs`

### 9.2 Event Persistence Split

```text
canonical normalized events -> PostgreSQL
raw event blobs            -> Object Store
```

### 9.3 Why Raw Event Preservation Exists

Raw event preservation is needed for:

- debugging bad normalizers
- replay and fixture generation
- adapter migrations
- postmortem analysis


## 10. Package Dependency Model

Recommended dependency direction:

```text
@ctx/core
  <- @ctx/adapter-kit
  <- @ctx/store-postgres
  <- @ctx/client
  <- @ctx/adapter-openclaw
  <- @ctx/adapter-claude-code
  <- @ctx/adapter-opencode

@ctx/context-engine   (V1.1)
@ctx/memory           (V1.1+)
  -> consumed by @ctx/client/runtime when enabled
```

Rules:

- `@ctx/core` must stay dependency-light
- adapters depend on core contracts, not on business code
- business code depends on `@ctx/client`, never on adapter packages
- testing helpers live in `@ctx/testing`


## 11. Version Boundaries

### 11.1 V1

Active architecture:

- canonical entity ownership
- `RunAPI.start()` main path
- internal adapter registry
- event capture and persistence
- `adapter-openclaw`
- passive capability defaults and canonical run lifecycle

Behavioral boundary:

- `context=native` works
- `memory=off` works
- `tasks=observe-native` works as the baseline semantic mode
- `tasks=platform-tools` works through the platform task bridge
- `artifacts=observe` works as the baseline semantic mode
- `artifacts=capture-store` works with normalized artifact-record persistence
- active experimental features default to passive behavior unless explicitly enabled later

### 11.2 V1.1

Added architecture:

- `@ctx/context-engine`
- `ContextSnapshot` build path is active
- `context=inject|replace` are usable
- `memory.search()` / `memory.put()` are active
- `memory=platform` pre-run retrieval becomes functional
- session-level profile preload cache becomes functional
- post-run asynchronous extraction becomes functional
- rule-based `RunSummary`, `TaskSummary`, `SessionSummary`, and minimal `ToolCallRef` generation are active
- explicit `sessions.archive()` remains the explicit archive boundary, and automatic settled-session consolidation is active while sessions stay `active`
- collector-based context assembly is active for preload, task, task-summary, dependency-task-summary, run-summary, session-summary, and memory sources
- minimal run/task/session graph indexes are active in derived metadata
- graph-aware candidate scoring and pruning are active during snapshot assembly
- minimal `memory=tool-bridge` execution is active through the local bridge host + MCP bridge process
- minimal `artifacts=capture-store` is active through normalized artifact record capture and experimental artifact listing
- minimal `tasks=mirror-native` is active through native todo-result mirroring into canonical task metadata
- minimal `tasks=platform-tools` is active through platform task tool schemas, MCP bridge wiring, and canonical task updates

### 11.3 V1.2

Added architecture:

- `adapter-claude-code`
- `adapter-opencode`
- CLI extension events
- task mirroring and platform tools
- standalone session graph store and cross-session query expansion
- full graph-backed retrieval ranking and retention workflows
- richer retrieval ranking and memory promotion workflows

### 11.4 V2

Potential future additions:

- minimal checkpoint creation and resume run flow are active through canonical checkpoint persistence and adapter resume hooks
- memory promotion workflows
- multi-agent decomposition and parent-child orchestration


## 12. Observability and Debuggability

The architecture should make these questions answerable:

- which capability policy was resolved for a run
- why a run failed before adapter invocation
- which adapter created the external run
- what raw event produced a normalized event
- which terminal event closed the run
- what context was injected, when that feature is enabled

Recommended observability primitives:

- run-level logs with `runId`, `adapter`, `externalRef`
- event pipeline counters
- failure reason metrics by `PlatformErrorCode`
- optional raw event replay tooling


## 13. Recommended First Implementation Slice

If implementation starts now, the architecture should be realized in this order:

1. `@ctx/core`
2. `@ctx/adapter-kit`
3. `@ctx/adapter-openclaw`
4. `@ctx/store-postgres`
5. `@ctx/client`
6. `@ctx/testing`
7. `@ctx/context-engine` in V1.1
8. CLI adapters in V1.2

Reason:

- validate the run lifecycle first
- keep the event pipeline real from day one
- let future capabilities plug into a stable control plane instead of reshaping it


## 14. Summary

The architecture is intentionally simple in V1:

- one stable business-facing SDK
- one internal runtime boundary
- one canonical event pipeline
- one first adapter that proves the shape

Everything else is incremental capability adoption on top of that foundation.






