# Transparent Runtime Integration

## 1. Goal

This document defines the integration model for agent runtimes that should transparently delegate context ownership to the Context Platform.

This is the intended architecture for runtimes such as Claude Code, OpenCode, and OpenClaw when the product goal is:

- the agent keeps its own orchestration and model execution experience
- the platform transparently owns session, task, memory, and context lifecycle
- the model does not need to explicitly call tools to obtain core context
- users should experience the platform as the default context plane, not as an optional tool

This document should be read together with:

- [SDK Design](/e:/vibecoding/sdk/V1/docs/context-platform-sdk-design.md)
- [Architecture](/e:/vibecoding/sdk/V1/docs/architecture.md)
- [Session Graph And Context Pruning](/e:/vibecoding/sdk/V1/docs/session-graph-and-context-pruning.md)
- [OpenCode Transparent Integration Assessment](/e:/vibecoding/sdk/V1/docs/opencode-transparent-integration-assessment.md)

## 2. Core Correction

The platform has two very different extension shapes:

1. Tool exposure
2. Transparent runtime interception

Tool exposure includes MCP or runtime tool schemas such as `platform_memory_search` or `platform_task_update`.
This is useful, but it is not the main architecture for the platform.

The main architecture is transparent runtime interception.
That means the platform sits on the context plane around the agent runtime and takes ownership of:

- pre-run context assembly
- history selection and pruning
- memory retrieval timing
- post-run extraction and consolidation
- task and session state synchronization
- artifact, summary, and checkpoint side effects

The model should not be responsible for deciding when to obtain its foundational context.
That responsibility belongs to the platform.

## 3. Context Control Plane

The platform should be treated as an Agent Context Control Plane.

```text
User / Application
  -> Agent Runtime UI or API
     -> Transparent Runtime Adapter
        -> Context Platform
           -> canonical Session / Task / Run
           -> ContextEngine
           -> MemoryEngine
           -> Artifact / Summary / Checkpoint services
        -> Agent Runtime model call / tool loop
```

The adapter is not primarily a tool provider.
It is primarily a transparent control-plane connector.

## 4. Transparent Ownership Model

For a transparent integration, ownership is split like this.

### 4.1 Platform owns

- canonical `Session`, `Task`, `Run`
- pre-model-call context assembly
- memory retrieval, preload, extraction, promotion, and consolidation
- session graph and pruning policy
- canonical task state and session lifecycle
- artifacts, summaries, checkpoints, and audit trail

### 4.2 Agent runtime owns

- model request execution
- tool execution loop
- native UX and interaction shell
- runtime-specific event production
- runtime-specific permissions and safety prompts unless explicitly intercepted later

### 4.3 The model does not own

- deciding which long-term memory should be loaded by default
- deciding how much prior history should be kept in prompt context
- deciding whether session/task state should be persisted canonically

Those are platform concerns.

## 5. Integration Surfaces

A runtime can be transparently integrated only if at least one of these surfaces exists.

### 5.1 Before-model-call interception

A hook or API where the platform can fully determine the effective prompt / message array / system content immediately before the runtime calls the model.

This is the best surface.

Required platform actions at this stage:

- resolve capability policy
- preload stable profile memory if needed
- collect task/session/run candidates
- retrieve memory
- rank and prune
- build final context snapshot
- render final model input

### 5.2 After-model-call / after-run interception

A hook or API where the platform receives normalized run output, tool calls, and terminal state.

Required platform actions at this stage:

- append normalized events
- write summaries and graph indexes
- extract experience memory
- consolidate task and session memory
- mirror task/session state changes
- capture artifacts and checkpoints

### 5.3 State persistence interception

A runtime hook or replaceable storage abstraction for:

- native session state
- todo/task state
- message history
- snapshot/checkpoint state

If available, this lets the platform become the real backing store instead of merely mirroring native state.

## 6. Adapter Classes

The platform should explicitly distinguish two adapter classes.

### 6.1 Black-box runtime adapter

Used when the runtime is mostly opaque.

Examples:

- spawn CLI
- observe stdout events
- optionally inject text into prompt/system input
- mirror task state heuristically

This is useful for validation and bootstrap, but it does not satisfy the final transparent-control-plane goal.

### 6.2 Transparent runtime adapter

Used when the runtime exposes enough hooks or APIs for the platform to control the context plane.

A transparent runtime adapter must support these conceptual steps:

```ts
interface TransparentRuntimeAdapter {
  prepareRun(input: TransparentPrepareInput): Promise<TransparentPreparedRun>;
  startRun(input: TransparentStartInput): Promise<TransparentRunHandle>;
  receiveNativeEvents(runId: string): AsyncIterable<unknown>;
  normalizeEvent(raw: unknown): AgentEventEnvelope | null;
  finalizeRun(input: TransparentFinalizeInput): Promise<void>;
}
```

This interface is conceptual.
It does not have to be the public TypeScript contract yet.
The important point is the lifecycle shape.

## 7. Decision Framework Per Runtime

For each agent runtime, we should answer these questions first.

1. Where is prompt or message assembly performed?
2. Is there a stable before-model-call hook?
3. Is there a stable after-model-call or event stream hook?
4. Where is native session/task/history state stored?
5. Can that state store be replaced, intercepted, or mirrored losslessly?
6. If not, what is the smallest patch or fork point?

Only after these answers are clear should we choose the integration form.

## 8. Runtime Strategy Matrix

### 8.1 OpenClaw

Likely best fit for transparent integration.

Reason:

- SDK/API-shaped runtime
- direct message/system assembly control
- no CLI process wrapper required
- easiest place to let platform own context assembly before model call

Recommended path:

- make OpenClaw the first true transparent runtime adapter
- platform assembles full context
- runtime remains a model execution engine plus tool loop

### 8.2 Claude Code

Likely mid-difficulty.

Reason:

- CLI runtime with hookable surfaces
- potentially interceptable prompt/system injection path
- potentially interceptable todo and artifact hooks
- but still more constrained than a pure SDK runtime

Recommended path:

- first implement as black-box adapter for bootstrap
- then evolve toward hook-based transparent interception
- only use MCP as a supplement, never as the main context path

### 8.3 OpenCode

Likely requires either server-host integration or source patching.

Reason:

- baseline CLI execution is observable
- tool-based bridge path is not enough for transparent ownership
- stable plugin-style transparent context interception is not yet established
- current real validation shows that dynamic tool exposure is not a sufficient basis for platform ownership

Recommended path:

Choose between:

1. Server-host integration
   - use OpenCode server/API as the execution engine
   - let the platform assemble context before every prompt call
   - let the platform own canonical state

2. Source-level patch / fork
   - replace native context assembly with platform calls
   - replace native task/session stores or synchronize them at the source layer

If the product goal is true transparent ownership, OpenCode should not be treated as a mere CLI-process adapter forever.

## 9. MCP and Tools in the Correct Role

MCP and runtime tools still have value, but only as supporting mechanisms.

They are appropriate for:

- explicit memory lookup
- explicit task inspection or mutation
- agent-invoked side actions
- compatibility fallback when transparent interception is not yet available

They are not appropriate as the primary way to provide foundational context.

If the platform depends on the model to remember to call a tool before it can access core context, then the platform has not transparently taken ownership.

## 10. Recommended Platform Refactor

The repository should distinguish these concepts explicitly.

### 10.1 Current code that remains valid

These pieces are still the right foundation:

- canonical `Session / Task / Run`
- memory engine and consolidation rules
- context snapshot assembly
- graph-aware pruning
- artifact capture
- checkpoint and summary flow
- event pipeline

### 10.2 What should be reframed

These should no longer be presented as the main integration model for CLI agents:

- MCP tool bridge as the primary memory/task integration path
- treating prompt injection alone as equivalent to transparent ownership
- assuming all CLI runtimes share the same hooks + MCP pattern

### 10.3 What should be added

The architecture should explicitly describe:

- `black-box adapter` versus `transparent runtime adapter`
- `before-model-call` and `after-model-call` interception as first-class integration surfaces
- `state ownership replacement` as the real end-state for selected runtimes

## 11. Recommended Implementation Order

1. Keep the current black-box adapters for bootstrap validation.
2. Make OpenClaw the first true transparent runtime adapter.
3. Write a runtime-integration assessment for Claude Code and OpenCode.
4. For OpenCode, choose between `server-host` and `fork` before writing more bridge code.
5. Keep MCP-based tool exposure only as a supplement and fallback.

## 12. Summary

The platform's real product direction is transparent context ownership.

That means:

- the platform is the context plane
- the agent runtime is the execution plane
- tool bridges are optional helpers, not the main architecture
- each agent runtime must be integrated based on its true interception surfaces, not forced into the same MCP-first pattern
