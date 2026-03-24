import { describe, expect, test } from "vitest";

import { defaultCapabilityPolicy, type AgentEventEnvelope } from "@ctx/core";
import { OpenCodeAdapter, OpenCodeHostAdapter } from "../index";
import { createContextPlatform } from "@ctx/client";
import { createInMemoryMemorySubsystem, InMemoryStore } from "@ctx/testing";

const OPENCODE_CMD = "C:\\Users\\zxm\\AppData\\Roaming\\npm\\opencode.cmd";
const realSmoke = process.env.CTX_ENABLE_REAL_OPENCODE_SMOKE === "1" ? test : test.skip;
const capabilitySmoke = process.env.CTX_ENABLE_REAL_OPENCODE_CAPABILITY_SMOKE === "1" ? test : test.skip;
const hostSmoke = process.env.CTX_ENABLE_REAL_OPENCODE_HOST_SMOKE === "1" ? test : test.skip;

describe("OpenCodeAdapter real smoke", () => {
  capabilitySmoke(
    "injects platform context into a real opencode run",
    async () => {
      const store = new InMemoryStore();
      const platform = createContextPlatform({ store });
      platform.runtime.adapters.register(
        new OpenCodeAdapter({
          binaryPath: OPENCODE_CMD,
          cwd: process.cwd(),
        }),
      );

      const client = platform.client();
      const session = await client.sessions.create({
        workspaceId: "ws_smoke",
        title: "real opencode inject smoke",
      });
      const objectiveToken = "CTX_OBJECTIVE_TOKEN_7281";
      const task = await client.tasks.create({
        workspaceId: "ws_smoke",
        sessionId: session.id,
        title: "Context inject smoke",
        objective: objectiveToken,
      });

      const handle = await client.runs.start({
        workspaceId: "ws_smoke",
        sessionId: session.id,
        taskId: task.id,
        adapter: "opencode",
        capabilityPolicy: {
          ...defaultCapabilityPolicy,
          context: "inject",
        },
        metadata: {
          prompt: "Read the platform context and reply with exactly the objective token only. No punctuation.",
        },
      });

      let events: AgentEventEnvelope[];
      try {
        events = await collectEventsWithTimeout(handle, 90000);
      } catch (error) {
        const run = await client.runs.get(handle.runId);
        const stored = await client.events.list({ runId: handle.runId });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} | run.status=${run.status} | stored=${stored.items.map((event) => event.type).join(", ")}`,
        );
      }

      const run = await client.runs.get(handle.runId);
      if (run.status !== "completed") {
        throw new Error(`inject smoke failed: status=${run.status} error=${JSON.stringify(run.error ?? null)} events=${events.map((event) => event.type).join(",")}`);
      }
      expect(run.snapshotId).toBeDefined();

      const deltaTexts = events
        .filter((event) => event.type === "message.delta")
        .map((event) => String((event.payload as { text?: unknown }).text ?? ""))
        .join("");

      expect(deltaTexts).toContain(objectiveToken);
    },
    240000,
  );

  capabilitySmoke(
    "updates canonical task state through platform task tools in a real opencode run",
    async () => {
      const store = new InMemoryStore();
      const platform = createContextPlatform({ store });
      platform.runtime.adapters.register(
        new OpenCodeAdapter({
          binaryPath: OPENCODE_CMD,
          cwd: process.cwd(),
        }),
      );

      const client = platform.client();
      const session = await client.sessions.create({
        workspaceId: "ws_smoke",
        title: "real opencode platform-tools smoke",
      });
      const task = await client.tasks.create({
        workspaceId: "ws_smoke",
        sessionId: session.id,
        title: "Platform task tool smoke",
        objective: "Verify platform_task_update updates canonical task state.",
      });

      const completedTitle = "Platform task tool smoke completed";
      const handle = await client.runs.start({
        workspaceId: "ws_smoke",
        sessionId: session.id,
        taskId: task.id,
        adapter: "opencode",
        capabilityPolicy: {
          ...defaultCapabilityPolicy,
          tasks: "platform-tools",
        },
        metadata: {
          prompt: `Use the platform_task_update tool exactly once to set the current task status to completed and title to "${completedTitle}". After the tool succeeds, reply with exactly DONE.`,
        },
      });

      let events: AgentEventEnvelope[];
      try {
        events = await collectEventsWithTimeout(handle, 90000);
      } catch (error) {
        const run = await client.runs.get(handle.runId);
        const stored = await client.events.list({ runId: handle.runId });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} | run.status=${run.status} | stored=${stored.items.map((event) => event.type).join(", ")}`,
        );
      }

      const run = await client.runs.get(handle.runId);
      if (run.status !== "completed") {
        throw new Error(`platform-tools smoke failed: status=${run.status} error=${JSON.stringify(run.error ?? null)} events=${events.map((event) => event.type).join(",")}`);
      }
      expect(events.some((event) => event.type === "tool.call")).toBe(true);

      const updatedTask = await client.tasks.get(task.id);
      expect(updatedTask.title).toBe(completedTitle);
      expect(updatedTask.status).toBe("completed");

      const deltaTexts = events
        .filter((event) => event.type === "message.delta")
        .map((event) => String((event.payload as { text?: unknown }).text ?? ""))
        .join("");
      expect(deltaTexts.toUpperCase()).toContain("DONE");
    },
    240000,
  );


  hostSmoke(
    "runs a real opencode host session with platform-owned context assembly",
    async () => {
      const store = new InMemoryStore();
      const memory = createInMemoryMemorySubsystem();
      await memory.provider.put({
        workspaceId: "ws_host_smoke",
        ownerRef: { type: "workspace", id: "ws_host_smoke" },
        scope: "workspace",
        layer: "long_term",
        channel: "collection",
        kind: "procedure",
        status: "active",
        title: "Host memory token",
        content: "HOST_MEMORY_TOKEN_2048",
        summary: "HOST_MEMORY_TOKEN_2048",
        importance: 0.9,
        confidence: 0.9,
      });

      const platform = createContextPlatform({ store, memory });
      platform.runtime.adapters.register(
        new OpenCodeHostAdapter({
          binaryPath: OPENCODE_CMD,
          cwd: process.cwd(),
        }),
      );

      const client = platform.client();
      const session = await client.sessions.create({
        workspaceId: "ws_host_smoke",
        title: "real opencode host smoke",
        metadata: { userId: "user_host_smoke" },
      });
      const objectiveToken = "HOST_OBJECTIVE_TOKEN_1024";
      const task = await client.tasks.create({
        workspaceId: "ws_host_smoke",
        sessionId: session.id,
        title: "host transparent smoke",
        objective: objectiveToken,
      });

      const handle = await client.runs.start({
        workspaceId: "ws_host_smoke",
        sessionId: session.id,
        taskId: task.id,
        adapter: "opencode-host",
        capabilityPolicy: {
          context: "inject",
          memory: "platform",
          tasks: "observe-native",
          artifacts: "observe",
        },
        metadata: {
          prompt: "Read the platform context and reply with every visible TOKEN value separated by commas.",
        },
      });

      let events: AgentEventEnvelope[];
      try {
        events = await collectEventsWithTimeout(handle, 120000);
      } catch (error) {
        const run = await client.runs.get(handle.runId);
        const stored = await client.events.list({ runId: handle.runId });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} | run.status=${run.status} | stored=${stored.items.map((event) => event.type).join(", ")}`,
        );
      }

      const run = await client.runs.get(handle.runId);
      if (run.status !== "completed") {
        throw new Error(`host smoke failed: status=${run.status} error=${JSON.stringify(run.error ?? null)} events=${events.map((event) => event.type).join(",")}`);
      }
      expect(run.externalRef).toMatch(/^ses_/);
      expect(run.snapshotId).toBeDefined();

      const deltaTexts = events
        .filter((event) => event.type === "message.delta")
        .map((event) => String((event.payload as { text?: unknown }).text ?? ""))
        .join("");

      expect(deltaTexts).toContain(objectiveToken);
      expect(deltaTexts).toContain("HOST_MEMORY_TOKEN_2048");
    },
    240000,
  );

  realSmoke(
    "runs a real opencode session through the platform runtime",
    async () => {
      const store = new InMemoryStore();
      const platform = createContextPlatform({ store });
      platform.runtime.adapters.register(
        new OpenCodeAdapter({
          binaryPath: OPENCODE_CMD,
          cwd: process.cwd(),
        }),
      );

      const client = platform.client();
      const session = await client.sessions.create({
        workspaceId: "ws_smoke",
        title: "real opencode smoke",
      });
      const task = await client.tasks.create({
        workspaceId: "ws_smoke",
        sessionId: session.id,
        title: "Smoke run",
        objective: "Verify the real opencode adapter path",
      });

      const handle = await client.runs.start({
        workspaceId: "ws_smoke",
        sessionId: session.id,
        taskId: task.id,
        adapter: "opencode",
        metadata: {
          prompt: "Reply with exactly one short English word meaning hello.",
        },
      });

      let events: AgentEventEnvelope[];
      try {
        events = await collectEventsWithTimeout(handle, 90000);
      } catch (error) {
        const run = await client.runs.get(handle.runId);
        const stored = await client.events.list({ runId: handle.runId });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} | run.status=${run.status} | stored=${stored.items.map((event) => event.type).join(", ")}`,
        );
      }

      const run = await client.runs.get(handle.runId);

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0]?.type).toBe("run.started");
      expect(events.some((event) => event.type === "message.delta")).toBe(true);
      expect(events.at(-1)?.type).toBe("run.completed");
      expect(run.status).toBe("completed");
      expect(run.externalRef).toMatch(/^ses_/);

      const deltaTexts = events
        .filter((event) => event.type === "message.delta")
        .map((event) => String((event.payload as { text?: unknown }).text ?? ""))
        .join("");

      expect(deltaTexts.trim().length).toBeGreaterThan(0);
    },
    180000,
  );
});

async function collectEventsWithTimeout(handle: { streamEvents(): AsyncIterable<AgentEventEnvelope>; interrupt(): Promise<void> }, timeoutMs: number): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = [];
  let settled = false;

  const drainPromise = (async () => {
    for await (const event of handle.streamEvents()) {
      events.push(event);
    }
    settled = true;
    return events;
  })();

  const timeoutPromise = new Promise<AgentEventEnvelope[]>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Timed out waiting for event stream to close. Received events: ${events.map((event) => event.type).join(", ")}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([drainPromise, timeoutPromise]);
  } catch (error) {
    if (!settled) {
      await handle.interrupt();
    }
    throw error;
  }
}

