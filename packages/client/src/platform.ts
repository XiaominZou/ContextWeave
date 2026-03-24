import {
  resolveCapabilityPolicy,
  validateCapabilityPolicy,
  type AgentEventEnvelope,
  type CapabilityPolicy,
  type Checkpoint,
  type ContextExplanation,
  type ContextSnapshot,
  type Run,
  type Session,
  type Task,
} from "@ctx/core";
import { buildPlatformMemoryMcpServers, buildPlatformTaskMcpServers, type ToolBridgeRenderContext } from "@ctx/adapter-kit";
import type {
  BuildContextInput,
  ArtifactAPI,
  ContextAPI,
  ContextPlatform,
  ContextPlatformClient,
  CreateContextPlatformInput,
  ListArtifactsInput,
  ResumeRunInput,
  MemoryAPI,
  UpdateTaskInput,
  MemoryBindings,
  PlatformStore,
  StartRunInput,
} from "./contracts";
import { AdapterRegistry } from "./internal/adapter-registry";
import { AsyncEventBuffer } from "./internal/async-event-buffer";
import { buildContextSnapshot, maybeBuildRunContextSnapshot } from "./internal/memory-context-snapshot";
import { asSerializedError, mustFind, throwPlatformError } from "./internal/errors";
import { nextId } from "./internal/ids";
import { createMemoryAPI } from "./internal/memory-api";
import {
  createRunHandle,
  processRunStream,
  validateAdapterCapabilitySupport,
  validateFeatureAvailability,
  validateMemoryBindings,
} from "./internal/run-runtime";
import {
  buildSessionDerivedContext,
  readSessionSummary,
  SESSION_SUMMARY_METADATA_KEY,
} from "./internal/session-derived-context";
import {
  invalidateSessionPreload,
  maybeGetSessionPreloadedMemory,
  type SessionPreloadCache,
} from "./internal/session-memory-preload";
import { buildTaskDerivedContext, TASK_SUMMARY_METADATA_KEY } from "./internal/task-derived-context";
import { buildSessionGraphIndex, buildTaskGraphIndex, SESSION_GRAPH_INDEX_METADATA_KEY, TASK_GRAPH_INDEX_METADATA_KEY } from "./internal/session-graph";
import {
  buildSessionAutoConsolidationState,
  isSessionSettled,
  readSessionAutoConsolidationState,
  SESSION_AUTO_CONSOLIDATION_METADATA_KEY,
} from "./internal/session-auto-consolidation";
import { createToolBridgeHost, type ToolBridgeHost } from "./internal/tool-bridge-host";

export function createContextPlatform(input: CreateContextPlatformInput): ContextPlatform {
  const registry = new AdapterRegistry();
  const store = input.store;
  const activeInterrupts = new Map<string, () => Promise<void>>();
  const contextSnapshots = new Map<string, ContextSnapshot>();
  const sessionPreloadCache: SessionPreloadCache = new Map();
  const memory = input.memory?.provider || input.memory?.engine ? { ...input.memory } : undefined;
  const memoryApi = createMemoryAPI(memory);
  const toolBridgeHost = createToolBridgeHost({
    memory: memoryApi,
    tasks: {
      get: async (taskId) => mustFind(store.getTask(taskId), "Task", taskId),
      list: async (taskInput) => ({ items: (store.listTasks?.() ?? []).filter((task) => taskInput.sessionId ? task.sessionId === taskInput.sessionId : true) }),
      update: async (taskId, patch) => updateTaskWithEffects(store, memoryApi, taskId, patch),
    },
  });
  const contextApi = createContextApi({ store, memoryApi, contextSnapshots, sessionPreloadCache });
  const artifactApi = createArtifactApi(store);

  const client: ContextPlatformClient = {
    sessions: {
      async create(sessionInput) {
        const now = new Date().toISOString();
        const session: Session = {
          id: nextId("sess"),
          workspaceId: sessionInput.workspaceId,
          title: sessionInput.title,
          status: "active",
          metadata: sessionInput.metadata,
          createdAt: now,
          updatedAt: now,
        };
        return store.saveSession(session);
      },
      async get(id) {
        return mustFind(store.getSession(id), "Session", id);
      },
      async archive(id) {
        const current = mustFind(store.getSession(id), "Session", id);
        if (current.status === "archived") {
          return persistSessionDerivedContext(store, current);
        }

        const now = new Date().toISOString();
        const archived = store.saveSession({
          ...current,
          status: "archived",
          updatedAt: now,
          archivedAt: now,
        });
        invalidateSessionPreload(sessionPreloadCache, archived.id);
        const withDerived = persistSessionDerivedContext(store, archived);
        await maybeConsolidateSessionMemory(memoryApi, withDerived);
        return withDerived;
      },
    },
    tasks: {
      async create(taskInput) {
        mustFind(store.getSession(taskInput.sessionId), "Session", taskInput.sessionId);
        const now = new Date().toISOString();
        const task: Task = {
          id: nextId("task"),
          workspaceId: taskInput.workspaceId,
          sessionId: taskInput.sessionId,
          title: taskInput.title,
          objective: taskInput.objective,
          status: "ready",
          createdAt: now,
          updatedAt: now,
        };
        return store.saveTask(task);
      },
      async get(id) {
        return mustFind(store.getTask(id), "Task", id);
      },
      async update(id, patch) {
        return updateTaskWithEffects(store, memoryApi, id, patch);
      },
      async complete(id) {
        const task = mustFind(store.getTask(id), "Task", id);
        const now = new Date().toISOString();
        const updated: Task = {
          ...task,
          status: "completed",
          updatedAt: now,
          completedAt: now,
        };
        const saved = store.saveTask(updated);
        await maybeConsolidateTaskMemory(memoryApi, saved);
        const withDerived = persistTaskDerivedContext(store, saved);
        await maybeAutoConsolidateSession({
          store,
          memoryApi,
          sessionId: withDerived.sessionId,
          reason: "task.completed",
        });
        return withDerived;
      },
      async list(input) {
        const items = (store.listTasks?.() ?? []).filter((task) => {
          return input.sessionId ? task.sessionId === input.sessionId : true;
        });
        return { items };
      },
    },
    runs: {
      async start(runInput) {
        return startRun({
          runInput,
          store,
          registry,
          activeInterrupts,
          memoryApi,
          memoryBindings: memory,
          contextSnapshots,
          sessionPreloadCache,
          toolBridgeHost,
        });
      },
      async resume(resumeInput) {
        return resumeRun({
          resumeInput,
          store,
          registry,
          activeInterrupts,
          memoryApi,
          memoryBindings: memory,
          contextSnapshots,
          sessionPreloadCache,
          toolBridgeHost,
        });
      },
      async get(id) {
        return mustFind(store.getRun(id), "Run", id);
      },
      async list(input) {
        const items = input.taskId ? store.listRunsByTask(input.taskId) : [];
        return { items };
      },
      async interrupt(runId) {
        const interrupt = activeInterrupts.get(runId);
        if (!interrupt) {
          return;
        }
        await interrupt();
      },
    },
    events: {
      async list(input) {
        return { items: store.listEvents(input.runId) };
      },
    },
    experimental: {
      memory: memoryApi,
      context: contextApi,
      artifacts: artifactApi,
    },
  };

  return {
    runtime: {
      adapters: registry,
      memory,
    },
    client() {
      return client;
    },
  };
}

function createArtifactApi(store: PlatformStore): ArtifactAPI {
  return {
    async get(id) {
      return mustFind(store.getArtifact(id), "Artifact", id);
    },
    async list(input: ListArtifactsInput) {
      const items = store.listArtifacts().filter((artifact) => {
        if (input.runId && artifact.runId !== input.runId) {
          return false;
        }
        if (input.taskId && artifact.taskId !== input.taskId) {
          return false;
        }
        if (input.sessionId && artifact.sessionId !== input.sessionId) {
          return false;
        }
        return true;
      });
      return { items };
    },
    async delete(id) {
      mustFind(store.getArtifact(id), "Artifact", id);
      store.deleteArtifact(id);
    },
  };
}

function createContextApi(input: {
  store: PlatformStore;
  memoryApi: MemoryAPI;
  contextSnapshots: Map<string, ContextSnapshot>;
  sessionPreloadCache: SessionPreloadCache;
}): ContextAPI {
  async function buildAndStore(buildInput: BuildContextInput): Promise<ContextSnapshot> {
    const session = mustFind(input.store.getSession(buildInput.sessionId), "Session", buildInput.sessionId);
    const task = mustFind(input.store.getTask(buildInput.taskId), "Task", buildInput.taskId);
    const syntheticRun = createSyntheticRun(buildInput);
    const preloadedMemoryHits = await maybeGetSessionPreloadedMemory({
      session,
      run: syntheticRun,
      policy: buildInput.policy,
      memoryApi: input.memoryApi,
      cache: input.sessionPreloadCache,
    });
    const snapshot = await buildContextSnapshot({
      run: syntheticRun,
      task,
      policy: buildInput.policy,
      memoryApi: input.memoryApi,
      store: input.store,
      preloadedMemoryHits,
    });
    input.contextSnapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  return {
    build(buildInput) {
      return buildAndStore(buildInput);
    },
    async explain(snapshotId) {
      const snapshot = input.contextSnapshots.get(snapshotId);
      if (!snapshot) {
        throwPlatformError("CONTEXT_SNAPSHOT_NOT_FOUND", `ContextSnapshot not found: ${snapshotId}`);
      }
      return snapshot.explanation ?? emptyExplanation();
    },
    async preview(buildInput) {
      const snapshot = await buildAndStore(buildInput);
      return {
        snapshot,
        explanation: snapshot.explanation ?? emptyExplanation(),
      };
    },
  };
}

async function resumeRun(input: {
  resumeInput: ResumeRunInput;
  store: PlatformStore;
  registry: AdapterRegistry;
  activeInterrupts: Map<string, () => Promise<void>>;
  memoryApi: MemoryAPI;
  memoryBindings?: MemoryBindings;
  contextSnapshots: Map<string, ContextSnapshot>;
  sessionPreloadCache: SessionPreloadCache;
  toolBridgeHost: ToolBridgeHost;
}) {
  const checkpoint = mustFind(input.store.getCheckpoint(input.resumeInput.checkpointId), "Checkpoint", input.resumeInput.checkpointId);
  const session = mustFind(input.store.getSession(checkpoint.sessionId), "Session", checkpoint.sessionId);
  mustFind(input.store.getTask(checkpoint.taskId), "Task", checkpoint.taskId);
  const previousRun = mustFind(input.store.getRun(checkpoint.runId), "Run", checkpoint.runId);
  const adapter = input.registry.get(checkpoint.adapter);

  if (!adapter.capabilities.resume || !adapter.resumeRun) {
    throwPlatformError("CAPABILITY_NOT_SUPPORTED", "adapter does not support resume capability");
  }

  const runInput: StartRunInput = {
    workspaceId: checkpoint.workspaceId,
    sessionId: checkpoint.sessionId,
    taskId: checkpoint.taskId,
    adapter: checkpoint.adapter,
    capabilityPolicy: input.resumeInput.capabilityPolicy ?? previousRun.capabilityPolicy,
    model: input.resumeInput.model ?? previousRun.model,
    metadata: {
      ...previousRun.metadata,
      ...input.resumeInput.metadata,
      resumedFromCheckpointId: checkpoint.id,
      resumedFromRunId: checkpoint.runId,
    },
  };

  return launchRun({
    mode: "resume",
    resumeFrom: { checkpoint, previousRun },
    runInput,
    store: input.store,
    registry: input.registry,
    activeInterrupts: input.activeInterrupts,
    memoryApi: input.memoryApi,
    memoryBindings: input.memoryBindings,
    contextSnapshots: input.contextSnapshots,
    sessionPreloadCache: input.sessionPreloadCache,
    toolBridgeHost: input.toolBridgeHost,
    session,
  });
}

async function startRun(input: {
  runInput: StartRunInput;
  store: PlatformStore;
  registry: AdapterRegistry;
  activeInterrupts: Map<string, () => Promise<void>>;
  memoryApi: MemoryAPI;
  memoryBindings?: MemoryBindings;
  contextSnapshots: Map<string, ContextSnapshot>;
  sessionPreloadCache: SessionPreloadCache;
  toolBridgeHost: ToolBridgeHost;
}) {
  const session = mustFind(input.store.getSession(input.runInput.sessionId), "Session", input.runInput.sessionId);
  return launchRun({
    mode: "start",
    runInput: input.runInput,
    store: input.store,
    registry: input.registry,
    activeInterrupts: input.activeInterrupts,
    memoryApi: input.memoryApi,
    memoryBindings: input.memoryBindings,
    contextSnapshots: input.contextSnapshots,
    sessionPreloadCache: input.sessionPreloadCache,
    toolBridgeHost: input.toolBridgeHost,
    session,
  });
}

async function launchRun(input: {
  mode: "start" | "resume";
  runInput: StartRunInput;
  store: PlatformStore;
  registry: AdapterRegistry;
  activeInterrupts: Map<string, () => Promise<void>>;
  memoryApi: MemoryAPI;
  memoryBindings?: MemoryBindings;
  contextSnapshots: Map<string, ContextSnapshot>;
  sessionPreloadCache: SessionPreloadCache;
  toolBridgeHost: ToolBridgeHost;
  session: Session;
  resumeFrom?: {
    checkpoint: Checkpoint;
    previousRun: Run;
  };
}) {
  const { runInput, store, registry, activeInterrupts, memoryApi, memoryBindings, contextSnapshots, sessionPreloadCache, toolBridgeHost, session } = input;
  const task = mustFind(store.getTask(runInput.taskId), "Task", runInput.taskId);

  let run: Run = {
    id: nextId("run"),
    workspaceId: runInput.workspaceId,
    sessionId: runInput.sessionId,
    taskId: runInput.taskId,
    adapter: runInput.adapter,
    model: runInput.model,
    status: "queued",
    attempt: input.resumeFrom ? input.resumeFrom.previousRun.attempt + 1 : 1,
    capabilityPolicy: runInput.capabilityPolicy,
    metadata: runInput.metadata,
  };
  run = store.saveRun(run);

  let toolBridgeContext: ToolBridgeRenderContext | undefined;

  try {
    const effectivePolicy: CapabilityPolicy = resolveCapabilityPolicy(undefined, runInput.capabilityPolicy);
    validateCapabilityPolicy(effectivePolicy);
    run = store.saveRun({ ...run, capabilityPolicy: effectivePolicy });

    const adapter = registry.get(runInput.adapter);
    validateAdapterCapabilitySupport(adapter, effectivePolicy);
    validateFeatureAvailability(effectivePolicy);
    validateMemoryBindings(effectivePolicy, memoryBindings);

    if (input.mode === "resume" && (!adapter.capabilities.resume || !adapter.resumeRun)) {
      throwPlatformError("CAPABILITY_NOT_SUPPORTED", "adapter does not support resume capability");
    }

    if ((effectivePolicy.memory === "tool-bridge" || effectivePolicy.tasks === "platform-tools")) {
      const bridgeConnection = await toolBridgeHost.registerRun({ run, userId: readUserId(session, run) });
      toolBridgeContext = {
        memoryMcpServers: effectivePolicy.memory === "tool-bridge" ? buildPlatformMemoryMcpServers(run, bridgeConnection) : undefined,
        taskMcpServers: effectivePolicy.tasks === "platform-tools" ? buildPlatformTaskMcpServers(run, bridgeConnection) : undefined,
      };
    }

    const preloadedMemoryHits = await maybeGetSessionPreloadedMemory({
      session,
      run,
      policy: effectivePolicy,
      memoryApi,
      cache: sessionPreloadCache,
    });

    const snapshot = await maybeBuildRunContextSnapshot({
      run,
      task,
      policy: effectivePolicy,
      memoryApi,
      store,
      preloadedMemoryHits,
    });

    if (snapshot) {
      contextSnapshots.set(snapshot.id, snapshot);
      run = store.saveRun({ ...run, snapshotId: snapshot.id });
    }

    const payload = await adapter.renderContext({ snapshot, policy: effectivePolicy, run, toolBridge: toolBridgeContext });
    const adapterHandle = input.mode === "resume"
      ? await adapter.resumeRun!({ run, checkpoint: input.resumeFrom!.checkpoint })
      : await adapter.createRun({ run, payload, policy: effectivePolicy });

    run = store.saveRun({
      ...run,
      status: "running",
      startedAt: new Date().toISOString(),
      externalRef: adapterHandle.externalRef,
      metadata: input.resumeFrom ? { ...run.metadata, resumedFromCheckpointId: input.resumeFrom.checkpoint.id } : run.metadata,
    });

    const buffer = new AsyncEventBuffer<AgentEventEnvelope>();
    activeInterrupts.set(run.id, async () => {
      await adapterHandle.cancel();
      const current = mustFind(store.getRun(run.id), "Run", run.id);
      store.saveRun({
        ...current,
        status: current.status === "running" ? "cancelled" : current.status,
        endedAt: new Date().toISOString(),
      });
      toolBridgeHost.unregisterRun(run.id);
      buffer.close();
    });

    const checkpointRun = async (): Promise<Checkpoint> => {
      if (!adapter.capabilities.checkpoints || !adapter.createCheckpoint) {
        throwPlatformError("CAPABILITY_NOT_SUPPORTED", "adapter does not support checkpoint capability");
      }
      const current = mustFind(store.getRun(run.id), "Run", run.id);
      const checkpoint = await adapter.createCheckpoint(run.id);
      const saved = store.saveCheckpoint(checkpoint);
      const event: AgentEventEnvelope<{ checkpointId: string }> = {
        id: nextId("evt"),
        workspaceId: current.workspaceId,
        sessionId: current.sessionId,
        taskId: current.taskId,
        runId: current.id,
        adapter: "platform",
        type: "checkpoint.created",
        timestamp: new Date().toISOString(),
        payload: { checkpointId: saved.id },
      };
      store.appendEvent(event);
      buffer.push(event);
      return saved;
    };

    void processRunStream({
      store,
      adapter,
      adapterHandle,
      runId: run.id,
      buffer,
      memoryApi,
      policy: effectivePolicy,
      onSettled: async () => {
        toolBridgeHost.unregisterRun(run.id);
        await maybeAutoConsolidateSession({
          store,
          memoryApi,
          sessionId: run.sessionId,
          reason: "run.settled",
        });
      },
    });

    return createRunHandle(run.id, store, buffer, activeInterrupts, checkpointRun);
  } catch (error) {
    toolBridgeHost.unregisterRun(run.id);
    store.saveRun({
      ...run,
      status: "failed",
      endedAt: new Date().toISOString(),
      error: asSerializedError(error),
    });
    throw error;
  }
}

function updateTaskRecord(store: PlatformStore, id: string, patch: UpdateTaskInput): Task {
  const task = mustFind(store.getTask(id), "Task", id);
  const now = new Date().toISOString();
  const nextStatus = patch.status ?? task.status;
  const completedAt = nextStatus === "completed"
    ? task.completedAt ?? now
    : nextStatus === "failed" || nextStatus === "cancelled"
      ? task.completedAt
      : undefined;
  const updated = store.saveTask({
    ...task,
    title: patch.title ?? task.title,
    objective: patch.objective ?? task.objective,
    instructions: patch.instructions ?? task.instructions,
    status: nextStatus,
    priority: patch.priority ?? task.priority,
    dependsOn: patch.dependsOn ?? task.dependsOn,
    input: patch.input ?? task.input,
    output: patch.output ?? task.output,
    metadata: patch.metadata ? { ...task.metadata, ...patch.metadata } : task.metadata,
    updatedAt: now,
    completedAt,
  });
  return persistTaskDerivedContext(store, updated);
}

async function updateTaskWithEffects(store: PlatformStore, memoryApi: MemoryAPI, id: string, patch: UpdateTaskInput): Promise<Task> {
  const updated = updateTaskRecord(store, id, patch);
  if (updated.status === "completed") {
    await maybeConsolidateTaskMemory(memoryApi, updated);
    await maybeAutoConsolidateSession({
      store,
      memoryApi,
      sessionId: updated.sessionId,
      reason: "task.updated",
    });
  }
  return updated;
}

async function maybeConsolidateTaskMemory(memoryApi: MemoryAPI, task: Task): Promise<void> {
  try {
    await memoryApi.consolidateTask({
      workspaceId: task.workspaceId,
      taskId: task.id,
      sessionId: task.sessionId,
    });
  } catch (error) {
    const withCode = error as { code?: string };
    if (withCode.code === "NOT_ENABLED") {
      return;
    }
    throw error;
  }
}

async function maybeConsolidateSessionMemory(memoryApi: MemoryAPI, session: Session): Promise<void> {
  const summary = readSessionSummary(session);
  if (!summary) {
    return;
  }

  try {
    await memoryApi.writeExperience({
      record: {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        ownerRef: { type: "session", id: session.id },
        scope: "session",
        layer: "experience",
        channel: "collection",
        kind: "insight",
        status: "candidate",
        title: `${session.title ?? session.id} session summary`,
        content: summary.summaryText,
        summary: summary.summaryText,
        importance: 0.65,
        confidence: 0.7,
        sourceRefs: [
          ...summary.latestTaskIds.map((taskId) => ({ type: "task" as const, id: taskId })),
          ...summary.latestRunIds.map((runId) => ({ type: "run" as const, id: runId })),
        ],
      },
    });
  } catch (error) {
    const withCode = error as { code?: string };
    if (withCode.code === "NOT_ENABLED") {
      return;
    }
    throw error;
  }
}

async function maybeAutoConsolidateSession(input: {
  store: PlatformStore;
  memoryApi: MemoryAPI;
  sessionId: string;
  reason: string;
}): Promise<Session | undefined> {
  const current = input.store.getSession(input.sessionId);
  if (!current || current.status === "archived") {
    return current;
  }

  const tasks = (input.store.listTasks?.() ?? []).filter((task) => task.sessionId === current.id);
  const runs = tasks.flatMap((task) => input.store.listRunsByTask(task.id));
  if (!isSessionSettled({ session: current, tasks, runs })) {
    return current;
  }

  const withDerived = persistSessionDerivedContext(input.store, current);
  const nextState = buildSessionAutoConsolidationState({
    session: withDerived,
    reason: input.reason,
  });
  if (!nextState) {
    return withDerived;
  }

  const existingState = readSessionAutoConsolidationState(withDerived);
  if (existingState?.signature === nextState.signature) {
    return withDerived;
  }

  await maybeConsolidateSessionMemory(input.memoryApi, withDerived);
  return input.store.saveSession({
    ...withDerived,
    metadata: {
      ...withDerived.metadata,
      [SESSION_AUTO_CONSOLIDATION_METADATA_KEY]: nextState,
    },
  });
}

function persistTaskDerivedContext(store: PlatformStore, task: Task): Task {
  try {
    const current = store.getTask(task.id) ?? task;
    const runs = store.listRunsByTask(task.id);
    const sessionTasks = (store.listTasks?.() ?? []).filter((candidate) => candidate.sessionId === current.sessionId);
    const derived = buildTaskDerivedContext({
      task: current,
      runs,
    });
    const withSummary = store.saveTask({
      ...current,
      metadata: {
        ...current.metadata,
        [TASK_SUMMARY_METADATA_KEY]: derived.taskSummary,
      },
    });
    return store.saveTask({
      ...withSummary,
      metadata: {
        ...withSummary.metadata,
        [TASK_GRAPH_INDEX_METADATA_KEY]: buildTaskGraphIndex({
          task: withSummary,
          runs,
          sessionTasks,
        }),
      },
    });
  } catch {
    return store.getTask(task.id) ?? task;
  }
}

function persistSessionDerivedContext(store: PlatformStore, session: Session): Session {
  try {
    const current = store.getSession(session.id) ?? session;
    const tasks = (store.listTasks?.() ?? []).filter((task) => task.sessionId === current.id);
    const runs = tasks.flatMap((task) => store.listRunsByTask(task.id));
    const derived = buildSessionDerivedContext({
      session: current,
      tasks,
      runs,
    });
    const withSummary = store.saveSession({
      ...current,
      metadata: {
        ...current.metadata,
        [SESSION_SUMMARY_METADATA_KEY]: derived.sessionSummary,
      },
    });
    return store.saveSession({
      ...withSummary,
      metadata: {
        ...withSummary.metadata,
        [SESSION_GRAPH_INDEX_METADATA_KEY]: buildSessionGraphIndex({
          session: withSummary,
          tasks,
          runs,
        }),
      },
    });
  } catch {
    return store.getSession(session.id) ?? session;
  }
}

function createSyntheticRun(input: BuildContextInput): Run {
  return {
    id: input.runId ?? nextId("run_preview"),
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    adapter: input.adapter ?? "preview",
    model: input.model,
    status: "queued",
    attempt: 1,
    capabilityPolicy: input.policy,
    metadata: input.metadata,
  };
}

function emptyExplanation(): ContextExplanation {
  return {
    included: [],
    excluded: [],
    totalTokens: 0,
  };
}

function readUserId(session: Session, run: Run): string | undefined {
  const sessionUserId = readString(session.metadata?.["userId"]);
  if (sessionUserId) {
    return sessionUserId;
  }
  return readString(run.metadata?.["userId"]);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}



