import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { defaultCapabilityPolicy, type AgentEventEnvelope, type Run } from "@ctx/core";
import { PLATFORM_MEMORY_MCP_SERVER } from "@ctx/adapter-kit";
import { OpenCodeAdapter } from "../opencode-adapter";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fake-opencode.mjs", import.meta.url));

describe("OpenCodeAdapter createRun()", () => {
  test("spawns a CLI process and normalizes streamed JSON lines", async () => {
    const adapter = new OpenCodeAdapter({
      binaryPath: process.execPath,
      binaryArgs: [fakeCliPath],
      env: { OPENCODE_FAKE_SCENARIO: "success" },
    });

    const run = buildRunFixture({
      model: "gpt-test",
      metadata: { prompt: "Write hello world" },
    });

    const payload = await adapter.renderContext({
      snapshot: null,
      policy: defaultCapabilityPolicy,
      run,
    });

    const handle = await adapter.createRun({
      run,
      payload,
      policy: defaultCapabilityPolicy,
    });

    const normalized = await collectNormalizedEvents(adapter, handle);

    expect(normalized.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "run.completed",
    ]);
    expect(normalized[0]?.payload).toMatchObject({ externalRef: "oc_session_test" });
    expect(normalized[1]?.payload).toMatchObject({
      role: "assistant",
      text: "echo:Write hello world",
    });
  });

  test("injects platform context through the transparent plugin overlay", async () => {
    const adapter = new OpenCodeAdapter({
      binaryPath: process.execPath,
      binaryArgs: [fakeCliPath],
      env: { OPENCODE_FAKE_SCENARIO: "success" },
    });

    const run = buildRunFixture({
      metadata: { prompt: "Reply with the visible platform token." },
    });

    const payload = await adapter.renderContext({
      snapshot: {
        id: "ctx_plugin",
        workspaceId: "ws_test",
        sessionId: "sess_test",
        blocks: [{ id: "b1", kind: "task", content: "PLUGIN_VISIBLE_TOKEN_5150", sourceRef: "task_1", tokenEstimate: 4 }],
        tokenEstimate: 4,
        createdAt: new Date().toISOString(),
      },
      policy: { ...defaultCapabilityPolicy, context: "inject" },
      run,
    });

    const handle = await adapter.createRun({
      run,
      payload,
      policy: { ...defaultCapabilityPolicy, context: "inject" },
    });

    const normalized = await collectNormalizedEvents(adapter, handle);
    const message = normalized.find((event) => event.type === "message.delta");

    expect(payload.mode).toBe("cli-process");
    expect(payload.mode === "cli-process" ? payload.configFileInjection : undefined).toContain("PLUGIN_VISIBLE_TOKEN_5150");
    expect(message?.payload).toMatchObject({
      text: expect.stringContaining("PLUGIN_VISIBLE_TOKEN_5150"),
    });
  });

  test("renderContext exposes platform memory bridge via MCP for tool-bridge mode", async () => {
    const adapter = new OpenCodeAdapter({
      binaryPath: process.execPath,
      binaryArgs: [fakeCliPath],
    });

    const run = buildRunFixture();
    const payload = await adapter.renderContext({
      snapshot: null,
      policy: { ...defaultCapabilityPolicy, memory: "tool-bridge" },
      run,
      toolBridge: {
        memoryMcpServers: [
          {
            name: PLATFORM_MEMORY_MCP_SERVER,
            command: process.execPath,
            args: ["bridge-script"],
            env: {
              CTX_TOOL_BRIDGE_BASE_URL: "http://127.0.0.1:9999",
              CTX_TOOL_BRIDGE_TOKEN: "bridge-token",
            },
          },
        ],
      },
    });

    expect(payload.mode).toBe("cli-process");
    const mcpServer = payload.mode === "cli-process" ? payload.mcpServers?.[0] : undefined;
    expect(mcpServer?.name).toBe(PLATFORM_MEMORY_MCP_SERVER);
    expect(mcpServer?.env).toMatchObject({
      CTX_TOOL_BRIDGE_BASE_URL: "http://127.0.0.1:9999",
      CTX_TOOL_BRIDGE_TOKEN: "bridge-token",
    });
  });

  test("turns invalid JSON lines into run.failed events", async () => {
    const adapter = new OpenCodeAdapter({
      binaryPath: process.execPath,
      binaryArgs: [fakeCliPath],
      env: { OPENCODE_FAKE_SCENARIO: "invalid-json" },
    });

    const run = buildRunFixture();
    const payload = await adapter.renderContext({
      snapshot: null,
      policy: defaultCapabilityPolicy,
      run,
    });

    const handle = await adapter.createRun({
      run,
      payload,
      policy: defaultCapabilityPolicy,
    });

    const normalized = await collectNormalizedEvents(adapter, handle);

    expect(normalized.some((event) => event.type === "run.failed")).toBe(true);
    expect(normalized[0]?.payload).toMatchObject({
      error: {
        code: "INVALID_JSON_LINE",
      },
    });
  });

  test("turns non-zero process exits into run.failed events", async () => {
    const adapter = new OpenCodeAdapter({
      binaryPath: process.execPath,
      binaryArgs: [fakeCliPath],
      env: { OPENCODE_FAKE_SCENARIO: "non-zero" },
    });

    const run = buildRunFixture();
    const payload = await adapter.renderContext({
      snapshot: null,
      policy: defaultCapabilityPolicy,
      run,
    });

    const handle = await adapter.createRun({
      run,
      payload,
      policy: defaultCapabilityPolicy,
    });

    const normalized = await collectNormalizedEvents(adapter, handle);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.type).toBe("run.failed");
    expect(normalized[0]?.payload).toMatchObject({
      error: {
        code: "PROCESS_EXIT_NON_ZERO",
        message: "boom from fake opencode",
      },
    });
  });
});

async function collectNormalizedEvents(
  adapter: OpenCodeAdapter,
  handle: Awaited<ReturnType<OpenCodeAdapter["createRun"]>>,
): Promise<AgentEventEnvelope[]> {
  const normalized: AgentEventEnvelope[] = [];

  for await (const rawEvent of handle.streamEvents()) {
    const envelope = adapter.normalizeEvent(rawEvent);
    if (envelope) {
      normalized.push(envelope);
    }
  }

  return normalized;
}

function buildRunFixture(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_opencode_test",
    workspaceId: "ws_test",
    sessionId: "sess_test",
    taskId: "task_test",
    adapter: "opencode",
    status: "running",
    attempt: 1,
    ...overrides,
  };
}
