# Context Platform SDK Design v3

## 1. Document Goal

This document defines an SDK-first design for a context management platform that sinks common agent context capabilities into a shared infrastructure layer.

The platform targets three production runtimes in V1:

- **Claude Code** -- CLI process, hooks-based event capture, MCP tool injection
- **OpenCode** -- CLI process, hooks-based event capture, MCP tool injection
- **OpenClaw** -- HTTP/SDK, direct Anthropic API control

This design is complemented by `docs/session-graph-and-context-pruning.md` for session organization, graph-aware retrieval, and token-efficient context pruning, and by `docs/transparent-runtime-integration.md` for the transparent takeover model expected for agent runtimes.

The primary design goal:

> Business systems integrate with one stable context SDK. Adapters are internal implementation details. The platform starts as a pure event observer and progressively takes ownership of capabilities. The end-state for selected runtimes is transparent context ownership, not merely tool exposure.


## 2. Design Principles

### 2.1 RunAPI Is the Only Entry Point

Business code never touches adapter internals. `client.runs.start()` returns a `RunHandle`. The platform drives the adapter internally. This keeps the adapter boundary clean.

### 2.2 Event Capture Is Always On

Regardless of which capabilities the platform owns, all agent events are captured and stored. Event capture is unconditional. It is the foundation for every future capability.

### 2.3 Platform Always Owns Canonical Session, Task, and Run

The platform is always the source of truth for Session, Task, and Run records. Adapters maintain an `externalRef` field to map to their native session or conversation ID. There is no mode switch for session ownership.

### 2.4 Per-Capability Delegation, Not Uniform Modes

Each capability has its own delegation strategy with semantics specific to what that capability actually does. A generic three-mode enum does not describe what the platform actually executes at runtime.

### 2.5 `agent-native` Means Observe-Only

When a capability is in its `agent-native` or `off` mode, the platform does exactly two things: captures events and records canonical metadata. It does not call into agent-native APIs, because CLI agents do not expose a unified callable API for their native capabilities.

### 2.6 Adapters Are Thin

Adapters handle runtime invocation, event normalization, and capability interception when delegated by policy. Adapters do not own business semantics.


## 3. Core Domain Model

The platform always owns these entities. No mode switch changes this.

### 3.1 Workspace

Logical tenant or project boundary.

```ts
interface Workspace {
  id: string;        // "ws_..."
  name: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

### 3.2 AgentProfile

Reusable configuration for a class of agent runs. Contains the `CapabilityPolicy` that governs what the platform actively does for each run.

```ts
interface AgentProfile {
  id: string;                         // "prof_..."
  workspaceId: string;
  name: string;
  defaultAdapter: string;             // "claude-code" | "opencode" | "openclaw"
  defaultModel?: string;
  defaultContextPolicyId?: string;
  capabilityPolicy: CapabilityPolicy;
  toolBridge?: ToolBridgeConfig;
  metadata?: Record<string, unknown>;
}
```

### 3.3 Session

A long-lived interaction container. The platform always owns the canonical session record.

```ts
interface Session {
  id: string;           // "sess_..."
  workspaceId: string;
  externalRef?: string; // adapter's native session or conversation ID
  title?: string;
  status: "active" | "paused" | "archived";
  participants?: Array<{ id: string; type: "user" | "agent" | "system" }>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

### 3.4 Task

A goal-oriented execution unit. The platform always owns the canonical task record.

```ts
interface Task {
  id: string;           // "task_..."
  workspaceId: string;
  sessionId: string;
  parentTaskId?: string;
  title: string;
  objective?: string;
  instructions?: string;
  status: "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  priority?: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

### 3.5 Run

A concrete execution attempt on an agent runtime. The platform always owns the canonical run record.

```ts
interface Run {
  id: string;                                    // "run_..."
  workspaceId: string;
  sessionId: string;
  taskId: string;
  adapter: string;
  model?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  attempt: number;
  snapshotId?: string;
  externalRef?: string;                          // adapter's own conversation or run ID
  capabilityPolicy?: Partial<CapabilityPolicy>;  // run-level override
  usage?: { inputTokens?: number; outputTokens?: number };
  startedAt?: string;
  endedAt?: string;
  error?: SerializedError;
  metadata?: Record<string, unknown>;
}
```

### 3.6 Message

A normalized communication unit captured during a run.

```ts
interface Message {
  id: string;
  workspaceId: string;
  sessionId: string;
  taskId?: string;
  runId?: string;
  role: "system" | "user" | "assistant" | "tool" | "platform";
  kind: "text" | "structured" | "tool-call" | "tool-result" | "event-summary";
  content: string;
  parts?: MessagePart[];
  toolCallId?: string;
  artifactRefs?: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}
```

### 3.7 MemoryRecord

A reusable knowledge record.

```ts
interface MemoryRecord {
  id: string;           // "mem_..."
  workspaceId: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;       // required when scope is "run"
  kind: "working" | "episodic" | "semantic" | "procedural";
  scope: "run" | "task" | "session" | "workspace" | "global";
  content: string;
  summary?: string;
  importance?: number;  // 0-1
  confidence?: number;  // 0-1
  sourceRefs?: string[];
  embeddingRef?: string;
  ttl?: number;         // seconds; null means no expiry
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  metadata?: Record<string, unknown>;
}
```

Memory kinds:

- `working` -- short-lived, task-scoped in-flight state
- `episodic` -- what happened; run and session summaries
- `semantic` -- stable facts and extracted knowledge
- `procedural` -- preferences, policies, team conventions

### 3.8 Artifact

A structured output or referenced resource.

```ts
interface Artifact {
  id: string;           // "art_..."
  workspaceId: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  type: string;         // "code-patch" | "file-diff" | "report" | ...
  uri: string;
  mimeType?: string;
  title?: string;
  summary?: string;
  hash?: string;
  size?: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
```

### 3.9 Checkpoint

Resumable runtime state. Opaque to the platform -- only the adapter that created it can interpret it.

```ts
interface Checkpoint {
  id: string;           // "ckpt_..."
  workspaceId: string;
  sessionId: string;
  taskId: string;
  runId: string;
  adapter: string;
  payload: CheckpointPayloadEnvelope;
  createdAt: string;
}

interface CheckpointPayloadEnvelope {
  version: "1";
  adapter: string;
  adapterVersion?: string;
  createdAt: string;
  payload: unknown;     // adapter-specific; opaque to the platform
}
```

### 3.10 ContextPolicy

A reusable strategy for context assembly. Only used when `context` capability is `inject` or `replace`.

```ts
interface ContextPolicy {
  id: string;           // "cpol_..."
  workspaceId: string;
  name: string;
  sources: ContextPolicySource[];
  ranking: ContextPolicyRanking;
  budget: ContextBudget;
  compression?: ContextCompressionConfig;
  redaction?: ContextRedactionConfig;
  createdAt: string;
  updatedAt: string;
}

interface ContextPolicySource {
  kind:
    | "system-prompt"
    | "task"
    | "message-history"
    | "working-memory"
    | "episodic-memory"
    | "semantic-memory"
    | "procedural-memory"
    | "artifact"
    | "checkpoint";
  enabled: boolean;
  maxItems?: number;
  maxTokens?: number;
  priority: number;     // higher = kept first when budget is constrained
}

interface ContextPolicyRanking {
  strategy: "recency" | "importance" | "relevance" | "hybrid";
  weights?: { recency?: number; importance?: number; relevance?: number };
}

interface ContextBudget {
  maxInputTokens: number;
  reserveOutputTokens?: number;
  hardLimit?: boolean;
}
```

### 3.11 ContextSnapshot

The actual context assembled for a run.

```ts
interface ContextSnapshot {
  id: string;           // "ctx_..."
  workspaceId: string;
  sessionId: string;
  taskId?: string;
  policyId?: string;
  blocks: ContextBlock[];
  tokenEstimate: number;
  explanation?: ContextExplanation;
  createdAt: string;
}

interface ContextBlock {
  id: string;
  kind: "system" | "task" | "message" | "memory" | "artifact" | "checkpoint";
  title?: string;
  content: string;
  sourceRef: string;
  score?: number;
  tokenEstimate?: number;
  metadata?: Record<string, unknown>;
}

interface ContextExplanation {
  included: Array<{ blockId: string; reason: string; tokens: number }>;
  excluded: Array<{ sourceRef: string; reason: string }>;
  totalTokens: number;
}
```


## 4. Capability Policy System

The platform owns Session, Task, and Run unconditionally. The capability policy governs what the platform actively does for context, memory, task tooling, and artifacts during a run.

Policy resolution order (highest priority first):

```
Run.capabilityPolicy  >  AgentProfile.capabilityPolicy  >  platform defaults
```

### 4.1 Context Capability

Controls how the platform handles context assembly and injection.

```ts
type ContextMode =
  | "native"    // platform does not assemble context; agent manages its own context window
  | "inject"    // platform builds a ContextSnapshot and prepends it to agent context
  | "replace";  // platform builds a ContextSnapshot and fully replaces agent context
```

What each mode means at runtime:

| Mode | Platform action | Agent context |
|------|----------------|---------------|
| `native` | No ContextSnapshot created. No injection. | Agent decides its own context completely. |
| `inject` | Platform calls `context.build()`, renders blocks as prepended system content. | Agent's own context plus platform injection. |
| `replace` | Platform calls `context.build()`, renders as the full context payload. | Platform context only. |

For CLI adapters, `inject` means prepending to CLAUDE.md or passing via `--system-prompt`.
For SDK adapters, `inject` means prepending blocks to the messages array.

### 4.2 Memory Capability

Controls how the platform interacts with memory during a run.

```ts
type MemoryMode =
  | "off"           // platform captures memory-related events only; no intervention
  | "tool-bridge"   // platform exposes memory tools via MCP; agent can call them optionally
  | "platform";     // platform retrieves selected memory before the run and may write back after completion
```

What each mode means at runtime:

| Mode | Platform action | Agent behavior |
|------|----------------|----------------|
| `off` | Records events only. Does not retrieve or write platform memory. | Agent uses its own native memory completely. |
| `tool-bridge` | Registers `platform_memory_search` and `platform_memory_write` tools via MCP or tool schema. The platform does not pre-inject memory in this mode. | Agent can optionally call platform memory tools on demand. Native memory also available. |
| `platform` | The platform may perform a low-frequency session-level preload for stable user-profile memory when a stable identity exists. Before `runs.start()`, it retrieves selected task-relevant memories and includes them in `ContextSnapshot` when `context` mode is `inject` or `replace`. After `run.completed`, it may asynchronously extract candidate memories for storage or promotion. | Agent receives pre-injected memory context. Native memory may be suppressed depending on adapter implementation. |

Note: `memory: "platform"` requires `context` mode to be `inject` or `replace`.
If this constraint is violated, `runs.start()` must fail with `POLICY_CONFLICT` before the adapter is invoked.
The platform must not silently downgrade the policy.

Note: long-term memory write-back must occur after run completion, not during the same retrieval cycle. The detailed write-after-read constraint, retrieval timing, caching, and promotion policy are defined in [memory-strategy.md](e:/vibecoding/sdk/V1/docs/memory-strategy.md). This design document defines capability boundaries and SDK contracts; the separate memory strategy document defines operational policy.

### 4.3 Tasks Capability

Controls how the platform synchronizes task state with the agent.

```ts
type TasksMode =
  | "observe-native"   // platform records task events; no interference with agent task tools
  | "mirror-native"    // platform watches native task tool calls and mirrors to canonical Task model
  | "platform-tools";  // platform replaces native task tools via MCP; agent uses platform task API
```

What each mode means at runtime:

| Mode | Platform action | Agent task tooling |
|------|----------------|--------------------|
| `observe-native` | Stores events. Claude Code's TodoRead/TodoWrite run normally. | Native task tools untouched. |
| `mirror-native` | Intercepts native task tool results via PostToolUse hook, syncs to canonical Task metadata and task status heuristics. | Native task tools still run; platform mirrors the state. |
| `platform-tools` | Exposes `platform_task_get`, `platform_task_update`, `platform_task_list` via MCP. PreToolUse hook blocks native todo tools. | Agent uses platform task tools only. |

### 4.4 Artifacts Capability

Controls how the platform handles artifacts produced during a run.

```ts
type ArtifactsMode =
  | "observe"         // platform records artifact.created events; does not store artifact content
  | "capture-store";  // V1.1 persists normalized artifact records; later versions may store blob content
```

What each mode means at runtime:

| Mode | Platform action |
|------|----------------|
| `observe` | Emits `artifact.created` event with URI reference only. |
| `capture-store` | V1.1 baseline persists normalized `Artifact` records from tool results; future versions may additionally fetch and store blob content in object storage. |

### 4.5 CapabilityPolicy Type

```ts
interface CapabilityPolicy {
  context:   ContextMode;
  memory:    MemoryMode;
  tasks:     TasksMode;
  artifacts: ArtifactsMode;
}

// Default: platform observes everything, actively does nothing
const defaultCapabilityPolicy: CapabilityPolicy = {
  context:   "native",
  memory:    "off",
  tasks:     "observe-native",
  artifacts: "observe",
};
```

Sessions are excluded from the policy. The platform always owns the canonical Session.

### 4.6 Adapter Capability Support Declaration

Adapters declare what they can intercept vs only observe. If the resolved `CapabilityPolicy` requests a mode that requires interception (e.g., `context: inject`, `tasks: platform-tools`) but the adapter declares `observe-only` for that capability, `runs.start()` must fail with `CAPABILITY_NOT_SUPPORTED`. The platform must not silently downgrade the policy.

```ts
type CapabilityInterceptLevel = "intercept" | "observe-only";

interface AdapterCapabilitySupport {
  context:   CapabilityInterceptLevel;
  memory:    CapabilityInterceptLevel;
  tasks:     CapabilityInterceptLevel;
  artifacts: CapabilityInterceptLevel;
}
```

### 4.7 Tool Bridge

When memory or tasks are in platform-active modes, the platform may need to expose its APIs as tools callable by the agent at runtime.

```ts
interface ToolBridgeConfig {
  exposeMemorySearch:   boolean;
  exposeMemoryWrite:    boolean;
  exposeTaskGet:        boolean;
  exposeTaskUpdate:     boolean;
  exposeArtifactCreate: boolean;
  customTools?: PlatformTool[];
}

interface PlatformTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown, context: RunContext) => Promise<unknown>;
}
```

The adapter intercepts tool calls matching platform tool names and routes them to the platform handler.


## 5. RunAPI as the Only Entry Point

Business code never calls `adapter.createRun()` directly. The platform drives the adapter internally and exposes a `RunHandle` from `runs.start()`.

```ts
interface RunHandle {
  runId: string;
  externalRef?: string;             // adapter's own conversation or run ID, once known
  streamEvents(): AsyncIterable<AgentEventEnvelope>;
  interrupt(): Promise<void>;
  checkpoint(): Promise<Checkpoint>;  // V2: only available when adapter supports checkpoints
}
```

The platform internally:

1. Resolves the capability policy
2. Builds a ContextSnapshot if `context` mode requires it
3. Calls `adapter.renderContext()` to produce the adapter-specific payload
4. Calls `adapter.createRun()` to start the agent
5. Wraps the adapter run handle and starts storing events
6. Returns the `RunHandle` to the business layer

The business layer only interacts with `RunHandle`. It streams events and optionally reacts to them. It never needs to know which adapter is running.


## 6. Standard Event Model

Event capture is always active. All adapters must implement the core event set. Adapter-specific events are extensions and do not affect adapters that do not emit them.

### 6.1 Event Envelope

```ts
interface AgentEventEnvelope<T = unknown> {
  id: string;           // "evt_..."
  workspaceId: string;
  sessionId: string;
  taskId?: string;
  runId: string;
  adapter: string;
  type: string;
  timestamp: string;
  payload: T;
  rawRef?: string;      // reference to raw event in object store
  metadata?: Record<string, unknown>;
}
```

### 6.2 Core Events

All adapters must normalize to these event types.

```ts
type CoreAgentEvent =
  // Run lifecycle
  | { type: "run.started";    payload: { model?: string; externalRef?: string } }
  | { type: "run.completed";  payload: { reason?: string } }
  | { type: "run.failed";     payload: { error: SerializedError } }
  | { type: "run.cancelled";  payload: { reason?: string } }
  | { type: "run.usage";      payload: { inputTokens?: number; outputTokens?: number } }

  // Message events
  | { type: "message.delta";     payload: { role: "assistant"; text: string } }
  | { type: "message.completed"; payload: { messageId: string } }

  // Tool events
  | { type: "tool.call";            payload: { callId: string; name: string; input: unknown } }
  | { type: "tool.result";          payload: { callId: string; output: unknown; isError?: boolean } }
  | { type: "tool.call.streaming";  payload: { callId: string; partialInput: string } }  // all streaming adapters

  // Platform events
  | { type: "artifact.created";   payload: { artifactId: string; type: string } }
  | { type: "checkpoint.created"; payload: { checkpointId: string } }
  | { type: "memory.extracted";   payload: { memoryIds: string[]; runId: string } };
```

### 6.3 Adapter Extension Events

These are emitted by specific adapters and stored as-is. Other adapters are not affected by them.

```ts
// Claude Code and OpenCode CLI extension events
type CliAdapterExtensionEvent =
  | { type: "cli.permission.requested"; payload: { tool: string; input: unknown; riskLevel?: "low" | "medium" | "high" } }
  | { type: "cli.permission.granted";   payload: { tool: string } }
  | { type: "cli.permission.denied";    payload: { tool: string; reason?: string } }
  | { type: "cli.fs.read";              payload: { path: string } }
  | { type: "cli.fs.write";             payload: { path: string; bytes?: number } }
  | { type: "cli.fs.delete";            payload: { path: string } }
  | { type: "cli.process.started";      payload: { pid?: number } }
  | { type: "cli.process.exited";       payload: { code: number; signal?: string } };

type AgentEvent = CoreAgentEvent | CliAdapterExtensionEvent;
```

### 6.4 Raw Event Preservation

- Normalized events go into the `run_events` table.
- Raw adapter events go into the object store, referenced by `rawRef` on the envelope.


## 7. Memory Model

### 7.1 Memory Lifecycle

```
Capture -> Extract -> Classify -> Link -> Store -> Retrieve -> Promote/Decay -> Archive/Expire
```

### 7.2 Memory Kind Semantics

- `working` -- temporary, task-scoped in-flight state; auto-expires after run
- `episodic` -- what happened; derived from run summaries and session history
- `semantic` -- stable facts; good candidate for embedding and retrieval
- `procedural` -- preferences, policies, conventions

### 7.3 Promotion Paths

```
working  ->  episodic
episodic ->  semantic
episodic ->  procedural
```

Promotion is explicit and auditable. No automatic promotion in V1.

### 7.4 Memory Query Model

```ts
interface MemoryQuery {
  workspaceId: string;
  sessionId?: string;
  taskId?: string;
  kinds?: MemoryRecord["kind"][];
  scopes?: MemoryRecord["scope"][];
  text?: string;
  embedding?: number[];
  limit?: number;
  minImportance?: number;
  includeExpired?: boolean;
}
```


## 8. Context Assembly Engine

Only invoked when `context` capability mode is `inject` or `replace`.

### 8.1 Build Pipeline

1. Resolve active ContextPolicy
2. Load candidate sources based on policy source config
3. Normalize each source into a `ContextBlock`
4. Rank candidates
5. Deduplicate
6. Compress where needed
7. Enforce token budget
8. Produce `ContextSnapshot`
9. Persist explanation metadata

### 8.2 Adapter-Aware Rendering

After assembly, the context snapshot is rendered into an adapter-specific payload by the adapter's `renderContext()` method.

```ts
// For SDK adapters (OpenClaw)
interface SdkAdapterPayload {
  mode: "sdk";
  systemPrompt: string;
  messages: CanonicalMessage[];
  tools?: ToolSchema[];
}

// For CLI process adapters (Claude Code, OpenCode)
interface CliAdapterPayload {
  mode: "cli-process";
  argv: string[];
  env: Record<string, string>;
  stdin?: string;
  configFileInjection?: string;   // content prepended to the agent's config file (e.g., CLAUDE.md for Claude Code)
  mcpServers?: McpServerConfig[];
}

// For HTTP SSE adapters
interface HttpSseAdapterPayload {
  mode: "http-sse";
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

type AdapterPayload = SdkAdapterPayload | CliAdapterPayload | HttpSseAdapterPayload;
```


## 9. Adapter SDK

### 9.1 Core Adapter Interface

```ts
interface AgentAdapter {
  readonly name: string;
  readonly version: string;
  readonly invocationMode: "sdk" | "cli-process" | "http-sse";
  readonly capabilities: AdapterCapabilities;

  // Core lifecycle -- called internally by the platform, not by business code
  renderContext(input: RenderContextInput): Promise<AdapterPayload>;
  createRun(input: AdapterRunInput): Promise<AdapterRunHandle>;
  normalizeEvent(rawEvent: unknown): AgentEventEnvelope | null;

  // Optional: checkpoint and resume
  resumeRun?(input: ResumeRunInput): Promise<AdapterRunHandle>;
  createCheckpoint?(runId: string): Promise<Checkpoint>;

  // Optional: credential resolution
  resolveCredentials?(context: WorkspaceContext): Promise<AdapterCredentials>;
}
```

### 9.2 Adapter Capabilities

```ts
interface AdapterCapabilities {
  invocationMode: "sdk" | "cli-process" | "http-sse";
  streaming: boolean;
  toolCalls: boolean;
  checkpoints: boolean;
  resume: boolean;
  interrupt: boolean;
  nativeMcp: boolean;                            // supports MCP server injection
  capabilitySupport: AdapterCapabilitySupport;
}
```

### 9.3 Internal Adapter Run Handle

This is internal to the platform. Business code never sees this type -- they receive a `RunHandle` from `runs.start()`.

```ts
interface AdapterRunHandle {
  externalRef?: string;
  streamEvents(): AsyncIterable<AgentEventEnvelope>;
  cancel(): Promise<void>;
}
```

### 9.4 Credential Management

```ts
interface AdapterCredentials {
  kind: "api-key" | "oauth-token" | "cli-config" | "custom";
  value: unknown;
  expiresAt?: string;
}
```

### 9.5 Adapter Registry

```ts
interface AdapterRegistryAPI {
  register(adapter: AgentAdapter): void;
  get(name: string): AgentAdapter;
  list(): Array<{ name: string; version: string; invocationMode: string }>;
  capabilities(name: string): AdapterCapabilities;
}
```

### 9.6 Native Runtime Mapping

Each adapter must document and test with fixtures:

- native message roles -> canonical roles
- native tool schema -> canonical tool schema
- native events -> standard event types
- native checkpoint format -> `CheckpointPayloadEnvelope`


## 10. Application SDK

### 10.1 Top-Level Client

```ts
interface ContextPlatformClient {
  workspaces: WorkspaceAPI;
  profiles:   AgentProfileAPI;
  sessions:   SessionAPI;
  tasks:      TaskAPI;
  runs:       RunAPI;
  events:     EventAPI;
  experimental?: {
    memory?: MemoryAPI;       // V1.1
    artifacts?: ArtifactAPI;  // V1.1+
    context?: ContextAPI;     // V1.1
  };
}
```

`AdapterRegistryAPI` is an internal platform bootstrap component, not part of the business-facing SDK.
Business code must never access adapters directly. Adapters are registered during platform initialization and are only used by `RunAPI` internally.
### 10.2 Session API

```ts
interface SessionAPI {
  create(input: CreateSessionInput): Promise<Session>;
  get(id: string): Promise<Session>;
  update(id: string, patch: UpdateSessionInput): Promise<Session>;
  archive(id: string): Promise<void>;
  fork(id: string, input?: ForkSessionInput): Promise<Session>;
  list(input: ListSessionsInput): Promise<Paginated<Session>>;
}

interface ForkSessionInput {
  title?: string;
  copyMessages?: boolean | { upToMessageId: string };
  copyTasks?: boolean;
  copyMemories?: boolean;
}
```

### 10.2a Workspace API

```ts
interface WorkspaceAPI {
  create(input: CreateWorkspaceInput): Promise<Workspace>;
  get(id: string): Promise<Workspace>;
  update(id: string, patch: UpdateWorkspaceInput): Promise<Workspace>;
  list(): Promise<Workspace[]>;
}
```

### 10.2b Agent Profile API

```ts
interface AgentProfileAPI {
  create(input: CreateAgentProfileInput): Promise<AgentProfile>;
  get(id: string): Promise<AgentProfile>;
  update(id: string, patch: UpdateAgentProfileInput): Promise<AgentProfile>;
  delete(id: string): Promise<void>;
  list(input: ListAgentProfilesInput): Promise<Paginated<AgentProfile>>;
}
```

### 10.3 Task API

```ts
interface TaskAPI {
  create(input: CreateTaskInput): Promise<Task>;
  get(id: string): Promise<Task>;
  update(id: string, patch: UpdateTaskInput): Promise<Task>;
  complete(id: string, output?: TaskOutput): Promise<Task>;
  fail(id: string, error: TaskError): Promise<Task>;
  list(input: ListTasksInput): Promise<Paginated<Task>>;
  linkMemory(id: string, memoryIds: string[]): Promise<void>;
}
```

### 10.4 Memory API

```ts
interface MemoryAPI {
  put(input: PutMemoryInput): Promise<MemoryRecord>;
  get(id: string): Promise<MemoryRecord>;
  update(id: string, patch: UpdateMemoryInput): Promise<MemoryRecord>;
  search(query: MemoryQuery): Promise<MemorySearchResult>;
  promote(id: string, targetKind: MemoryRecord["kind"]): Promise<MemoryRecord>;
  archive(id: string): Promise<void>;
  extract(input: ExtractMemoryInput): Promise<MemoryRecord[]>;  // V1.1
}

interface ExtractMemoryInput {
  runId?: string;
  messages?: Message[];
  kinds?: MemoryRecord["kind"][];
  model?: string;       // model used for LLM-assisted extraction
  autoLink?: boolean;   // auto-link extracted records to task/session
}
```

### 10.5 Context API

```ts
interface ContextAPI {
  build(input: BuildContextInput): Promise<ContextSnapshot>;    // V1.1
  explain(snapshotId: string): Promise<ContextExplanation>;     // V1.1
  preview(input: BuildContextInput): Promise<ContextPreview>;   // V1.1
}
```

### 10.6 Run API

This is the only run entry point for business code.

```ts
interface RunAPI {
  start(input: StartRunInput): Promise<RunHandle>;    // returns handle; adapter is internal
  get(id: string): Promise<Run>;
  resume(input: ResumeRunInput): Promise<RunHandle>;
  list(input: ListRunsInput): Promise<Paginated<Run>>;
  interrupt(runId: string): Promise<void>;
}

interface StartRunInput {
  workspaceId: string;
  sessionId: string;
  taskId: string;
  adapter: string;
  capabilityPolicy?: Partial<CapabilityPolicy>;  // run-level override
  model?: string;
  metadata?: Record<string, unknown>;
}
```

### 10.7 Event API

```ts
interface EventAPI {
  list(input: ListEventsInput): Promise<Paginated<AgentEventEnvelope>>;
  subscribe(runId: string): AsyncIterable<AgentEventEnvelope>;
  getRaw(eventId: string): Promise<unknown>;
}
```

### 10.8 Artifact API (V1.1)

```ts
interface ArtifactAPI {
  get(id: string): Promise<Artifact>;
  list(input: ListArtifactsInput): Promise<Paginated<Artifact>>;
  delete(id: string): Promise<void>;
}
```
When the adapter event stream ends, the platform transitions the Run to `completed`, `failed`, or `cancelled` based on the terminal event.
Business code must not close runs directly.

## 11. End-to-End Lifecycle

### 11.1 What the Platform Does on `runs.start()`

```
1. Create Run record (status: queued)
2. Resolve effective CapabilityPolicy
3. If context mode is inject or replace: call context.build() -> ContextSnapshot
4. If memory mode is platform: optionally preload stable user-profile memory at session scope when identity is available, then retrieve selected task-relevant memories during context assembly and include them in ContextSnapshot; future graph-aware retrieval should use the session graph index described in `docs/session-graph-and-context-pruning.md`
5. Call adapter.resolveCredentials() if needed
6. Call adapter.renderContext() with ContextSnapshot + policy -> AdapterPayload
7. Call adapter.createRun() with AdapterPayload -> internal AdapterRunHandle
8. Update Run record (status: running, externalRef from handle)
9. Start background event pipeline: adapter.streamEvents() -> normalize -> store -> emit on RunHandle
10. Return RunHandle to business code
11. On stream end: update Run status, emit run.completed or run.failed
12. If memory mode is platform and extraction is enabled: asynchronously extract candidate memories after completion
13. Memory write-back must not race with retrieval in the same run; long-term writes occur only after completion
```

### 11.2 Business Layer Example

```ts
const client = new ContextPlatformClient({ baseUrl: "..." });

// Session and task -- platform always owns these
const session = await client.sessions.create({
  workspaceId: "ws_1",
  title: "Refactor auth flow",
});

const task = await client.tasks.create({
  workspaceId: "ws_1",
  sessionId: session.id,
  title: "Split auth middleware",
  objective: "Refactor into composable units",
});

// Start run -- business code never touches the adapter
const handle = await client.runs.start({
  workspaceId: "ws_1",
  sessionId: session.id,
  taskId: task.id,
  adapter: "openclaw",
  capabilityPolicy: {
    context:   "inject",         // platform builds and injects context
    memory:    "off",            // agent manages its own memory
    tasks:     "observe-native", // platform records task events only
    artifacts: "observe",        // platform records artifact events only
  },
});

// Business layer consumes events -- platform stores them internally regardless
for await (const event of handle.streamEvents()) {
  if (event.type === "message.delta") {
    process.stdout.write(event.payload.text);
  }
}

// Run is auto-completed when stream ends; optionally update task
await client.tasks.complete(task.id);
```

### 11.3 Progressively Enabling Platform Capabilities

```ts
// Phase 1 -- platform is a pure observer
const policy: CapabilityPolicy = {
  context:   "native",
  memory:    "off",
  tasks:     "observe-native",
  artifacts: "observe",
};

// Phase 2 -- platform starts injecting context (after V1.1)
const policy: CapabilityPolicy = {
  context:   "inject",   // flip this when context engine is ready
  memory:    "off",
  tasks:     "observe-native",
  artifacts: "observe",
};

// Phase 3 -- platform manages memory too
const policy: CapabilityPolicy = {
  context:   "inject",
  memory:    "platform", // requires context to be inject or replace
  tasks:     "observe-native",
  artifacts: "capture-store",
};
```

No code changes required in the business layer between phases.


## 12. Agent-Specific Integration Notes

### 12.1 Claude Code

Invocation mode: `cli-process`

| Capability | Delegation details |
|------------|-------------------|
| `context: native` | CLAUDE.md untouched; `--system-prompt` not set |
| `context: inject` | Platform content prepended to CLAUDE.md or passed via `--system-prompt` |
| `context: replace` | Platform builds full system prompt; CLAUDE.md overridden |
| `memory: off` | CLAUDE.md native memory untouched |
| `memory: tool-bridge` | `platform_memory_search` registered as MCP tool |
| `memory: platform` | Platform injects top memories as context blocks; native memory suppressed |
| `tasks: observe-native` | TodoRead/TodoWrite run normally; PostToolUse hook records results |
| `tasks: mirror-native` | PostToolUse hook mirrors todo state to canonical Task metadata and task status |
| `tasks: platform-tools` | MCP exposes platform task tools; PreToolUse hook blocks native todo |
| `artifacts: observe` | File write events captured via PostToolUse hook |
| `artifacts: capture-store` | Normalized artifact records persisted from tool results; full blob capture can be layered on later |

Event capture: `--output-format stream-json` + hooks pipeline.

### 12.2 OpenCode

Same integration pattern as Claude Code. MCP and hooks are the primary integration points. Adapter implementation is structurally identical.

### 12.3 OpenClaw

Invocation mode: `sdk`

Direct API adapter. Full control over the messages array, system prompt, and tool schemas. No process or hooks involved.

- `context: inject` -- prepend context blocks to messages array
- `context: replace` -- use context snapshot as the full messages array
- `memory: tool-bridge` -- inject memory tool schema into tools array
- `tasks: platform-tools` -- inject task tool schemas into tools array
- Event stream comes from SSE response

OpenClaw is the recommended first adapter because it has no process lifecycle or hook complexity.


## 13. Error Model

```ts
interface SerializedError {
  code: string;
  message: string;
  details?: unknown;
  retriable?: boolean;
}

type PlatformErrorCode =
  | "NOT_ENABLED"               // API called but feature not yet enabled in this version
  | "POLICY_CONFLICT"           // e.g., memory=platform requires context=inject or replace
  | "CAPABILITY_NOT_SUPPORTED"  // adapter cannot intercept this capability at the requested level
  | "BUDGET_EXCEEDED"           // context token budget exceeded hard limit
  | "ADAPTER_UNAVAILABLE"       // adapter runtime not reachable
  | "MEMORY_EXTRACTION_FAILED"  // LLM extraction step failed
  | "CHECKPOINT_INVALID";       // checkpoint version mismatch or corrupt
```

Policy validation is strict.
If the resolved `CapabilityPolicy` is internally inconsistent, `runs.start()` fails synchronously with `POLICY_CONFLICT`.
The adapter is not invoked, no external run is created, and the Run record is marked failed before start.


## 14. Security Policy Hooks

The SDK allows policy injection at critical execution points:

- before memory write
- before context block inclusion
- before artifact storage
- before checkpoint persistence
- before adapter invocation

Example uses: redaction, tenant isolation, PII handling, tool safety rules.


## 15. Storage Model

### 15.1 Storage Split

- **PostgreSQL** -- canonical entities and transactional metadata
- **Object store** -- raw events, checkpoints, large artifacts
- **Vector store / pgvector** -- semantic memory embeddings
- **Redis** -- optional hot cache, transient run state

### 15.2 Core Tables

```
workspaces
agent_profiles
sessions
tasks
runs
messages
memory_records
memory_links
artifacts
checkpoints
context_policies
context_snapshots
context_snapshot_blocks
run_events
run_event_raw_refs
```

### 15.3 Key Indexes

```sql
tasks(session_id, status, created_at DESC)
runs(task_id, started_at DESC)
messages(session_id, created_at ASC)
memory_records(workspace_id, kind, scope, updated_at DESC)
-- vector index on memory_records.embedding for semantic search
```


## 16. ID Strategy

```
ws_     workspace
prof_   agent profile
sess_   session
task_   task
run_    run
msg_    message
mem_    memory record
art_    artifact
ckpt_   checkpoint
ctx_    context snapshot
cpol_   context policy
evt_    event
```


## 17. Package Layout

```
packages/
  core/                  canonical types, domain contracts, event schemas
  client/                application SDK, RunAPI, CapabilityRouter
  adapter-kit/           AgentAdapter interface, contract test harness, normalization helpers
  context-engine/        context build pipeline, ranking, compression, explanation
  memory/                extraction, promotion, hybrid retrieval
  store-postgres/        relational persistence
  store-redis/           optional hot cache
  adapter-openclaw/      HTTP/SDK adapter (Anthropic API)
  adapter-claude-code/   CLI process adapter (hooks + MCP)
  adapter-opencode/      CLI process adapter (hooks + MCP)
  testing/               shared fixtures and contract test runner
docs/
  architecture/
  adapters/
  api/
```

### Package Responsibilities

`@ctx/core` -- canonical types, event schema, domain contracts, CapabilityPolicy types

`@ctx/client` -- application SDK, CapabilityRouter, RunHandle, input validation

`@ctx/adapter-kit` -- AgentAdapter interface, AdapterCapabilities, CliAdapterPayload/SdkAdapterPayload, contract test runner

`@ctx/context-engine` -- build pipeline, ranking, compression, explanation (V1.1)

`@ctx/memory` -- extraction, promotion, hybrid retrieval (V1.1)

`@ctx/adapter-*` -- runtime-specific adapters


## 18. Versioning Strategy

These components must be versioned independently:

- canonical event schema
- checkpoint payload envelope
- context snapshot schema
- adapter capability schema

Breaking changes require a version bump and a migration path. In-place modification of existing versions is not permitted.


## 19. Testing Strategy

### 19.1 Core Tests

- CapabilityPolicy resolution (run override beats profile beats default)
- Policy conflict validation (memory=platform without context injection)
- Adapter capability support enforcement
- Context budget enforcement
- Memory promotion rules

### 19.2 Adapter Contract Tests

Each adapter must pass the standard contract test suite provided by `@ctx/adapter-kit`:

- Core event normalization fixtures (raw -> standard event)
- Extension event passthrough
- Checkpoint round-trip
- Tool call mapping
- `renderContext()` output shape per invocation mode
- `capabilitySupport` declaration accuracy

### 19.3 Context Engine Tests (V1.1)

- Source ranking
- Deduplication
- Budget enforcement
- Explanation generation


## 20. V1 Scope

### V1 Must Have

These are the minimum pieces needed to ship a working platform:

- Canonical model: `Session`, `Task`, `Run`, `MemoryRecord` (schema + persistence), `ContextSnapshot` (schema)
- `CapabilityPolicy` with all four per-capability strategies
- `RunAPI.start()` returning `RunHandle` (adapter hidden from business layer)
- Core event model (not CLI extension events)
- Internal `AdapterRegistryAPI` for platform bootstrap
- One production adapter: `adapter-openclaw`
- Event capture and storage pipeline
- Policy conflict and capability support validation at run start

In V1.1, `MemoryAPI`, `ContextAPI`, and `ArtifactAPI` are exposed under `experimental`. `MemoryAPI` and `ContextAPI` are active, `ArtifactAPI` supports normalized artifact record get/list/delete for `capture-store` flows, `tasks: platform-tools` is active through task bridge tools, and `runs.checkpoint()/resume()` now support a canonical checkpoint round-trip.

In V1, `context: inject` and `context: replace` modes are schema-valid but will fail at `runs.start()` with `NOT_ENABLED` because `context.build()` is not yet implemented. Configuring these modes in V1 is treated as a misconfiguration, not a silent fallback to `native`.

### V1.1

- `context.build()` (ContextEngine)
- `memory.put()`, `memory.search()` (Memory store)
- `artifacts.get()/list()/delete()` for normalized artifact records
- `tasks: platform-tools` through `platform_task_get/list/update`
- `runs.checkpoint()` + `runs.resume()` canonical round-trip
- `ContextPolicy` management
- `context: inject` and `context: replace` modes become functional
- `memory: platform` read path becomes functional at run start through `ContextSnapshot` assembly

Memory write-back remains conservative in V1.1. The recommended policy is to read memory at the `run` boundary and write extracted candidates asynchronously after `run.completed`, as defined in [memory-strategy.md](e:/vibecoding/sdk/V1/docs/memory-strategy.md).

### V1.2

- `memory.extract()` (LLM-assisted extraction)
- standalone session graph store and cross-session graph-aware retrieval
- richer `session.completed` workflows beyond the current settled-session heuristic
- Richer retrieval policy: task-level caching, freshness invalidation, semantic dedupe
- `adapter-claude-code` (hooks + MCP)
- `adapter-opencode`
- CLI extension event types

### V2

- Checkpoint and resume
- Memory promotion workflows
- Multi-agent parent-child tasks


## 21. Implementation Order

```
1. @ctx/core                canonical types + CapabilityPolicy + event schema
2. @ctx/adapter-kit         adapter contract interfaces + test harness
3. @ctx/adapter-openclaw    first production adapter (validates core model)
4. @ctx/store-postgres      persistence layer
5. @ctx/client              application SDK + RunAPI + CapabilityRouter
6. @ctx/context-engine      context assembly (V1.1)
7. @ctx/memory              memory extraction and promotion (V1.1)
8. @ctx/adapter-claude-code MCP + hooks integration (V1.2)
9. @ctx/adapter-opencode    follows claude-code pattern (V1.2)
```

Reason for this order:

- `openclaw` first: validates the full run lifecycle with no process or hooks complexity
- CapabilityPolicy defaults to passive modes, so adapters ship before any platform capability is implemented
- Context engine and memory are incremental; the run pipeline works without them


## 22. Key Invariants

> The platform always owns the canonical Session, Task, and Run. Adapters maintain `externalRef` to correlate with their native state.

> Business code never calls adapter methods directly. `runs.start()` is the only run entry point.

> Event capture is unconditional. Capability modes change what the platform actively does, not whether it captures events.

> `agent-native` and `off` modes mean the platform captures events and does nothing else. There is no "call into agent-native API" because CLI agents do not expose a unified callable API.

> A task is executed through runs. Each run captures events unconditionally. Platform capabilities are adopted incrementally -- flipping a capability mode requires no changes in business layer code.






