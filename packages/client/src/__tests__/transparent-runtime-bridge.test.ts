import { describe, expect, test } from "vitest";

import { defaultCapabilityPolicy, type AgentEventEnvelope } from "@ctx/core";
import { createTestPlatform } from "@ctx/testing";
import { RUN_NATIVE_MIRROR_METADATA_KEY } from "../internal/run-native-mirror";
import { TASK_NATIVE_MIRROR_METADATA_KEY } from "../internal/task-native-mirror";

function createNormalizedEvent(type: AgentEventEnvelope["type"], payload: Record<string, unknown> = {}): AgentEventEnvelope {
  return {
    id: "evt_native",
    workspaceId: "wrong_ws",
    sessionId: "wrong_sess",
    taskId: "wrong_task",
    runId: "wrong_run",
    adapter: "native-runtime",
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

describe("Transparent runtime bridge", () => {
  test("prepareRun() creates a canonical run and prompt-ready context", async () => {
    const { client, platform } = createTestPlatform();
    const session = await client.sessions.create({ workspaceId: "ws_1", title: "bridge test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "Implement bridge path" });

    const prepared = await platform.runtime.bridge.prepareRun({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      runtime: "opencode-host",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
      },
    });

    expect(prepared.run.adapter).toBe("opencode-host");
    expect(prepared.run.status).toBe("queued");
    expect(prepared.policy.context).toBe("inject");
    expect(prepared.snapshot).not.toBeNull();
    expect(prepared.run.snapshotId).toBe(prepared.snapshot?.id);
    expect(prepared.prompt.systemPrompt).toContain("Implement bridge path");
  });

  test("ingestEvent() and finalizeRun() persist canonical run lifecycle", async () => {
    const { client, platform } = createTestPlatform();
    const session = await client.sessions.create({ workspaceId: "ws_1", title: "bridge test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "Implement bridge path" });

    const prepared = await platform.runtime.bridge.prepareRun({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      runtime: "opencode-host",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
      },
    });

    const started = await platform.runtime.bridge.ingestEvent({
      runId: prepared.run.id,
      rawEvent: { kind: "started" },
      normalizeEvent: () => createNormalizedEvent("run.started", { externalRef: "native-session-1" }),
    });
    const usage = await platform.runtime.bridge.ingestEvent({
      runId: prepared.run.id,
      rawEvent: { kind: "usage" },
      normalizeEvent: () => createNormalizedEvent("run.usage", { inputTokens: 25, outputTokens: 7 }),
    });
    const completedRun = await platform.runtime.bridge.finalizeRun({
      runId: prepared.run.id,
      status: "completed",
      reason: "end_turn",
    });

    expect(started.events).toHaveLength(1);
    expect(started.run.status).toBe("running");
    expect(started.run.externalRef).toBe("native-session-1");
    expect(usage.run.usage).toEqual({ inputTokens: 25, outputTokens: 7 });
    expect(completedRun.status).toBe("completed");
    expect(completedRun.endedAt).toBeDefined();

    const storedEvents = await client.events.list({ runId: prepared.run.id });
    expect(storedEvents.items.map((event) => event.type)).toEqual([
      "run.started",
      "run.usage",
      "run.completed",
    ]);
  });

  test("ingestEvent() maintains lightweight native session/message mirror metadata on the run", async () => {
    const { client, platform } = createTestPlatform();
    const session = await client.sessions.create({ workspaceId: "ws_1", title: "bridge test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "Implement bridge path" });

    const prepared = await platform.runtime.bridge.prepareRun({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      runtime: "opencode-host",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
      },
    });

    await platform.runtime.bridge.ingestEvent({
      runId: prepared.run.id,
      rawEvent: { kind: "started" },
      normalizeEvent: () => createNormalizedEvent("run.started", { externalRef: "native-session-1" }),
    });
    await platform.runtime.bridge.ingestEvent({
      runId: prepared.run.id,
      rawEvent: { kind: "delta-1" },
      normalizeEvent: () => createNormalizedEvent("message.delta", { role: "assistant", text: "hello " }),
    });
    await platform.runtime.bridge.ingestEvent({
      runId: prepared.run.id,
      rawEvent: { kind: "delta-2" },
      normalizeEvent: () => createNormalizedEvent("message.delta", { role: "assistant", text: "world" }),
    });
    const afterCompleted = await platform.runtime.bridge.ingestEvent({
      runId: prepared.run.id,
      rawEvent: { kind: "message-completed" },
      normalizeEvent: () => createNormalizedEvent("message.completed", { messageId: "msg_native_1" }),
    });

    const mirror = (afterCompleted.run.metadata ?? {})[RUN_NATIVE_MIRROR_METADATA_KEY] as {
      nativeSessionRef?: string;
      latestMessageId?: string;
      assistantDeltaCount: number;
      assistantMessageCount: number;
      assistantCharCount: number;
    };

    expect(mirror.nativeSessionRef).toBe("native-session-1");
    expect(mirror.latestMessageId).toBe("msg_native_1");
    expect(mirror.assistantDeltaCount).toBe(2);
    expect(mirror.assistantMessageCount).toBe(1);
    expect(mirror.assistantCharCount).toBe("hello world".length);
  });

  test("createCheckpoint() persists canonical checkpoint metadata for transparent runs", async () => {
    const { client, platform, store } = createTestPlatform();
    const session = await client.sessions.create({ workspaceId: "ws_1", title: "bridge test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "Implement bridge path" });

    const prepared = await platform.runtime.bridge.prepareRun({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      runtime: "opencode-host",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
      },
      metadata: {
        prompt: "checkpoint bridge run",
      },
    });

    const created = await platform.runtime.bridge.createCheckpoint({
      runId: prepared.run.id,
      adapterVersion: "test-version",
    });

    expect(created.checkpoint).toMatchObject({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      runId: prepared.run.id,
      adapter: "opencode-host",
      payload: {
        version: "1",
        adapter: "opencode-host",
        adapterVersion: "test-version",
        payload: expect.objectContaining({
          kind: "transparent-runtime-checkpoint",
          runtime: "opencode-host",
          snapshotId: prepared.run.snapshotId,
        }),
      },
    });
    expect(created.event.type).toBe("checkpoint.created");
    expect(store.getCheckpoint(created.checkpoint.id)).toBeDefined();

    const storedEvents = await client.events.list({ runId: prepared.run.id });
    expect(storedEvents.items.some((event) => event.type === "checkpoint.created")).toBe(true);
  });

  test("prepareResumeRun() creates a new attempted run with checkpoint context", async () => {
    const { client, platform } = createTestPlatform();
    const session = await client.sessions.create({ workspaceId: "ws_1", title: "bridge test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "Implement bridge path" });

    const prepared = await platform.runtime.bridge.prepareRun({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      runtime: "opencode-host",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
      },
    });
    const created = await platform.runtime.bridge.createCheckpoint({
      runId: prepared.run.id,
    });

    const resumed = await platform.runtime.bridge.prepareResumeRun({
      checkpointId: created.checkpoint.id,
      metadata: {
        prompt: "continue from checkpoint",
      },
    });

    expect(resumed.run.attempt).toBe(2);
    expect(resumed.run.metadata).toMatchObject({
      prompt: "continue from checkpoint",
      resumedFromCheckpointId: created.checkpoint.id,
      resumedFromRunId: prepared.run.id,
    });
    expect(resumed.prompt.systemPrompt).toContain("[platform checkpoint resume]");
    expect(resumed.prompt.systemPrompt).toContain(created.checkpoint.id);
  });

  test("syncTask() updates canonical task state through the bridge", async () => {
    const { client, platform } = createTestPlatform();
    const session = await client.sessions.create({ workspaceId: "ws_1", title: "bridge test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "Implement bridge path" });

    const updated = await platform.runtime.bridge.syncTask({
      taskId: task.id,
      patch: {
        status: "running",
        metadata: { source: "bridge" },
      },
    });

    expect(updated.status).toBe("running");
    expect(updated.metadata).toMatchObject({ source: "bridge" });
  });

  test("ingestEvent() preserves mirror-native task behavior for todo events", async () => {
    const { client, platform } = createTestPlatform();
    const session = await client.sessions.create({ workspaceId: "ws_1", title: "bridge test" });
    const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "Implement bridge path" });

    const prepared = await platform.runtime.bridge.prepareRun({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      runtime: "opencode-host",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
        tasks: "mirror-native",
      },
    });

    await platform.runtime.bridge.ingestEvent({
      runId: prepared.run.id,
      rawEvent: { kind: "todo-call" },
      normalizeEvent: () => createNormalizedEvent("tool.call", {
        callId: "call_todo_write",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "Inspect bridge path", status: "completed" },
            { content: "Wire host runtime", status: "in_progress" },
          ],
        },
      }),
    });
    await platform.runtime.bridge.ingestEvent({
      runId: prepared.run.id,
      rawEvent: { kind: "todo-result" },
      normalizeEvent: () => createNormalizedEvent("tool.result", {
        callId: "call_todo_write",
        output: {
          todos: [
            { content: "Inspect bridge path", status: "completed" },
            { content: "Wire host runtime", status: "in_progress" },
            { content: "Run tests", status: "pending" },
          ],
        },
      }),
    });

    const mirroredTask = await client.tasks.get(task.id);
    const mirror = (mirroredTask.metadata ?? {})[TASK_NATIVE_MIRROR_METADATA_KEY] as {
      itemCount: number;
      completedCount: number;
      inProgressCount: number;
      pendingCount: number;
      currentFocus?: string;
    };

    expect(mirroredTask.status).toBe("running");
    expect(mirror.itemCount).toBe(3);
    expect(mirror.completedCount).toBe(1);
    expect(mirror.inProgressCount).toBe(1);
    expect(mirror.pendingCount).toBe(1);
    expect(mirror.currentFocus).toBe("Wire host runtime");
  });
});
