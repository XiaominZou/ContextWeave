import { describe, expect, test } from "vitest";

import { defaultCapabilityPolicy } from "@ctx/core";
import { createInMemoryMemorySubsystem, createTestPlatform, drainHandle, RawMockAdapter } from "@ctx/testing";

describe("memory consolidation", () => {
  test("task completion consolidates extracted experience into long_term memory", async () => {
    const memory = createInMemoryMemorySubsystem();
    const { client } = createTestPlatform({
      adapters: [
        new RawMockAdapter({
          rawEvents: [
            { type: "run_started", model: "mock-model" },
            { type: "run_completed", reason: "end_turn" },
          ],
        }),
      ],
      memory,
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "memory test" });
    const task = await client.tasks.create({
      workspaceId: "ws_1",
      sessionId: session.id,
      title: "Extract reusable auth rule",
      objective: "Keep the useful rule for future tasks",
    });

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
        prompt: "remember the auth middleware rule",
      },
    });

    await drainHandle(handle);

    const extractedRecords = [...memory.state.records.values()];
    expect(extractedRecords).toHaveLength(1);
    expect(extractedRecords[0]).toMatchObject({
      layer: "experience",
      status: "candidate",
      channel: "collection",
      taskId: task.id,
    });

    await client.tasks.complete(task.id);

    const recordsAfterConsolidation = [...memory.state.records.values()];
    const promoted = recordsAfterConsolidation.find((record) => record.layer === "long_term");
    const archivedSource = recordsAfterConsolidation.find((record) => record.layer === "experience");

    expect(promoted).toMatchObject({
      layer: "long_term",
      status: "active",
      scope: "workspace",
      channel: "collection",
      promotedFrom: archivedSource?.id,
    });
    expect(archivedSource).toMatchObject({
      layer: "experience",
      status: "archived",
      replacedBy: promoted?.id,
    });

    const searchResult = await client.experimental!.memory.search({
      anchor: { workspaceId: "ws_1" },
      queryText: "auth middleware rule",
      layer: "long_term",
    });

    expect(searchResult.hits).toHaveLength(1);
    expect(searchResult.hits[0]?.record.id).toBe(promoted?.id);
  });
});


