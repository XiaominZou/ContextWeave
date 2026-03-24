import { describe, expect, test, vi } from "vitest";

import { defaultCapabilityPolicy } from "@ctx/core";
import { PLATFORM_MEMORY_SEARCH_TOOL, PLATFORM_MEMORY_WRITE_TOOL } from "@ctx/adapter-kit";
import { createTestPlatform, drainHandle, RawMockAdapter } from "@ctx/testing";
import { RUN_SUMMARY_METADATA_KEY, TOOL_CALL_REFS_METADATA_KEY } from "../internal/run-derived-context";
import { TASK_SUMMARY_METADATA_KEY } from "../internal/task-derived-context";
import { SESSION_SUMMARY_METADATA_KEY } from "../internal/session-derived-context";
import { RUN_GRAPH_INDEX_METADATA_KEY, SESSION_GRAPH_INDEX_METADATA_KEY, TASK_GRAPH_INDEX_METADATA_KEY } from "../internal/session-graph";
import { SESSION_AUTO_CONSOLIDATION_METADATA_KEY } from "../internal/session-auto-consolidation";
import { TASK_NATIVE_MIRROR_METADATA_KEY } from "../internal/task-native-mirror";
import type {
  Checkpoint,
  ConsolidateTaskInput,
  MemoryEngine,
  MemoryRecordV1_1,
  MemorySearchQuery,
  Task,
  PromoteMemoryInput,
  WriteConfirmedInput,
  WriteExperienceInput,
} from "@ctx/core";

function makeExperienceRecord(id = "mem_1"): MemoryRecordV1_1 {
  const now = new Date().toISOString();
  return {
    id,
    workspaceId: "ws_1",
    sessionId: "sess_1",
    taskId: "task_1",
    runId: "run_1",
    ownerRef: { type: "run", id: "run_1" },
    scope: "run",
    layer: "experience",
    channel: "collection",
    kind: "insight",
    status: "candidate",
    title: "Run experience",
    content: "Prompt: test",
    summary: "Run completed for prompt test",
    importance: 0.55,
    confidence: 0.6,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function createMemoryEngine() {
  return {
    search: vi.fn(async (_query: MemorySearchQuery) => ({
      hits: [],
      namespacesSearched: [],
    })),
    writeExperience: vi.fn(async (_input: WriteExperienceInput) => makeExperienceRecord()),
    writeConfirmed: vi.fn(async (_input: WriteConfirmedInput) => makeExperienceRecord("mem_confirmed")),
    consolidateTask: vi.fn(async (_input: ConsolidateTaskInput) => []),
    promote: vi.fn(async (_input: PromoteMemoryInput) => ({
      memoryId: "mem_1",
      action: "NONE" as const,
    })),
  } satisfies MemoryEngine;
}

describe("Run lifecycle", () => {
  test("runs.start() returns RunHandle with runId", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
    });

    expect(handle.runId).toMatch(/^run_/);
    expect(typeof handle.streamEvents).toBe("function");
  });

  test("run status transitions to completed after terminal event", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "text_delta", text: "hello" },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
    });

    const runWhileStreaming = await client.runs.get(handle.runId);
    expect(runWhileStreaming.status).toBe("running");

    await drainHandle(handle);

    const runAfter = await client.runs.get(handle.runId);
    expect(runAfter.status).toBe("completed");
    expect(runAfter.externalRef).toBe("mock-ext-ref-123");
    expect(runAfter.endedAt).toBeDefined();
  });

  test("run usage is accumulated from run.usage events", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "run_usage", inputTokens: 120, outputTokens: 30 },
            { type: "run_usage", inputTokens: 80, outputTokens: 20 },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
    });

    await drainHandle(handle);

    const runAfter = await client.runs.get(handle.runId);
    expect(runAfter.usage).toEqual({
      inputTokens: 200,
      outputTokens: 50,
    });
  });

  test("all normalized events are stored", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "text_delta", text: "hello" },
            { type: "message_completed", messageId: "msg_1" },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });
    const handle = await client.runs.start({ workspaceId: "ws_1", sessionId: session.id, taskId: task.id, adapter: "mock" });

    const received = await drainHandle(handle);
    const stored = await client.events.list({ runId: handle.runId });

    expect(received).toHaveLength(4);
    expect(stored.items).toHaveLength(4);
    expect(stored.items.map((event) => event.type)).toEqual(received.map((event) => event.type));
  });

  test("memory engine stays passive when policy remains native/off", async () => {
    const memoryEngine = createMemoryEngine();
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
      memory: {
        engine: memoryEngine,
      },
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: defaultCapabilityPolicy,
    });

    const events = await drainHandle(handle);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.completed",
    ]);
    expect(memoryEngine.search).not.toHaveBeenCalled();
    expect(memoryEngine.writeExperience).not.toHaveBeenCalled();
  });

  test("memory=platform injects context and emits memory.extracted after completion", async () => {
    const memoryEngine = createMemoryEngine();
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
      memory: {
        engine: memoryEngine,
      },
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
        memory: "platform",
      },
      metadata: {
        prompt: "test extraction",
      },
    });

    const events = await drainHandle(handle);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.completed",
      "memory.extracted",
    ]);

    expect(memoryEngine.search).toHaveBeenCalledTimes(1);
    expect(memoryEngine.writeExperience).toHaveBeenCalledTimes(1);
    expect(memoryEngine.writeExperience).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          layer: "experience",
          status: "candidate",
          kind: "insight",
          scope: "run",
          ownerRef: { type: "run", id: expect.stringMatching(/^run_/) },
        }),
      }),
    );

    const run = await client.runs.get(handle.runId);
    expect(run.snapshotId).toMatch(/^ctx_/);
    expect(run.capabilityPolicy).toEqual({
      ...defaultCapabilityPolicy,
      context: "inject",
      memory: "platform",
    });

    const stored = await client.events.list({ runId: handle.runId });
    expect(stored.items.at(-1)).toMatchObject({
      type: "memory.extracted",
      payload: { memoryIds: ["mem_1"], runId: handle.runId },
    });
  });

  test("tasks=platform-tools exposes platform task tools without failing start", async () => {
    const adapter = new RawMockAdapter({
      rawEvents: [
        { type: "run_started", model: "mock-model" },
        { type: "run_completed", reason: "end_turn" },
      ],
    });
    const { client } = createTestPlatform({ adapters: [adapter] });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "task bridge" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "track release" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        tasks: "platform-tools",
      },
    });

    const events = await drainHandle(handle);
    expect(events.map((event) => event.type)).toEqual(["run.started", "run.completed"]);

    expect(adapter.lastRenderedPayload).toMatchObject({ mode: "sdk" });
    expect(adapter.lastRenderedPayload?.mode === "sdk" ? adapter.lastRenderedPayload.tools?.map((tool) => tool.name) : []).toEqual(
      expect.arrayContaining(["platform_task_get", "platform_task_list", "platform_task_update"]),
    );

    const updatedTask = await client.tasks.update(task.id, {
      status: "completed",
      title: "release tracked",
    });
    expect(updatedTask).toMatchObject({
      id: task.id,
      title: "release tracked",
      status: "completed",
    });
  });

  test("tasks=mirror-native mirrors native todo tool state into canonical task metadata", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            {
              type: "tool_call",
              callId: "call_todo_write",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Inspect failing tests", status: "completed" },
                  { content: "Patch snapshot builder", status: "in_progress" },
                  { content: "Run typecheck", status: "pending" },
                ],
              },
            },
            {
              type: "tool_result",
              callId: "call_todo_write",
              output: {
                todos: [
                  { content: "Inspect failing tests", status: "completed" },
                  { content: "Patch snapshot builder", status: "in_progress" },
                  { content: "Run typecheck", status: "pending" },
                ],
              },
            },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "native todo mirror" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "repair context loading" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
        tasks: "mirror-native",
      },
    });

    const events = await drainHandle(handle);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.call",
      "tool.result",
      "run.completed",
    ]);

    const mirroredTask = await client.tasks.get(task.id);
    const mirror = (mirroredTask.metadata ?? {})[TASK_NATIVE_MIRROR_METADATA_KEY] as {
      sourceToolName: string;
      itemCount: number;
      completedCount: number;
      inProgressCount: number;
      pendingCount: number;
      currentFocus?: string;
      summaryText: string;
    };

    expect(mirroredTask.status).toBe("running");
    expect(mirror).toMatchObject({
      sourceToolName: "TodoWrite",
      itemCount: 3,
      completedCount: 1,
      inProgressCount: 1,
      pendingCount: 1,
      currentFocus: "Patch snapshot builder",
    });
    expect(mirror.summaryText).toContain("Native task mirror from TodoWrite");

    const preview = await client.experimental!.context.preview({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      policy: {
        ...defaultCapabilityPolicy,
        context: "inject",
        tasks: "mirror-native",
      },
    });
    const taskBlock = preview.snapshot.blocks.find((block) => block.sourceRef === task.id);
    expect(taskBlock?.content).toContain("Native mirror:");
    expect(taskBlock?.content).toContain("Patch snapshot builder");
  });

  test("memory=tool-bridge exposes bridge tools without automatic retrieval or extraction", async () => {
    const memoryEngine = createMemoryEngine();
    const adapter = new RawMockAdapter({
      rawEvents: [
        { type: "run_started", model: "mock-model" },
        { type: "run_completed", reason: "end_turn" },
      ],
    });
    const { client } = createTestPlatform({
      adapters: [adapter],
      memory: {
        engine: memoryEngine,
      },
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        memory: "tool-bridge",
      },
    });

    const events = await drainHandle(handle);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.completed",
    ]);
    expect(memoryEngine.search).not.toHaveBeenCalled();
    expect(memoryEngine.writeExperience).not.toHaveBeenCalled();

    expect(adapter.lastRenderedPayload).toMatchObject({
      mode: "sdk",
    });
    expect(adapter.lastRenderedPayload?.mode === "sdk" ? adapter.lastRenderedPayload.tools?.map((tool) => tool.name) : []).toEqual(
      expect.arrayContaining([PLATFORM_MEMORY_SEARCH_TOOL, PLATFORM_MEMORY_WRITE_TOOL]),
    );

    const run = await client.runs.get(handle.runId);
    expect(run.snapshotId).toBeUndefined();
    expect(run.capabilityPolicy).toEqual({
      ...defaultCapabilityPolicy,
      memory: "tool-bridge",
    });
  });

  test("artifacts=capture-store persists artifact records and emits artifact.created", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "tool_call", callId: "call_artifact", name: "write_file", input: { path: "report.md" } },
            {
              type: "tool_result",
              callId: "call_artifact",
              output: {
                artifactId: "art_report",
                type: "text",
                uri: "file:///workspace/report.md",
                title: "Release report",
                summary: "Summarized validation results.",
                mimeType: "text/markdown",
              },
            },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "artifact capture" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "write report" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
        artifacts: "capture-store",
      },
    });

    const events = await drainHandle(handle);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.call",
      "tool.result",
      "artifact.created",
      "run.completed",
    ]);

    const artifacts = await client.experimental!.artifacts.list({ runId: handle.runId });
    expect(artifacts.items).toHaveLength(1);
    expect(artifacts.items[0]).toMatchObject({
      id: "art_report",
      taskId: task.id,
      runId: handle.runId,
      type: "text",
      uri: "file:///workspace/report.md",
      title: "Release report",
      summary: "Summarized validation results.",
      mimeType: "text/markdown",
      metadata: expect.objectContaining({
        toolCallId: "call_artifact",
        toolName: "write_file",
        captureMode: "capture-store",
      }),
    });

    const artifact = await client.experimental!.artifacts.get("art_report");
    expect(artifact.id).toBe("art_report");

    await client.experimental!.artifacts.delete("art_report");
    await expect(client.experimental!.artifacts.get("art_report")).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  });

  test("run completion asynchronously persists run summary and indexed tool call refs", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "tool_call", callId: "call_error", name: "bash", input: { command: "npm test" } },
            { type: "tool_result", callId: "call_error", output: { message: "boom" }, isError: true },
            { type: "tool_call", callId: "call_artifact", name: "write_file", input: { path: "report.md" } },
            { type: "tool_result", callId: "call_artifact", output: { artifactId: "art_1", artifacts: [{ id: "art_2" }] } },
            { type: "tool_call", callId: "call_ignored", name: "pwd", input: {} },
            { type: "tool_result", callId: "call_ignored", output: { ok: true } },
            { type: "text_delta", text: "Final answer" },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      metadata: {
        prompt: "summarize tool activity",
      },
    });

    await drainHandle(handle);

    await vi.waitFor(async () => {
      const run = await client.runs.get(handle.runId);
      const metadata = run.metadata as Record<string, unknown> | undefined;
      expect(metadata?.[RUN_SUMMARY_METADATA_KEY]).toBeDefined();
      expect(metadata?.[TOOL_CALL_REFS_METADATA_KEY]).toBeDefined();
      expect(metadata?.[RUN_GRAPH_INDEX_METADATA_KEY]).toBeDefined();
    });

    const run = await client.runs.get(handle.runId);
    const metadata = run.metadata as Record<string, unknown>;
    const summary = metadata[RUN_SUMMARY_METADATA_KEY] as {
      status: string;
      completionReason?: string;
      toolCallCount: number;
      indexedToolCallCount: number;
      assistantOutputPreview?: string;
      summaryText: string;
    };
    const toolRefs = metadata[TOOL_CALL_REFS_METADATA_KEY] as Array<{
      callId: string;
      toolName: string;
      inputSignature: string;
      isError: boolean;
      hasArtifact: boolean;
      artifactIds: string[];
      summaryText: string;
    }>;

    expect(summary).toMatchObject({
      status: "completed",
      completionReason: "end_turn",
      toolCallCount: 3,
      indexedToolCallCount: 2,
      assistantOutputPreview: "Final answer",
    });
    expect(summary.summaryText).toContain(handle.runId);

    expect(toolRefs).toHaveLength(2);
    expect(toolRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callId: "call_error",
          toolName: "bash",
          isError: true,
          hasArtifact: false,
          inputSignature: 'bash:{"command":"npm test"}',
        }),
        expect.objectContaining({
          callId: "call_artifact",
          toolName: "write_file",
          isError: false,
          hasArtifact: true,
          artifactIds: ["art_1", "art_2"],
        }),
      ]),
    );
    expect(toolRefs.find((ref) => ref.callId === "call_ignored")).toBeUndefined();
  });

  test("task completion persists aggregated task summary from prior runs", async () => {
    const { client, store } = createTestPlatform({
      adapters: [new RawMockAdapter({ rawEvents: [] })],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "task summary" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "task summary" });

    store.saveRun({
      id: "run_done",
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      status: "completed",
      attempt: 1,
      endedAt: "2026-03-23T10:00:00.000Z",
      metadata: {
        [RUN_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: "2026-03-23T10:00:00.000Z",
          status: "completed",
          completionReason: "end_turn",
          messageCount: 1,
          toolCallCount: 1,
          indexedToolCallCount: 1,
          assistantOutputPreview: "done",
          summaryText: "Run run_done completed cleanly.",
        },
        [TOOL_CALL_REFS_METADATA_KEY]: [
          {
            version: "1",
            callId: "call_1",
            toolName: "bash",
            inputSignature: "bash:{}",
            isError: true,
            hasArtifact: false,
            artifactIds: [],
            summaryText: "bash resulted in an error",
            callEventId: "evt_1",
          },
        ],
      },
    });
    store.saveRun({
      id: "run_fail",
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      status: "failed",
      attempt: 1,
      endedAt: "2026-03-23T11:00:00.000Z",
      error: { code: "UPSTREAM", message: "boom" },
      metadata: {
        [RUN_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: "2026-03-23T11:00:00.000Z",
          status: "failed",
          messageCount: 0,
          toolCallCount: 0,
          indexedToolCallCount: 0,
          errorCode: "UPSTREAM",
          errorMessage: "boom",
          summaryText: "Run run_fail failed with boom.",
        },
      },
    });

    const completedTask = await client.tasks.complete(task.id);
    const metadata = completedTask.metadata as Record<string, unknown>;
    const graphIndex = metadata[TASK_GRAPH_INDEX_METADATA_KEY] as { dependencyTaskIds: string[]; latestRunIds: string[] };
    const summary = metadata[TASK_SUMMARY_METADATA_KEY] as {
      taskStatus: string;
      runCount: number;
      completedRunCount: number;
      failedRunCount: number;
      indexedToolCallCount: number;
      latestRunIds: string[];
      summaryText: string;
    };

    expect(summary).toMatchObject({
      taskStatus: "completed",
      runCount: 2,
      completedRunCount: 1,
      failedRunCount: 1,
      indexedToolCallCount: 1,
      latestRunIds: ["run_fail", "run_done"],
    });
    expect(summary.summaryText).toContain("runs: 2");
    expect(summary.summaryText).toContain("latest run: Run run_fail failed with boom.");
    expect(graphIndex.latestRunIds).toEqual(["run_fail", "run_done"]);
    expect(graphIndex.dependencyTaskIds).toEqual([]);
  });

  test("session archive persists aggregated session summary and writes session memory", async () => {
    const memoryEngine = createMemoryEngine();
    const { client, store } = createTestPlatform({
      adapters: [new RawMockAdapter({ rawEvents: [] })],
      memory: {
        engine: memoryEngine,
      },
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "release prep" });
    const taskA = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "task a" });
    const taskB = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "task b" });

    store.saveTask({
      ...mustTask(store, taskA.id),
      status: "completed",
      completedAt: "2026-03-23T10:00:00.000Z",
      metadata: {
        [TASK_SUMMARY_METADATA_KEY]: {
          version: "1",
          generatedAt: "2026-03-23T10:00:00.000Z",
          taskStatus: "completed",
          runCount: 1,
          completedRunCount: 1,
          failedRunCount: 0,
          cancelledRunCount: 0,
          indexedToolCallCount: 0,
          latestRunIds: ["run_a"],
          summaryText: "Task A completed the release checklist.",
        },
      },
    });
    store.saveTask({
      ...mustTask(store, taskB.id),
      status: "failed",
      completedAt: "2026-03-23T11:00:00.000Z",
    });

    store.saveRun({
      id: "run_a",
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: taskA.id,
      adapter: "mock",
      status: "completed",
      attempt: 1,
      endedAt: "2026-03-23T10:00:00.000Z",
    });
    store.saveRun({
      id: "run_b",
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: taskB.id,
      adapter: "mock",
      status: "failed",
      attempt: 1,
      endedAt: "2026-03-23T11:00:00.000Z",
      error: { code: "UPSTREAM", message: "boom" },
    });

    const archivedSession = await client.sessions.archive(session.id);
    const metadata = archivedSession.metadata as Record<string, unknown>;
    const graphIndex = metadata[SESSION_GRAPH_INDEX_METADATA_KEY] as { taskIds: string[]; edges: Array<{ kind: string }> };
    const summary = metadata[SESSION_SUMMARY_METADATA_KEY] as {
      sessionStatus: string;
      taskCount: number;
      completedTaskCount: number;
      failedTaskCount: number;
      runCount: number;
      failedRunCount: number;
      latestTaskIds: string[];
      latestRunIds: string[];
      summaryText: string;
    };

    expect(archivedSession.status).toBe("archived");
    expect(summary).toMatchObject({
      sessionStatus: "archived",
      taskCount: 2,
      completedTaskCount: 1,
      failedTaskCount: 1,
      runCount: 2,
      failedRunCount: 1,
      latestTaskIds: [taskB.id, taskA.id],
      latestRunIds: ["run_b", "run_a"],
    });
    expect(summary.summaryText).toContain("tasks: 2");
    expect(summary.summaryText).toContain("latest task: Task A completed the release checklist.");
    expect(graphIndex.taskIds).toEqual([taskA.id, taskB.id]);
    expect(Array.isArray(graphIndex.edges)).toBe(true);

    expect(memoryEngine.writeExperience).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          scope: "session",
          ownerRef: { type: "session", id: session.id },
          sessionId: session.id,
          title: "release prep session summary",
        }),
      }),
    );
  });

  test("task completion auto-consolidates a settled active session once", async () => {
    const memoryEngine = createMemoryEngine();
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
      memory: {
        engine: memoryEngine,
      },
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "auto finish" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "final task" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
        memory: "platform",
      },
    });
    await drainHandle(handle);

    await client.tasks.complete(task.id);

    const settledSession = await client.sessions.get(session.id);
    const metadata = settledSession.metadata as Record<string, unknown>;
    const autoState = metadata[SESSION_AUTO_CONSOLIDATION_METADATA_KEY] as { reason: string; signature: string };
    const summary = metadata[SESSION_SUMMARY_METADATA_KEY] as { taskCount: number; runCount: number; summaryText: string };

    expect(settledSession.status).toBe("active");
    expect(autoState.reason).toBe("task.completed");
    expect(typeof autoState.signature).toBe("string");
    expect(summary).toMatchObject({
      taskCount: 1,
      runCount: 1,
    });
    expect(summary.summaryText).toContain("tasks: 1");
    expect(memoryEngine.writeExperience).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          scope: "session",
          ownerRef: { type: "session", id: session.id },
          title: "auto finish session summary",
        }),
      }),
    );

    const sessionScopedWrites = memoryEngine.writeExperience.mock.calls.filter((call) => {
      const input = call[0] as WriteExperienceInput;
      return input.record.scope === "session" && input.record.ownerRef.id === session.id;
    });
    expect(sessionScopedWrites).toHaveLength(1);

    await client.tasks.complete(task.id);
    const sessionScopedWritesAfterSecondComplete = memoryEngine.writeExperience.mock.calls.filter((call) => {
      const input = call[0] as WriteExperienceInput;
      return input.record.scope === "session" && input.record.ownerRef.id === session.id;
    });
    expect(sessionScopedWritesAfterSecondComplete).toHaveLength(1);
  });

  test("auto session consolidation waits until all tasks reach terminal state", async () => {
    const memoryEngine = createMemoryEngine();
    const { client } = createTestPlatform({
      adapters: [new RawMockAdapter({ rawEvents: [] })],
      memory: {
        engine: memoryEngine,
      },
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "partial finish" });
    const doneTask = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "done task" });
    await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "pending task" });

    await client.tasks.complete(doneTask.id);

    const currentSession = await client.sessions.get(session.id);
    const metadata = (currentSession.metadata ?? {}) as Record<string, unknown>;
    expect(metadata[SESSION_SUMMARY_METADATA_KEY]).toBeUndefined();
    expect(metadata[SESSION_AUTO_CONSOLIDATION_METADATA_KEY]).toBeUndefined();

    const sessionScopedWrites = memoryEngine.writeExperience.mock.calls.filter((call) => {
      const input = call[0] as WriteExperienceInput;
      return input.record.scope === "session" && input.record.ownerRef.id === session.id;
    });
    expect(sessionScopedWrites).toHaveLength(0);
  });

  test("session-level profile preload is cached across runs and injected into context", async () => {
    const now = new Date().toISOString();
    const profileRecord: MemoryRecordV1_1 = {
      id: "mem_profile",
      workspaceId: "ws_1",
      userId: "user_1",
      ownerRef: { type: "user", id: "user_1" },
      scope: "user",
      layer: "long_term",
      channel: "profile",
      kind: "preference",
      status: "active",
      title: "Coding style",
      content: "Prefer tiny pure helper functions.",
      summary: "Preferred code style: tiny pure helper functions.",
      importance: 0.9,
      confidence: 0.95,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const taskRecord: MemoryRecordV1_1 = {
      id: "mem_task",
      workspaceId: "ws_1",
      ownerRef: { type: "workspace", id: "ws_1" },
      scope: "workspace",
      layer: "long_term",
      channel: "collection",
      kind: "procedure",
      status: "active",
      title: "Auth procedure",
      content: "Split middleware into validation and auth guards.",
      summary: "Auth middleware should be split into validation and auth guards.",
      importance: 0.8,
      confidence: 0.85,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const engine = {
      search: vi.fn(async (query: MemorySearchQuery) => {
        if (query.channel === "profile") {
          return {
            hits: [{ record: profileRecord, finalScore: 0.97 }],
            namespacesSearched: [{ scope: "user" as const, ownerId: "user_1" }],
          };
        }
        return {
          hits: [{ record: taskRecord, finalScore: 0.83 }],
          namespacesSearched: [{ scope: "workspace" as const, ownerId: "ws_1" }],
        };
      }),
      writeExperience: vi.fn(async (_input: WriteExperienceInput) => makeExperienceRecord()),
      writeConfirmed: vi.fn(async (_input: WriteConfirmedInput) => makeExperienceRecord("mem_confirmed")),
      consolidateTask: vi.fn(async (_input: ConsolidateTaskInput) => []),
      promote: vi.fn(async (_input: PromoteMemoryInput) => ({
        memoryId: "mem_1",
        action: "NONE" as const,
      })),
    } satisfies MemoryEngine;

    const adapter = new RawMockAdapter({
      rawEvents: [
        { type: "run_started", model: "mock-model" },
        { type: "run_completed", reason: "end_turn" },
      ],
    });
    const { client } = createTestPlatform({
      adapters: [adapter],
      memory: {
        engine,
      },
    });

    const session = await client.sessions.create({
      workspaceId: "ws_1",
      title: "profile preload",
      metadata: { userId: "user_1" },
    });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "auth refactor" });

    const handle1 = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
        memory: "platform",
      },
    });
    await drainHandle(handle1);

    expect(adapter.lastRenderedPayload?.mode === "sdk" ? adapter.lastRenderedPayload.systemPrompt : "").toContain(
      "Preferred code style: tiny pure helper functions.",
    );

    const handle2 = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
        memory: "platform",
      },
      metadata: { prompt: "second pass" },
    });
    await drainHandle(handle2);

    const calls = engine.search.mock.calls.map((call) => call[0] as MemorySearchQuery);
    expect(calls.filter((query) => query.channel === "profile")).toHaveLength(1);
    expect(calls.filter((query) => query.channel !== "profile")).toHaveLength(2);
  });
  test("checkpoint and resume round-trip persists canonical checkpoint and starts a new resumed run", async () => {
    const adapter = new RawMockAdapter({
      rawEvents: [
        { type: "run_started", model: "mock-model" },
        { type: "text_delta", text: "before checkpoint" },
        { type: "run_completed", reason: "end_turn" },
      ],
      checkpointPayload: { cursor: "step_2" },
      resumeRawEvents: [
        { type: "run_started", model: "mock-model" },
        { type: "text_delta", text: "after resume" },
        { type: "run_completed", reason: "resumed" },
      ],
    });
    const { client, store } = createTestPlatform({ adapters: [adapter] });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "checkpoint" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "resume work" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
    });

    const checkpoint = await handle.checkpoint();
    expect(checkpoint).toMatchObject({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      runId: handle.runId,
      adapter: "mock",
      payload: {
        version: "1",
        adapter: "mock",
        createdAt: expect.any(String),
        payload: { cursor: "step_2" },
      },
    } satisfies Partial<Checkpoint>);
    expect(store.getCheckpoint(checkpoint.id)).toBeDefined();

    const initialEvents = await drainHandle(handle);
    expect(initialEvents.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "checkpoint.created",
      "run.completed",
    ]);

    const resumedHandle = await client.runs.resume({
      checkpointId: checkpoint.id,
      metadata: { prompt: "continue" },
    });
    const resumedEvents = await drainHandle(resumedHandle);
    expect(resumedEvents.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "run.completed",
    ]);

    const resumedRun = await client.runs.get(resumedHandle.runId);
    expect(resumedRun).toMatchObject({
      adapter: "mock",
      status: "completed",
      attempt: 2,
      metadata: expect.objectContaining({
        resumedFromCheckpointId: checkpoint.id,
        resumedFromRunId: handle.runId,
      }),
    });
  });

  test("interrupt transitions run to cancelled", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "text_delta", text: "still running" },
            { type: "run_completed", reason: "should-not-reach" },
          ],
          delayMs: 50,
        }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
    });

    await handle.interrupt();
    const events = await drainHandle(handle);

    expect(events).toEqual([]);

    const run = await client.runs.get(handle.runId);
    expect(run.status).toBe("cancelled");
    expect(run.endedAt).toBeDefined();
  });

  test("stream failure without terminal event closes run as failed", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "text_delta", text: "hello" },
          ],
          throwAfterEventCount: 1,
          streamErrorMessage: "stream crashed",
        }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
    });

    await drainHandle(handle);

    const run = await client.runs.get(handle.runId);
    expect(run.status).toBe("failed");
    expect(run.error?.message).toContain("stream crashed");
  });

  test("first terminal event wins when adapter emits conflicting terminal events", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "run_failed", error: { code: "UPSTREAM_ERROR", message: "parser failed" } },
            { type: "run_completed", reason: "should-not-override" },
          ],
        }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    const handle = await client.runs.start({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
    });

    await drainHandle(handle);

    const run = await client.runs.get(handle.runId);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "UPSTREAM_ERROR", message: "parser failed" });

    const stored = await client.events.list({ runId: handle.runId });
    expect(stored.items.map((event) => event.type)).toEqual([
      "run.started",
      "run.failed",
      "run.completed",
    ]);
  });
});

describe("Run start validation", () => {
  test("POLICY_CONFLICT creates failed-before-start run record", async () => {
    const { client } = createTestPlatform({
      adapters: [new RawMockAdapter({ rawEvents: [] })],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    await expect(
      client.runs.start({
        workspaceId: "ws_1",
        sessionId: session.id,
        taskId: task.id,
        adapter: "mock",
        capabilityPolicy: { ...defaultCapabilityPolicy, context: "native", memory: "platform" },
      }),
    ).rejects.toMatchObject({ code: "POLICY_CONFLICT" });

    const runs = await client.runs.list({ taskId: task.id });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]?.status).toBe("failed");
    expect(runs.items[0]?.error?.code).toBe("POLICY_CONFLICT");
  });

  test("CAPABILITY_NOT_SUPPORTED is returned before NOT_ENABLED when adapter cannot intercept requested capability", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({ rawEvents: [], capabilitySupport: { tasks: "observe-only" } }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    await expect(
      client.runs.start({
        workspaceId: "ws_1",
        sessionId: session.id,
        taskId: task.id,
        adapter: "mock",
        capabilityPolicy: { ...defaultCapabilityPolicy, tasks: "platform-tools" },
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED" });
  });

  test("mirror-native fails before start when adapter cannot intercept tasks capability", async () => {
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({ rawEvents: [], capabilitySupport: { tasks: "observe-only" } }),
      ],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    await expect(
      client.runs.start({
        workspaceId: "ws_1",
        sessionId: session.id,
        taskId: task.id,
        adapter: "mock",
        capabilityPolicy: { ...defaultCapabilityPolicy, tasks: "mirror-native" },
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_NOT_SUPPORTED" });
  });

  test("memory=tool-bridge fails before start when no memory engine is configured", async () => {
    const { client } = createTestPlatform({
      adapters: [new RawMockAdapter({ rawEvents: [] })],
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "test" });

    await expect(
      client.runs.start({
        workspaceId: "ws_1",
        sessionId: session.id,
        taskId: task.id,
        adapter: "mock",
        capabilityPolicy: { ...defaultCapabilityPolicy, memory: "tool-bridge" },
      }),
    ).rejects.toMatchObject({ code: "NOT_ENABLED" });

    const runs = await client.runs.list({ taskId: task.id });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]?.status).toBe("failed");
    expect(runs.items[0]?.error?.code).toBe("NOT_ENABLED");
  });
});





function mustTask(store: { getTask(id: string): Task | undefined }, id: string): Task {
  const task = store.getTask(id);
  if (!task) {
    throw new Error(`Task not found in test store: ${id}`);
  }
  return task;
}

