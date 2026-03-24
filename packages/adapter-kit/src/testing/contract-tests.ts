import { describe, expect, test } from "vitest";

import { defaultCapabilityPolicy, type AdapterCapabilitySupport, type ContextBlock, type ContextSnapshot, type Run } from "@ctx/core";
import { PLATFORM_MEMORY_MCP_SERVER, PLATFORM_MEMORY_SEARCH_TOOL, PLATFORM_MEMORY_WRITE_TOOL, PLATFORM_TASKS_MCP_SERVER, PLATFORM_TASK_GET_TOOL, PLATFORM_TASK_LIST_TOOL, PLATFORM_TASK_UPDATE_TOOL } from "../tool-bridge";
import type { AgentAdapter } from "../types";

export interface AdapterTestFixtures {
  minimalSnapshot: ContextSnapshot;
  snapshotWithBlocks: ContextSnapshot;
  eventNormalizationCases: Array<{
    description: string;
    rawEvent: unknown;
    expectedType: string;
    expectedPayloadShape?: Record<string, unknown>;
  }>;
  unrecognizedRawEvent: unknown;
}

function extractTextContent(payload: Awaited<ReturnType<AgentAdapter["renderContext"]>>): string {
  if (payload.mode === "sdk") {
    return [payload.systemPrompt, ...payload.messages.map((message) => message.content)].join("\n");
  }

  if (payload.mode === "cli-process") {
    return [payload.stdin ?? "", payload.configFileInjection ?? ""].join("\n");
  }

  return JSON.stringify(payload.body);
}

export function runAdapterContractTests(adapter: AgentAdapter, fixtures: AdapterTestFixtures): void {
  describe(`[Contract] ${adapter.name}`, () => {
    describe("capabilities declaration", () => {
      test("invocationMode matches declared value", () => {
        expect(["sdk", "cli-process", "http-sse"]).toContain(adapter.invocationMode);
        expect(adapter.capabilities.invocationMode).toBe(adapter.invocationMode);
      });

      test("capabilitySupport covers all capabilities", () => {
        const support = adapter.capabilities.capabilitySupport;
        const required: Array<keyof AdapterCapabilitySupport> = ["context", "memory", "tasks", "artifacts"];

        for (const key of required) {
          expect(["intercept", "observe-only"]).toContain(support[key]);
        }
      });
    });

    describe("renderContext()", () => {
      test("returns payload.mode matching invocationMode", async () => {
        const payload = await adapter.renderContext({
          snapshot: fixtures.minimalSnapshot,
          policy: defaultCapabilityPolicy,
          run: buildRunFixture(),
        });

        expect(payload.mode).toBe(adapter.invocationMode);
      });

      test("context=native produces no platform injection", async () => {
        const payload = await adapter.renderContext({
          snapshot: null,
          policy: { ...defaultCapabilityPolicy, context: "native" },
          run: buildRunFixture(),
        });

        if (payload.mode === "cli-process") {
          expect(payload.configFileInjection).toBeFalsy();
        }

        if (payload.mode === "sdk") {
          expect(payload.systemPrompt).not.toContain("[PLATFORM_CONTEXT]");
        }
      });

      test("context=inject includes all snapshot block contents", async () => {
        const payload = await adapter.renderContext({
          snapshot: fixtures.snapshotWithBlocks,
          policy: { ...defaultCapabilityPolicy, context: "inject" },
          run: buildRunFixture(),
        });

        const text = extractTextContent(payload);
        for (const block of fixtures.snapshotWithBlocks.blocks) {
          expect(text).toContain(block.content);
        }
      });

      test("memory=tool-bridge exposes the platform memory bridge", async () => {
        const payload = await adapter.renderContext({
          snapshot: null,
          policy: { ...defaultCapabilityPolicy, memory: "tool-bridge" },
          run: buildRunFixture(),
        });

        if (payload.mode === "sdk") {
          expect(payload.tools?.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([PLATFORM_MEMORY_SEARCH_TOOL, PLATFORM_MEMORY_WRITE_TOOL]),
          );
        }

        if (payload.mode === "cli-process" && adapter.capabilities.nativeMcp) {
          expect(payload.mcpServers?.map((server) => server.name)).toContain(PLATFORM_MEMORY_MCP_SERVER);
        }
      });

      test("tasks=platform-tools exposes the platform task bridge", async () => {
        const payload = await adapter.renderContext({
          snapshot: null,
          policy: { ...defaultCapabilityPolicy, tasks: "platform-tools" },
          run: buildRunFixture(),
        });

        if (payload.mode === "sdk") {
          expect(payload.tools?.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([PLATFORM_TASK_GET_TOOL, PLATFORM_TASK_LIST_TOOL, PLATFORM_TASK_UPDATE_TOOL]),
          );
        }

        if (payload.mode === "cli-process" && adapter.capabilities.nativeMcp) {
          expect(payload.mcpServers?.map((server) => server.name)).toContain(PLATFORM_TASKS_MCP_SERVER);
        }
      });
    });

    describe("normalizeEvent()", () => {
      test.each(fixtures.eventNormalizationCases)("normalizes: $description", ({ rawEvent, expectedType, expectedPayloadShape }) => {
        const envelope = adapter.normalizeEvent(rawEvent);

        expect(envelope).not.toBeNull();
        expect(envelope?.type).toBe(expectedType);
        expect(envelope?.adapter).toBe(adapter.name);
        expect(envelope?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        if (expectedPayloadShape) {
          expect(envelope?.payload).toMatchObject(expectedPayloadShape);
        }
      });

      test("returns null for unrecognized events", () => {
        expect(adapter.normalizeEvent(fixtures.unrecognizedRawEvent)).toBeNull();
      });
    });
  });
}

function buildRunFixture(): Run {
  return {
    id: "run_test",
    workspaceId: "ws_test",
    sessionId: "sess_test",
    taskId: "task_test",
    adapter: "test-adapter",
    status: "running",
    attempt: 1,
  };
}

export function buildSnapshotFixture(blocks: ContextBlock[] = []): ContextSnapshot {
  return {
    id: "ctx_test",
    workspaceId: "ws_test",
    sessionId: "sess_test",
    blocks,
    tokenEstimate: blocks.reduce((sum, block) => sum + (block.tokenEstimate ?? 0), 0),
    createdAt: new Date().toISOString(),
  };
}
