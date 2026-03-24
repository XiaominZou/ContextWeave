import { describe, expect, test } from "vitest";

import { defaultCapabilityPolicy, type MemoryRecordV1_1 } from "@ctx/core";
import { createInMemoryMemorySubsystem, createTestPlatform, drainHandle, RawMockAdapter } from "@ctx/testing";
import {
  RUN_SUMMARY_METADATA_KEY,
  SESSION_SUMMARY_METADATA_KEY,
  TASK_NATIVE_MIRROR_METADATA_KEY,
  TASK_SUMMARY_METADATA_KEY,
} from "@ctx/client";

function findLongTermRecord(records: Iterable<MemoryRecordV1_1>) {
  return [...records].find((record) => record.layer === "long_term");
}

describe("context platform demo", () => {
  test("end-to-end workflow keeps canonical state coherent", async () => {
    const memory = createInMemoryMemorySubsystem();
    const adapter = new RawMockAdapter({
      rawEvents: [
        { type: "run_started", model: "mock-model" },
        {
          type: "tool_call",
          callId: "todo_1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Inspect architecture docs", status: "completed" },
              { content: "Implement memory bridge", status: "in_progress" },
              { content: "Write release notes", status: "pending" },
            ],
          },
        },
        {
          type: "tool_result",
          callId: "todo_1",
          output: {
            todos: [
              { content: "Inspect architecture docs", status: "completed" },
              { content: "Implement memory bridge", status: "in_progress" },
              { content: "Write release notes", status: "pending" },
            ],
          },
        },
        { type: "tool_call", callId: "artifact_1", name: "write_file", input: { path: "summary.md" } },
        {
          type: "tool_result",
          callId: "artifact_1",
          output: {
            artifactId: "art_demo",
            type: "text",
            uri: "file:///workspace/summary.md",
            title: "Delivery summary",
            summary: "A short delivery summary.",
            mimeType: "text/markdown",
          },
        },
        { type: "text_delta", text: "Implemented the bridge and summarized the task." },
        { type: "run_completed", reason: "end_turn" },
      ],
      checkpointPayload: { cursor: "phase_2" },
      resumeRawEvents: [
        { type: "run_started", model: "mock-model" },
        { type: "text_delta", text: "Resumed from checkpoint and finished the task." },
        { type: "run_completed", reason: "resumed" },
      ],
    });

    const { client } = createTestPlatform({
      adapters: [adapter],
      memory,
    });

    const session = await client.sessions.create({
      workspaceId: "ws_demo",
      title: "SDK demo",
      metadata: { userId: "user_demo" },
    });
    const task = await client.tasks.create({
      workspaceId: "ws_demo",
      sessionId: session.id,
      title: "Ship a coherent context platform demo",
      objective: "Exercise context, memory, task mirroring, artifacts, and resume in one path.",
    });

    await client.experimental!.memory.writeConfirmed({
      record: {
        workspaceId: "ws_demo",
        userId: "user_demo",
        ownerRef: { type: "user", id: "user_demo" },
        scope: "user",
        layer: "long_term",
        channel: "profile",
        kind: "preference",
        status: "active",
        title: "Response style",
        content: "Prefer concise implementation summaries.",
        summary: "Prefer concise implementation summaries.",
        importance: 0.9,
        confidence: 0.95,
        confirmedBy: "user",
      },
    });

    const handle = await client.runs.start({
      workspaceId: "ws_demo",
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: {
        ...defaultCapabilityPolicy,
        context: "inject",
        memory: "platform",
        tasks: "mirror-native",
        artifacts: "capture-store",
      },
      metadata: {
        prompt: "Implement the bridge and capture reusable knowledge.",
        userId: "user_demo",
      },
    });

    const checkpoint = await handle.checkpoint();
    const firstRunEvents = await drainHandle(handle);
    expect(firstRunEvents.map((event) => event.type)).toEqual([
      "run.started",
      "tool.call",
      "checkpoint.created",
      "tool.result",
      "tool.call",
      "tool.result",
      "artifact.created",
      "message.delta",
      "run.completed",
      "memory.extracted",
    ]);

    const resumed = await client.runs.resume({
      checkpointId: checkpoint.id,
      metadata: { prompt: "finish the remaining work" },
    });
    const resumedEvents = await drainHandle(resumed);
    expect(resumedEvents.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "run.completed",
      "memory.extracted",
    ]);

    await client.tasks.complete(task.id);
    const archivedSession = await client.sessions.archive(session.id);

    const finalTask = await client.tasks.get(task.id);
    const taskMirror = (finalTask.metadata ?? {})[TASK_NATIVE_MIRROR_METADATA_KEY] as { summaryText: string };
    expect(taskMirror.summaryText).toContain("Native task mirror");

    const firstRun = await client.runs.get(handle.runId);
    expect((firstRun.metadata ?? {})[RUN_SUMMARY_METADATA_KEY]).toBeDefined();

    const secondRun = await client.runs.get(resumed.runId);
    expect(secondRun.attempt).toBe(2);

    const taskSummary = (finalTask.metadata ?? {})[TASK_SUMMARY_METADATA_KEY];
    const sessionSummary = (archivedSession.metadata ?? {})[SESSION_SUMMARY_METADATA_KEY];
    expect(taskSummary).toBeDefined();
    expect(sessionSummary).toBeDefined();

    const artifacts = await client.experimental!.artifacts.list({ taskId: task.id });
    expect(artifacts.items).toHaveLength(1);
    expect(artifacts.items[0]?.title).toBe("Delivery summary");

    const longTerm = findLongTermRecord(memory.state.records.values());
    expect(longTerm).toBeDefined();

    const search = await client.experimental!.memory.search({
      anchor: { workspaceId: "ws_demo", taskId: task.id, sessionId: session.id },
      queryText: "bridge implementation summary",
      layer: "long_term",
    });
    expect(search.hits.length).toBeGreaterThan(0);
  });
});
