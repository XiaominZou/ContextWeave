import { afterEach, describe, expect, test } from "vitest";

import type { Run } from "@ctx/core";
import { PLATFORM_MEMORY_SEARCH_TOOL, PLATFORM_MEMORY_WRITE_TOOL, PLATFORM_TASK_GET_TOOL, PLATFORM_TASK_UPDATE_TOOL } from "@ctx/adapter-kit";
import { createInMemoryMemorySubsystem } from "@ctx/testing";

import { createMemoryAPI } from "../internal/memory-api";
import { createToolBridgeHost } from "../internal/tool-bridge-host";

const hosts: Array<ReturnType<typeof createToolBridgeHost>> = [];

afterEach(async () => {
  while (hosts.length > 0) {
    await hosts.pop()!.close();
  }
});

function buildRunFixture(): Run {
  return {
    id: "run_bridge_host",
    workspaceId: "ws_test",
    sessionId: "sess_test",
    taskId: "task_test",
    adapter: "mock",
    status: "running",
    attempt: 1,
  };
}

describe("tool bridge host", () => {
  test("registers a run token and executes search/write requests over local HTTP", async () => {
    const subsystem = createInMemoryMemorySubsystem();
    const memoryApi = createMemoryAPI({
      provider: subsystem.provider,
      engine: subsystem.engine,
    });
    await subsystem.provider.put({
      workspaceId: "ws_test",
      ownerRef: { type: "workspace", id: "ws_test" },
      scope: "workspace",
      layer: "long_term",
      channel: "collection",
      kind: "procedure",
      status: "active",
      title: "Release checklist",
      content: "Always run tests before release.",
      summary: "Run tests before release.",
    });

    const host = createToolBridgeHost({
      memory: memoryApi,
      tasks: {
        get: async () => ({
          id: "task_test",
          workspaceId: "ws_test",
          sessionId: "sess_test",
          title: "Task title",
          status: "ready",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        list: async () => ({ items: [] }),
        update: async (_taskId, patch) => ({
          id: "task_test",
          workspaceId: "ws_test",
          sessionId: "sess_test",
          title: patch.title ?? "Task title",
          status: patch.status ?? "ready",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: patch.status === "completed" ? new Date().toISOString() : undefined,
        }),
      },
    });
    hosts.push(host);

    const registration = await host.registerRun({
      run: buildRunFixture(),
      userId: "user_1",
    });

    const searchResponse = await fetch(`${registration.baseUrl}/memory/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: registration.token,
        toolName: PLATFORM_MEMORY_SEARCH_TOOL,
        arguments: {
          queryText: "release tests",
        },
      }),
    });
    const searchPayload = (await searchResponse.json()) as {
      result: { hits: Array<{ title: string }> };
    };

    expect(searchResponse.status).toBe(200);
    expect(searchPayload.result.hits[0]?.title).toBe("Release checklist");

    const writeResponse = await fetch(`${registration.baseUrl}/memory/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: registration.token,
        toolName: PLATFORM_MEMORY_WRITE_TOOL,
        arguments: {
          kind: "preference",
          title: "Coding style",
          content: "Prefer tiny pure helper functions.",
          summary: "Use tiny pure helper functions.",
        },
      }),
    });
    const writePayload = (await writeResponse.json()) as {
      result: { record: { channel: string; scope: string; title: string } };
    };

    expect(writeResponse.status).toBe(200);
    expect(writePayload.result.record).toMatchObject({
      title: "Coding style",
      channel: "profile",
      scope: "user",
    });

    const taskGetResponse = await fetch(`${registration.baseUrl}/tasks/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: registration.token,
        toolName: PLATFORM_TASK_GET_TOOL,
        arguments: {},
      }),
    });
    const taskGetPayload = (await taskGetResponse.json()) as {
      result: { task: { id: string; title: string } };
    };

    expect(taskGetResponse.status).toBe(200);
    expect(taskGetPayload.result.task).toMatchObject({ id: "task_test", title: "Task title" });

    const taskUpdateResponse = await fetch(`${registration.baseUrl}/tasks/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: registration.token,
        toolName: PLATFORM_TASK_UPDATE_TOOL,
        arguments: { title: "Done task", status: "completed" },
      }),
    });
    const taskUpdatePayload = (await taskUpdateResponse.json()) as {
      result: { task: { title: string; status: string } };
    };

    expect(taskUpdateResponse.status).toBe(200);
    expect(taskUpdatePayload.result.task).toMatchObject({ title: "Done task", status: "completed" });

    host.unregisterRun("run_bridge_host");

    const expiredResponse = await fetch(`${registration.baseUrl}/memory/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: registration.token,
        toolName: PLATFORM_MEMORY_SEARCH_TOOL,
        arguments: {
          queryText: "release tests",
        },
      }),
    });
    const expiredPayload = (await expiredResponse.json()) as {
      error: { code: string };
    };

    expect(expiredResponse.status).toBe(403);
    expect(expiredPayload.error.code).toBe("TOOL_BRIDGE_TOKEN_INVALID");
  });
});
