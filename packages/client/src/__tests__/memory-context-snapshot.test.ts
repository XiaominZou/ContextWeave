import { describe, expect, test, vi } from "vitest";

import type { Artifact, CapabilityPolicy, Checkpoint, MemorySearchHit, MemorySearchResult, Run, Session, Task } from "@ctx/core";
import type { MemoryAPI, PlatformStore } from "../contracts";
import { buildContextSnapshot, maybeBuildRunContextSnapshot } from "../internal/memory-context-snapshot";
import { SESSION_SUMMARY_METADATA_KEY } from "../internal/session-derived-context";
import { RUN_SUMMARY_METADATA_KEY } from "../internal/run-derived-context";
import { TASK_GRAPH_INDEX_METADATA_KEY, SESSION_GRAPH_INDEX_METADATA_KEY } from "../internal/session-graph";
import { TASK_SUMMARY_METADATA_KEY } from "../internal/task-derived-context";

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task_1",
    workspaceId: "ws_1",
    sessionId: "sess_1",
    title: "Refactor auth flow",
    objective: "Split auth middleware into reusable units",
    instructions: "Prefer small composable modules.",
    status: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    title: "Auth work",
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    workspaceId: "ws_1",
    sessionId: "sess_1",
    taskId: "task_1",
    adapter: "mock",
    status: "queued",
    attempt: 1,
    metadata: {
      prompt: "Need prior project conventions for auth refactor.",
    },
    ...overrides,
  };
}

function makeMemoryApi() {
  const search = vi.fn(async (): Promise<MemorySearchResult> => ({
    hits: [
      {
        record: {
          id: "mem_1",
          workspaceId: "ws_1",
          ownerRef: { type: "workspace" as const, id: "ws_1" },
          scope: "workspace" as const,
          layer: "long_term" as const,
          channel: "collection" as const,
          kind: "procedure" as const,
          status: "active" as const,
          title: "Auth convention",
          content: "Use composable middleware and keep auth checks side-effect free.",
          summary: "Composable auth middleware is preferred.",
          importance: 0.9,
          confidence: 0.8,
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        finalScore: 0.88,
      },
    ],
    namespacesSearched: [{ scope: "workspace" as const, ownerId: "ws_1" }],
  }));

  const unsupported = async () => {
    throw new Error("not needed in this test");
  };

  return {
    search,
    get: unsupported,
    put: unsupported,
    update: unsupported,
    writeExperience: unsupported,
    writeConfirmed: unsupported,
    consolidateTask: unsupported,
    promote: unsupported,
    archive: unsupported,
    invalidate: unsupported,
    delete: unsupported,
  } as unknown as MemoryAPI & { search: typeof search };
}

function makeStore(input?: {
  sessions?: Session[];
  tasks?: Task[];
  runs?: Run[];
  artifacts?: Artifact[];
}): PlatformStore {
  const sessions = input?.sessions ?? [];
  const tasks = input?.tasks ?? [];
  const runs = input?.runs ?? [];
  const artifacts: Artifact[] = (input as { artifacts?: Artifact[] } | undefined)?.artifacts ?? [];
  const checkpoints: Checkpoint[] = [];

  return {
    saveSession(session) {
      return session;
    },
    getSession(id) {
      return sessions.find((session) => session.id === id);
    },
    saveTask(task) {
      return task;
    },
    getTask(id) {
      return tasks.find((task) => task.id === id);
    },
    listTasks() {
      return tasks;
    },
    saveRun(run) {
      return run;
    },
    getRun(id) {
      return runs.find((run) => run.id === id);
    },
    listRunsByTask(taskId) {
      return runs.filter((run) => run.taskId === taskId);
    },
    appendEvent() {},
    listEvents() {
      return [];
    },
    saveArtifact(artifact) {
      artifacts.push(artifact);
      return artifact;
    },
    getArtifact(id) {
      return artifacts.find((artifact) => artifact.id === id);
    },
    listArtifacts() {
      return artifacts;
    },
    deleteArtifact(id) {
      const index = artifacts.findIndex((artifact) => artifact.id === id);
      if (index >= 0) {
        artifacts.splice(index, 1);
      }
    },
    saveCheckpoint(checkpoint) {
      checkpoints.push(checkpoint);
      return checkpoint;
    },
    getCheckpoint(id) {
      return checkpoints.find((checkpoint) => checkpoint.id === id);
    },
  };
}

describe("context snapshot builder", () => {
  test("returns null for run path when context mode is native", async () => {
    const memoryApi = makeMemoryApi();
    const policy: CapabilityPolicy = {
      context: "native",
      memory: "off",
      tasks: "observe-native",
      artifacts: "observe",
    };

    const snapshot = await maybeBuildRunContextSnapshot({
      run: makeRun(),
      task: makeTask(),
      policy,
      memoryApi,
      store: makeStore(),
    });

    expect(snapshot).toBeNull();
    expect(memoryApi.search).not.toHaveBeenCalled();
  });

  test("builds task and memory blocks for injected platform context", async () => {
    const memoryApi = makeMemoryApi();
    const policy: CapabilityPolicy = {
      context: "inject",
      memory: "platform",
      tasks: "observe-native",
      artifacts: "observe",
    };

    const snapshot = await buildContextSnapshot({
      run: makeRun(),
      task: makeTask(),
      policy,
      memoryApi,
      store: makeStore(),
    });

    expect(memoryApi.search).toHaveBeenCalledWith({
      anchor: {
        workspaceId: "ws_1",
        sessionId: "sess_1",
        taskId: "task_1",
        runId: "run_1",
      },
      queryText: [
        "Refactor auth flow",
        "Split auth middleware into reusable units",
        "Prefer small composable modules.",
        "Need prior project conventions for auth refactor.",
      ].join("\n"),
      layer: "long_term",
      maxResults: 5,
    });

    expect(snapshot.blocks).toHaveLength(2);
    expect(snapshot.blocks[0]).toMatchObject({
      kind: "task",
      title: "Refactor auth flow",
      sourceRef: "task_1",
      metadata: expect.objectContaining({
        taskId: "task_1",
        inclusionReason: "current task context",
        retentionAction: "expand",
      }),
    });
    expect(snapshot.blocks[1]).toMatchObject({
      kind: "memory",
      title: "Auth convention",
      sourceRef: "mem_1",
      metadata: expect.objectContaining({
        memoryId: "mem_1",
        retrievalTrigger: "pre-run",
      }),
    });
    expect(snapshot.explanation?.excluded).toEqual([]);
  });

  test("includes dependency task summaries and prior run summaries as graph-aware sources", async () => {
    const memoryApi = makeMemoryApi();
    const dependencyTask: Task = makeTask({
      id: "task_dep",
      title: "Prepare auth constraints",
      status: "completed",
      metadata: {
        [TASK_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: new Date().toISOString(),
          taskStatus: "completed",
          runCount: 1,
          completedRunCount: 1,
          failedRunCount: 0,
          cancelledRunCount: 0,
          indexedToolCallCount: 0,
          latestRunIds: ["run_dep"],
          summaryText: "Dependency task established the validation ordering constraints.",
        },
      },
    });
    const task: Task = makeTask({
      dependsOn: [dependencyTask.id],
      metadata: {
        [TASK_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: new Date().toISOString(),
          taskStatus: "completed",
          runCount: 2,
          completedRunCount: 1,
          failedRunCount: 1,
          cancelledRunCount: 0,
          indexedToolCallCount: 1,
          latestRunIds: ["run_prev"],
          recentReadFilePaths: ["/README.md"],
          recentEditedFilePaths: ["/app/store.py"],
          recentCommandPreviews: ["npm test"],
          recentFailureHints: ["bash: boom"],
          latestAssistantOutputPreview: "Focus on validation gap in tasks route.",
          summaryText: "Task summary says auth work already has one failed and one successful attempt.",
        },
        [TASK_GRAPH_INDEX_METADATA_KEY]: {
          version: "1",
          generatedAt: new Date().toISOString(),
          taskId: "task_1",
          dependencyTaskIds: [dependencyTask.id],
          latestRunIds: ["run_prev"],
          nodes: [],
          edges: [],
        },
      },
    });
    const priorRun: Run = {
      id: "run_prev",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      taskId: "task_1",
      adapter: "mock",
      status: "completed",
      attempt: 1,
      endedAt: new Date().toISOString(),
      metadata: {
        [RUN_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: new Date().toISOString(),
          status: "completed",
          messageCount: 1,
          toolCallCount: 1,
          indexedToolCallCount: 1,
          readFilePaths: ["/README.md"],
          editedFilePaths: ["/app/store.py"],
          commandPreviews: ["npm test"],
          failureHints: ["bash: boom"],
          summaryText: "Prior run fixed the middleware shape but left one validation gap.",
        },
      },
    };

    const snapshot = await buildContextSnapshot({
      run: makeRun(),
      task,
      policy: {
        context: "inject",
        memory: "off",
        tasks: "observe-native",
        artifacts: "observe",
      },
      memoryApi,
      store: makeStore({ tasks: [task, dependencyTask], runs: [priorRun] }),
    });

    expect(memoryApi.search).not.toHaveBeenCalled();
    expect(snapshot.blocks).toHaveLength(4);
    const taskSummaryBlock = snapshot.blocks.find((block) => block.metadata?.["sourceType"] === "task-summary");
    const dependencySummaryBlock = snapshot.blocks.find((block) => block.metadata?.["sourceType"] === "dependency-task-summary");
    const runSummaryBlock = snapshot.blocks.find((block) => block.metadata?.["sourceType"] === "run-summary");

    expect(taskSummaryBlock).toMatchObject({
      kind: "task",
      title: "Refactor auth flow summary",
    });
    expect(taskSummaryBlock?.content).not.toContain("latest run:");
    expect(dependencySummaryBlock).toMatchObject({
      kind: "task",
      title: "Prepare auth constraints dependency summary",
      sourceRef: "task_dep",
      metadata: expect.objectContaining({
        sourceType: "dependency-task-summary",
        retentionAction: "expand",
      }),
    });
    expect(runSummaryBlock).toMatchObject({
      kind: "message",
      title: "Prior run run_prev",
      sourceRef: "run_prev",
      metadata: expect.objectContaining({ sourceType: "run-summary" }),
    });
    expect(snapshot.blocks[0]?.content).toContain("Recent edits: /app/store.py");
    expect(snapshot.blocks[0]?.content).toContain("Recent working set: /README.md");
    expect(snapshot.blocks[0]?.content).toContain("Recent commands: npm test");
    expect(snapshot.blocks[0]?.content).toContain("Known failures: bash: boom");
    const taskBlock = snapshot.blocks.find((block) => block.metadata?.["sourceType"] === "task");
    expect(taskBlock?.content).toContain("Recent edits: /app/store.py");
    expect(taskBlock?.content).toContain("Recent working set: /README.md");
    expect(taskBlock?.content).toContain("Recent commands: npm test");
    expect(taskBlock?.content).toContain("Latest progress: Focus on validation gap in tasks route.");
  });

  test("suppresses prior run summaries when context hint disables them", async () => {
    const memoryApi = makeMemoryApi();
    const task: Task = makeTask();
    const priorRun: Run = {
      id: "run_prev",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      taskId: "task_1",
      adapter: "mock",
      status: "completed",
      attempt: 1,
      endedAt: new Date().toISOString(),
      metadata: {
        [RUN_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: new Date().toISOString(),
          status: "completed",
          messageCount: 1,
          toolCallCount: 1,
          indexedToolCallCount: 1,
          readFilePaths: ["/README.md"],
          editedFilePaths: ["/app/store.py"],
          commandPreviews: ["npm test"],
          failureHints: [],
          assistantOutputPreview: "Focus on validation gap in tasks route.",
          summaryText: "Prior run fixed the middleware shape but left one validation gap.",
        },
      },
    };

    const snapshot = await buildContextSnapshot({
      run: makeRun(),
      task,
      policy: {
        context: "inject",
        memory: "off",
        tasks: "observe-native",
        artifacts: "observe",
        contextHints: {
          suppressRunSummaries: true,
        },
      },
      memoryApi,
      store: makeStore({ tasks: [task], runs: [priorRun] }),
    });

    expect(snapshot.blocks.some((block) => block.metadata?.["sourceType"] === "run-summary")).toBe(false);
  });

  test("prefers session preload memory blocks and deduplicates matching task search hits", async () => {
    const memoryApi = makeMemoryApi();
    const preloadHit: MemorySearchHit = {
      record: {
        id: "mem_profile",
        workspaceId: "ws_1",
        userId: "user_1",
        ownerRef: { type: "user" as const, id: "user_1" },
        scope: "user" as const,
        layer: "long_term" as const,
        channel: "profile" as const,
        kind: "preference" as const,
        status: "active" as const,
        title: "Coding style",
        content: "Prefer tiny pure helper functions.",
        summary: "Preferred code style: tiny pure helper functions.",
        importance: 0.95,
        confidence: 0.9,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      finalScore: 0.97,
    };
    memoryApi.search.mockResolvedValueOnce({
      hits: [preloadHit],
      namespacesSearched: [{ scope: "workspace" as const, ownerId: "ws_1" }],
    });

    const snapshot = await buildContextSnapshot({
      run: makeRun(),
      task: makeTask(),
      policy: {
        context: "inject",
        memory: "platform",
        tasks: "observe-native",
        artifacts: "observe",
      },
      memoryApi,
      store: makeStore(),
      preloadedMemoryHits: [preloadHit],
    });

    expect(snapshot.blocks).toHaveLength(2);
    const preloadBlock = snapshot.blocks.find((block) => block.metadata?.["sourceType"] === "session-preload");
    expect(preloadBlock).toMatchObject({
      kind: "memory",
      title: "Coding style",
      sourceRef: "mem_profile",
      metadata: expect.objectContaining({
        retrievalTrigger: "session-preload",
        sourceType: "session-preload",
        retentionAction: "summary-only",
      }),
    });
    const taskBlock = snapshot.blocks.find((block) => block.metadata?.["sourceType"] === "task");
    expect(taskBlock).toMatchObject({
      kind: "task",
      sourceRef: "task_1",
    });
    expect(memoryApi.search).toHaveBeenCalledTimes(1);
  });

  test("includes captured artifact blocks when artifacts=capture-store", async () => {
    const memoryApi = makeMemoryApi();
    const artifact: Artifact = {
      id: "art_report",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      taskId: "task_1",
      runId: "run_prev",
      type: "text",
      uri: "file:///workspace/report.md",
      title: "Release report",
      summary: "Summarized validation results.",
      createdAt: new Date().toISOString(),
    };

    const snapshot = await buildContextSnapshot({
      run: makeRun(),
      task: makeTask(),
      policy: {
        context: "inject",
        memory: "off",
        tasks: "observe-native",
        artifacts: "capture-store",
      },
      memoryApi,
      store: makeStore({ artifacts: [artifact] }),
    });

    expect(memoryApi.search).not.toHaveBeenCalled();
    expect(snapshot.blocks).toHaveLength(2);
    expect(snapshot.blocks[1]).toMatchObject({
      kind: "artifact",
      title: "Release report",
      sourceRef: "art_report",
      metadata: expect.objectContaining({
        artifactId: "art_report",
        sourceType: "artifact",
      }),
    });
  });

  test("graph-aware pruning drops lowest-signal soft blocks when candidate set grows", async () => {
    const memoryApi = makeMemoryApi();
    const now = new Date();
    const task = makeTask({
      metadata: {
        [TASK_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: now.toISOString(),
          taskStatus: "ready",
          runCount: 4,
          completedRunCount: 3,
          failedRunCount: 1,
          cancelledRunCount: 0,
          indexedToolCallCount: 0,
          latestRunIds: ["run_prev_1"],
          summaryText: "Current task summary.",
        },
      },
    });
    const dependencyTask = makeTask({
      id: "task_dep",
      title: "Dependency task",
      status: "completed",
      metadata: {
        [TASK_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: now.toISOString(),
          taskStatus: "completed",
          runCount: 1,
          completedRunCount: 1,
          failedRunCount: 0,
          cancelledRunCount: 0,
          indexedToolCallCount: 0,
          latestRunIds: ["run_dep"],
          summaryText: "Dependency task summary.",
        },
      },
    });
    const taskWithDeps = {
      ...task,
      dependsOn: [dependencyTask.id],
      metadata: {
        ...task.metadata,
        [TASK_GRAPH_INDEX_METADATA_KEY]: {
          version: "1",
          generatedAt: now.toISOString(),
          taskId: task.id,
          dependencyTaskIds: [dependencyTask.id],
          latestRunIds: ["run_prev_1", "run_prev_2", "run_prev_3"],
          nodes: [],
          edges: [],
        },
      },
    } satisfies Task;

    const priorRuns: Run[] = [1, 2, 3].map((index) => ({
      id: `run_prev_${index}`,
      workspaceId: "ws_1",
      sessionId: "sess_1",
      taskId: "task_1",
      adapter: "mock",
      status: "completed",
      attempt: 1,
      endedAt: new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString(),
      metadata: {
        [RUN_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString(),
          status: "completed",
          messageCount: 1,
          toolCallCount: 0,
          indexedToolCallCount: 0,
          summaryText: `Prior run ${index} summary.`,
        },
      },
    }));

    const session = makeSession({
      metadata: {
        [SESSION_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString(),
          sessionStatus: "active",
          taskCount: 3,
          completedTaskCount: 2,
          failedTaskCount: 0,
          cancelledTaskCount: 0,
          runCount: 3,
          completedRunCount: 3,
          failedRunCount: 0,
          cancelledRunCount: 0,
          latestTaskIds: [task.id],
          latestRunIds: priorRuns.map((run) => run.id),
          summaryText: "Older session summary.",
        },
        [SESSION_GRAPH_INDEX_METADATA_KEY]: {
          version: "1",
          generatedAt: now.toISOString(),
          sessionId: "sess_1",
          taskIds: [task.id, dependencyTask.id],
          nodes: [],
          edges: [],
        },
      },
    });

    const snapshot = await buildContextSnapshot({
      run: makeRun(),
      task: taskWithDeps,
      policy: {
        context: "inject",
        memory: "platform",
        tasks: "observe-native",
        artifacts: "observe",
      },
      memoryApi,
      store: makeStore({
        sessions: [session],
        tasks: [taskWithDeps, dependencyTask],
        runs: priorRuns,
      }),
    });

    expect(snapshot.blocks.length).toBe(6);
    expect(snapshot.blocks.some((block) => block.metadata?.["sourceType"] === "session-summary")).toBe(false);
    expect(snapshot.explanation?.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceRef: "sess_1" }),
      ]),
    );
  });

  test("session summaries avoid embedding nested task summaries", async () => {
    const memoryApi = makeMemoryApi();
    const now = new Date().toISOString();
    const task = makeTask({
      status: "completed",
      metadata: {
        [TASK_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: now,
          taskStatus: "completed",
          runCount: 2,
          completedRunCount: 2,
          failedRunCount: 0,
          cancelledRunCount: 0,
          indexedToolCallCount: 1,
          latestRunIds: ["run_prev"],
          recentReadFilePaths: ["/README.md"],
          recentEditedFilePaths: ["/app/routes/tasks.py"],
          recentCommandPreviews: ["pytest -q"],
          recentFailureHints: ["pytest: one tasks-route validation still fails"],
          latestAssistantOutputPreview: "Remaining work is isolated to tasks route validation.",
          summaryText: "Task summary says auth work already has one successful attempt.",
        },
      },
    });
    const session = makeSession({
      metadata: {
        [SESSION_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: now,
          sessionStatus: "active",
          taskCount: 1,
          completedTaskCount: 1,
          failedTaskCount: 0,
          cancelledTaskCount: 0,
          runCount: 1,
          completedRunCount: 1,
          failedRunCount: 0,
          cancelledRunCount: 0,
          latestTaskIds: [task.id],
          latestRunIds: ["run_prev"],
          summaryText: "Session summary placeholder.",
        },
        [SESSION_GRAPH_INDEX_METADATA_KEY]: {
          version: "1",
          generatedAt: now,
          sessionId: "sess_1",
          taskIds: [task.id],
          nodes: [],
          edges: [],
        },
      },
    });

    const snapshot = await buildContextSnapshot({
      run: makeRun(),
      task,
      policy: {
        context: "inject",
        memory: "off",
        tasks: "observe-native",
        artifacts: "observe",
      },
      memoryApi,
      store: makeStore({ sessions: [session], tasks: [task] }),
    });

    const sessionSummaryBlock = snapshot.blocks.find((block) => block.metadata?.["sourceType"] === "session-summary");
    expect(sessionSummaryBlock?.content).not.toContain("latest task:");
  });

  test("context token budget can drop lower-priority hard recall blocks", async () => {
    const memoryApi = makeMemoryApi();
    const preloadHits: MemorySearchHit[] = Array.from({ length: 20 }, (_, index) => ({
      record: {
        id: `mem_profile_${index}`,
        workspaceId: "ws_1",
        userId: "user_1",
        ownerRef: { type: "user" as const, id: "user_1" },
        scope: "user" as const,
        layer: "long_term" as const,
        channel: "profile" as const,
        kind: "preference" as const,
        status: "active" as const,
        title: `Coding style ${index}`,
        content: `Prefer compact helper style ${index}. ${"detail ".repeat(120)}`,
        summary: `Preferred style ${index}. ${"signal ".repeat(80)}`,
        importance: 0.95,
        confidence: 0.9,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      finalScore: 0.97 - index * 0.01,
    }));
    const task = makeTask();

    const snapshot = await buildContextSnapshot({
      run: makeRun(),
      task,
      policy: {
        context: "inject",
        memory: "off",
        tasks: "observe-native",
        artifacts: "observe",
      },
      memoryApi,
      store: makeStore({ tasks: [task] }),
      preloadedMemoryHits: preloadHits,
    });

    expect(snapshot.blocks.some((block) => block.metadata?.["sourceType"] === "task")).toBe(true);
    expect(snapshot.blocks.length).toBeLessThan(preloadHits.length + 1);
    expect(snapshot.tokenEstimate).toBeLessThanOrEqual(900);
  });
});



