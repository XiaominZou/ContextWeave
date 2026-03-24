import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { describe, expect, test } from "vitest";

import type { Run, Task } from "@ctx/core";
import { createInMemoryMemorySubsystem } from "@ctx/testing";
import {
  PLATFORM_MEMORY_SEARCH_TOOL,
  PLATFORM_MEMORY_WRITE_TOOL,
  PLATFORM_TASK_GET_TOOL,
  PLATFORM_TASK_LIST_TOOL,
  PLATFORM_TASK_UPDATE_TOOL,
  buildPlatformMemoryMcpServers,
  buildPlatformTaskMcpServers,
  executePlatformMemoryToolCall,
  executePlatformTaskToolCall,
} from "../tool-bridge";

function buildRunFixture(): Run {
  return {
    id: "run_bridge_test",
    workspaceId: "ws_test",
    sessionId: "sess_test",
    taskId: "task_test",
    adapter: "mock",
    status: "running",
    attempt: 1,
  };
}

function buildTaskFixture(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: "task_test",
    workspaceId: "ws_test",
    sessionId: "sess_test",
    title: "Test task",
    status: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("tool bridge helpers", () => {
  test("executePlatformMemoryToolCall searches and writes confirmed memory with run-scoped context", async () => {
    const subsystem = createInMemoryMemorySubsystem();
    await subsystem.provider.put({
      workspaceId: "ws_test",
      userId: "user_1",
      sessionId: "sess_test",
      taskId: "task_test",
      runId: "run_seed",
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

    const searchResult = await executePlatformMemoryToolCall({
      toolName: PLATFORM_MEMORY_SEARCH_TOOL,
      args: {
        queryText: "release tests",
        maxResults: 3,
      },
      memory: subsystem.engine,
      context: {
        workspaceId: "ws_test",
        sessionId: "sess_test",
        taskId: "task_test",
        runId: "run_bridge_test",
        userId: "user_1",
      },
    });

    expect(searchResult).toMatchObject({
      hits: [
        expect.objectContaining({
          title: "Release checklist",
          channel: "collection",
        }),
      ],
    });

    const writeResult = await executePlatformMemoryToolCall({
      toolName: PLATFORM_MEMORY_WRITE_TOOL,
      args: {
        kind: "preference",
        title: "Coding style",
        content: "Prefer tiny pure helper functions.",
        summary: "Use tiny pure helper functions.",
      },
      memory: subsystem.engine,
      context: {
        workspaceId: "ws_test",
        sessionId: "sess_test",
        taskId: "task_test",
        runId: "run_bridge_test",
        userId: "user_1",
      },
    });

    expect(writeResult).toMatchObject({
      record: {
        title: "Coding style",
        channel: "profile",
        scope: "user",
        layer: "long_term",
        status: "active",
      },
    });
  });

  test("executePlatformTaskToolCall gets, lists, and updates canonical tasks", async () => {
    const tasks = new Map<string, Task>([["task_test", buildTaskFixture()], ["task_other", buildTaskFixture({ id: "task_other", title: "Other task" })]]);

    const getResult = await executePlatformTaskToolCall({
      toolName: PLATFORM_TASK_GET_TOOL,
      args: {},
      tasks: {
        get: async (taskId) => tasks.get(taskId)!,
        list: async ({ sessionId }) => ({ items: [...tasks.values()].filter((task) => !sessionId || task.sessionId === sessionId) }),
        update: async (taskId, patch) => {
          const next = { ...tasks.get(taskId)!, ...patch, updatedAt: new Date().toISOString() };
          tasks.set(taskId, next);
          return next;
        },
      },
      context: { workspaceId: "ws_test", sessionId: "sess_test", taskId: "task_test", runId: "run_bridge_test" },
    });
    expect(getResult).toMatchObject({ task: { id: "task_test", title: "Test task" } });

    const listResult = await executePlatformTaskToolCall({
      toolName: PLATFORM_TASK_LIST_TOOL,
      args: {},
      tasks: {
        get: async (taskId) => tasks.get(taskId)!,
        list: async ({ sessionId }) => ({ items: [...tasks.values()].filter((task) => !sessionId || task.sessionId === sessionId) }),
        update: async (taskId, patch) => {
          const next = { ...tasks.get(taskId)!, ...patch, updatedAt: new Date().toISOString() };
          tasks.set(taskId, next);
          return next;
        },
      },
      context: { workspaceId: "ws_test", sessionId: "sess_test", taskId: "task_test", runId: "run_bridge_test" },
    });
    expect(listResult).toMatchObject({ items: [expect.objectContaining({ id: "task_test" }), expect.objectContaining({ id: "task_other" })] });

    const updateResult = await executePlatformTaskToolCall({
      toolName: PLATFORM_TASK_UPDATE_TOOL,
      args: { status: "completed", title: "Done task" },
      tasks: {
        get: async (taskId) => tasks.get(taskId)!,
        list: async ({ sessionId }) => ({ items: [...tasks.values()].filter((task) => !sessionId || task.sessionId === sessionId) }),
        update: async (taskId, patch) => {
          const next = { ...tasks.get(taskId)!, ...patch, updatedAt: new Date().toISOString(), completedAt: patch.status === "completed" ? new Date().toISOString() : undefined };
          tasks.set(taskId, next);
          return next;
        },
      },
      context: { workspaceId: "ws_test", sessionId: "sess_test", taskId: "task_test", runId: "run_bridge_test" },
    });
    expect(updateResult).toMatchObject({ task: { id: "task_test", title: "Done task", status: "completed" } });
  });

  test("buildPlatformMemoryMcpServers uses node + bridge script and carries host env", async () => {
    const [server] = buildPlatformMemoryMcpServers(buildRunFixture(), {
      baseUrl: "http://127.0.0.1:9999",
      token: "bridge-token",
    });

    expect(server).toMatchObject({
      name: "platform-memory",
      command: process.execPath,
      args: [expect.stringMatching(/ctx-platform-memory-bridge\.mjs$/)],
      env: expect.objectContaining({
        CTX_TOOL_BRIDGE_BASE_URL: "http://127.0.0.1:9999",
        CTX_TOOL_BRIDGE_TOKEN: "bridge-token",
        CTX_RUN_ID: "run_bridge_test",
      }),
    });
  });

  test("buildPlatformTaskMcpServers uses node + bridge script and carries host env", async () => {
    const [server] = buildPlatformTaskMcpServers(buildRunFixture(), {
      baseUrl: "http://127.0.0.1:9998",
      token: "task-bridge-token",
    });

    expect(server).toMatchObject({
      name: "platform-tasks",
      command: process.execPath,
      args: [expect.stringMatching(/ctx-platform-memory-bridge\.mjs$/)],
      env: expect.objectContaining({
        CTX_TOOL_BRIDGE_KIND: "tasks",
        CTX_TOOL_BRIDGE_BASE_URL: "http://127.0.0.1:9998",
        CTX_TOOL_BRIDGE_TOKEN: "task-bridge-token",
      }),
    });
  });

  test("bridge stdio process speaks minimal MCP and forwards tools/call to bridge host", async () => {
    let seenToken: string | undefined;
    let seenToolName: string | undefined;

    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || (request.url !== "/memory/invoke" && request.url !== "/tasks/invoke")) {
        response.statusCode = 404;
        response.end();
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        token: string;
        toolName: string;
      };
      seenToken = body.token;
      seenToolName = body.toolName;

      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        result: {
          hits: [
            {
              id: "mem_1",
              title: "Stub result",
              content: "stub",
              kind: "fact",
              scope: "workspace",
              layer: "long_term",
              channel: "collection",
              score: 0.99,
            },
          ],
          namespacesSearched: [{ scope: "workspace", ownerId: "ws_test" }],
        },
      }));
    });

    const address = await new Promise<{ port: number }>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const value = server.address();
        if (!value || typeof value === "string") {
          reject(new Error("failed to bind test server"));
          return;
        }
        resolve({ port: value.port });
      });
    });

    const [config] = buildPlatformMemoryMcpServers(buildRunFixture(), {
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "bridge-token",
    });

    const child = spawn(config.command, config.args ?? [], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(config.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = createInterface({ input: child.stdout });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
    lines.on("line", (line) => {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      const entry = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (!entry) {
        return;
      }
      pending.delete(message.id!);
      if (message.error) {
        entry.reject(message.error);
        return;
      }
      entry.resolve(message.result);
    });

    const stderr: string[] = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

    let nextId = 1;
    const request = async (method: string, params?: unknown) => {
      const id = nextId++;
      const responsePromise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return responsePromise;
    };

    try {
      const initializeResult = (await request("initialize", { protocolVersion: "2025-11-25" })) as {
        protocolVersion: string;
      };
      expect(initializeResult.protocolVersion).toBe("2025-11-25");

      const toolsList = (await request("tools/list")) as { tools: Array<{ name: string }> };
      expect(toolsList.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([PLATFORM_MEMORY_SEARCH_TOOL, PLATFORM_MEMORY_WRITE_TOOL]),
      );

      const toolCall = (await request("tools/call", {
        name: PLATFORM_MEMORY_SEARCH_TOOL,
        arguments: { queryText: "stub" },
      })) as {
        structuredContent: { hits: Array<{ title: string }> };
        isError: boolean;
      };
      expect(toolCall.isError).toBe(false);
      expect(toolCall.structuredContent.hits[0]?.title).toBe("Stub result");
      expect(seenToken).toBe("bridge-token");
      expect(seenToolName).toBe(PLATFORM_MEMORY_SEARCH_TOOL);
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.on("close", () => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }

    expect(stderr.join("\n")).toBe("");
  });
});
