import { describe, expect, test, vi } from "vitest";

import { defaultCapabilityPolicy } from "@ctx/core";
import { createTestPlatform, drainHandle, RawMockAdapter } from "@ctx/testing";
import type {
  ConsolidateTaskInput,
  MemoryEngine,
  MemoryProvider,
  MemoryRecordDraftV1_1,
  MemoryRecordPatchV1_1,
  MemoryRecordV1_1,
  MemorySearchQuery,
  PromoteMemoryInput,
  ProviderSearchInput,
  WriteConfirmedInput,
  WriteExperienceInput,
} from "@ctx/core";

function makeStoredRecord(): MemoryRecordV1_1 {
  const now = new Date().toISOString();
  return {
    id: "mem_1",
    workspaceId: "ws_1",
    runId: "run_1",
    ownerRef: { type: "run", id: "run_1" },
    scope: "run",
    layer: "experience",
    channel: "collection",
    kind: "insight",
    status: "active",
    title: "memory",
    content: "content",
    importance: 0.8,
    confidence: 0.9,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function createProvider() {
  return {
    get: vi.fn(async (): Promise<MemoryRecordV1_1 | null> => makeStoredRecord()),
    search: vi.fn(async (_input: ProviderSearchInput) => [{ record: makeStoredRecord(), vectorScore: 0.95 }]),
    put: vi.fn(async (_record: MemoryRecordDraftV1_1) => makeStoredRecord()),
    update: vi.fn(async (_id: string, _patch: MemoryRecordPatchV1_1) => makeStoredRecord()),
    archive: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } satisfies MemoryProvider;
}

function createEngine() {
  return {
    search: vi.fn(async (_query: MemorySearchQuery) => ({
      hits: [{ record: makeStoredRecord(), finalScore: 0.92 }],
      namespacesSearched: [{ scope: "run" as const, ownerId: "run_1" }],
    })),
    writeExperience: vi.fn(async (_input: WriteExperienceInput) => makeStoredRecord()),
    writeConfirmed: vi.fn(async (_input: WriteConfirmedInput) => makeStoredRecord()),
    consolidateTask: vi.fn(async (_input: ConsolidateTaskInput) => []),
    promote: vi.fn(async (_input: PromoteMemoryInput) => ({
      memoryId: "mem_1",
      action: "NONE" as const,
    })),
  } satisfies MemoryEngine;
}

describe("memory wiring", () => {
  test("exposes memory bindings on runtime and a stable memory API on experimental client surface", async () => {
    const provider = createProvider();
    const engine = createEngine();

    const { platform, client } = createTestPlatform({
      memory: {
        provider,
        engine,
      },
    });

    const searchQuery: MemorySearchQuery = {
      anchor: { workspaceId: "ws_1", runId: "run_1" },
      queryText: "memory",
    };

    expect(platform.runtime.memory?.provider).toBe(provider);
    expect(platform.runtime.memory?.engine).toBe(engine);

    const memoryApi = client.experimental?.memory;
    expect(memoryApi).toBeDefined();
    expect(client.experimental?.artifacts).toBeDefined();

    const searchResult = await memoryApi!.search(searchQuery);
    expect(searchResult.hits).toHaveLength(1);
    expect(engine.search).toHaveBeenCalledWith(searchQuery);

    const record = await memoryApi!.get("mem_1");
    expect(record.id).toBe("mem_1");
    expect(provider.get).toHaveBeenCalledWith("mem_1");
  });

  test("memory API methods fail with NOT_ENABLED when bindings are missing", async () => {
    const { client } = createTestPlatform();
    const memoryApi = client.experimental?.memory;

    await expect(
      memoryApi!.search({
        anchor: { workspaceId: "ws_1" },
        queryText: "memory",
      }),
    ).rejects.toMatchObject({ code: "NOT_ENABLED" });

    await expect(memoryApi!.get("mem_missing")).rejects.toMatchObject({ code: "NOT_ENABLED" });
  });

  test("memory API surfaces MEMORY_NOT_FOUND for missing provider records", async () => {
    const provider = createProvider();
    provider.get.mockResolvedValueOnce(null);

    const { client } = createTestPlatform({
      memory: {
        provider,
      },
    });

    await expect(client.experimental!.memory.get("mem_missing")).rejects.toMatchObject({
      code: "MEMORY_NOT_FOUND",
    });
  });

  test("default run path does not trigger memory retrieval while policy remains native/off", async () => {
    const engine = createEngine();
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
        engine,
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

    await drainHandle(handle);

    expect(engine.search).not.toHaveBeenCalled();
  });

  test("experimental context API builds, previews, and explains snapshots", async () => {
    const engine = createEngine();
    const { client } = createTestPlatform({
      memory: {
        engine,
      },
    });

    const session = await client.sessions.create({ workspaceId: "ws_1", title: "test" });
    const task = await client.tasks.create({
      workspaceId: "ws_1",
      sessionId: session.id,
      title: "refactor auth",
      objective: "split middleware",
    });

    const snapshot = await client.experimental!.context.build({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      policy: {
        context: "inject",
        memory: "platform",
        tasks: "observe-native",
        artifacts: "observe",
      },
      metadata: {
        prompt: "use previous conventions",
      },
    });

    expect(snapshot.blocks[0]?.kind).toBe("task");
    expect(snapshot.blocks[1]?.kind).toBe("memory");

    const explanation = await client.experimental!.context.explain(snapshot.id);
    expect(explanation.included).toHaveLength(2);

    const preview = await client.experimental!.context.preview({
      workspaceId: "ws_1",
      sessionId: session.id,
      taskId: task.id,
      policy: {
        context: "inject",
        memory: "off",
        tasks: "observe-native",
        artifacts: "observe",
      },
    });

    expect(preview.snapshot.blocks).toHaveLength(1);
    expect(preview.explanation.totalTokens).toBe(preview.snapshot.tokenEstimate);
  });
});


