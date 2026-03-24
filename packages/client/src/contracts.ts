import type {
  AgentEventEnvelope,
  Artifact,
  CapabilityPolicy,
  Checkpoint,
  ConsolidateTaskInput,
  ContextExplanation,
  ContextSnapshot,
  MemoryEngine,
  MemoryProvider,
  MemoryRecordDraftV1_1,
  MemoryRecordPatchV1_1,
  MemoryRecordV1_1,
  MemorySearchQuery,
  MemorySearchResult,
  PromoteMemoryInput,
  PromotionResult,
  Run,
  Session,
  Task,
  WriteConfirmedInput,
  WriteExperienceInput,
} from "@ctx/core";
import type { AdapterCapabilities, AgentAdapter } from "@ctx/adapter-kit";

export interface CreateSessionInput {
  workspaceId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskInput {
  workspaceId: string;
  sessionId: string;
  title: string;
  objective?: string;
}

export interface UpdateTaskInput {
  title?: string;
  objective?: string;
  instructions?: string;
  status?: Task["status"];
  priority?: number;
  dependsOn?: string[];
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ResumeRunInput {
  checkpointId: string;
  capabilityPolicy?: Partial<CapabilityPolicy>;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface StartRunInput {
  workspaceId: string;
  sessionId: string;
  taskId: string;
  adapter: string;
  capabilityPolicy?: Partial<CapabilityPolicy>;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface BuildContextInput {
  workspaceId: string;
  sessionId: string;
  taskId: string;
  policy: CapabilityPolicy;
  runId?: string;
  adapter?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextPreview {
  snapshot: ContextSnapshot;
  explanation: ContextExplanation;
}

export interface ListRunsInput {
  taskId?: string;
}

export interface ListEventsInput {
  runId: string;
}

export interface ListArtifactsInput {
  sessionId?: string;
  taskId?: string;
  runId?: string;
}

export interface Paginated<T> {
  items: T[];
}

export interface RunHandle {
  runId: string;
  readonly externalRef?: string;
  streamEvents(): AsyncIterable<AgentEventEnvelope>;
  interrupt(): Promise<void>;
  checkpoint(): Promise<Checkpoint>;
}

export interface SessionAPI {
  create(input: CreateSessionInput): Promise<Session>;
  get(id: string): Promise<Session>;
  archive(id: string): Promise<Session>;
}

export interface TaskAPI {
  create(input: CreateTaskInput): Promise<Task>;
  get(id: string): Promise<Task>;
  update(id: string, patch: UpdateTaskInput): Promise<Task>;
  complete(id: string): Promise<Task>;
  list(input: { sessionId?: string }): Promise<Paginated<Task>>;
}

export interface RunAPI {
  start(input: StartRunInput): Promise<RunHandle>;
  resume(input: ResumeRunInput): Promise<RunHandle>;
  get(id: string): Promise<Run>;
  list(input: ListRunsInput): Promise<Paginated<Run>>;
  interrupt(runId: string): Promise<void>;
}

export interface EventAPI {
  list(input: ListEventsInput): Promise<Paginated<AgentEventEnvelope>>;
}

export interface ArtifactAPI {
  get(id: string): Promise<Artifact>;
  list(input: ListArtifactsInput): Promise<Paginated<Artifact>>;
  delete(id: string): Promise<void>;
}

export interface MemoryBindings {
  provider?: MemoryProvider;
  engine?: MemoryEngine;
}

export interface MemoryAPI {
  get(id: string): Promise<MemoryRecordV1_1>;
  put(input: MemoryRecordDraftV1_1): Promise<MemoryRecordV1_1>;
  update(id: string, patch: MemoryRecordPatchV1_1): Promise<MemoryRecordV1_1>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult>;
  writeExperience(input: WriteExperienceInput): Promise<MemoryRecordV1_1>;
  writeConfirmed(input: WriteConfirmedInput): Promise<MemoryRecordV1_1>;
  consolidateTask(input: ConsolidateTaskInput): Promise<PromotionResult[]>;
  promote(input: PromoteMemoryInput): Promise<PromotionResult>;
  archive(id: string, opts?: { replacedBy?: string; reason?: string }): Promise<void>;
  invalidate(id: string, opts?: { invalidatedBy?: string; reason?: string }): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ContextAPI {
  build(input: BuildContextInput): Promise<ContextSnapshot>;
  explain(snapshotId: string): Promise<ContextExplanation>;
  preview(input: BuildContextInput): Promise<ContextPreview>;
}

export interface ExperimentalAPIs {
  memory: MemoryAPI;
  context: ContextAPI;
  artifacts: ArtifactAPI;
}

export interface ContextPlatformClient {
  sessions: SessionAPI;
  tasks: TaskAPI;
  runs: RunAPI;
  events: EventAPI;
  experimental?: ExperimentalAPIs;
}

export interface PlatformStore {
  saveSession(session: Session): Session;
  getSession(id: string): Session | undefined;
  listSessions?(): Session[];
  saveTask(task: Task): Task;
  getTask(id: string): Task | undefined;
  listTasks?(): Task[];
  saveRun(run: Run): Run;
  getRun(id: string): Run | undefined;
  listRunsByTask(taskId: string): Run[];
  appendEvent(event: AgentEventEnvelope): void;
  listEvents(runId: string): AgentEventEnvelope[];
  saveCheckpoint(checkpoint: Checkpoint): Checkpoint;
  getCheckpoint(id: string): Checkpoint | undefined;
  listCheckpoints?(): Checkpoint[];
  saveArtifact(artifact: Artifact): Artifact;
  getArtifact(id: string): Artifact | undefined;
  listArtifacts(): Artifact[];
  deleteArtifact(id: string): void;
}

export interface CreateContextPlatformInput {
  store: PlatformStore;
  memory?: MemoryBindings;
}

export interface ContextPlatform {
  runtime: PlatformRuntime;
  client(): ContextPlatformClient;
}

export interface PlatformRuntime {
  adapters: AdapterRegistryAPI;
  memory?: MemoryBindings;
}

export interface AdapterRegistryAPI {
  register(adapter: AgentAdapter): void;
  get(name: string): AgentAdapter;
  list(): Array<{ name: string; version: string; invocationMode: string }>;
  capabilities(name: string): AdapterCapabilities;
}
