import { createContextPlatform } from "@ctx/client";
import type { MemoryBindings, RunHandle } from "@ctx/client";
import type { AgentAdapter } from "@ctx/adapter-kit";
import type { AgentEventEnvelope } from "@ctx/core";
import { InMemoryStore } from "./in-memory-store";

export function createTestPlatform(config?: { adapters?: AgentAdapter[]; store?: InMemoryStore; memory?: MemoryBindings }) {
  const store = config?.store ?? new InMemoryStore();
  const platform = createContextPlatform({
    store,
    memory: config?.memory,
  });

  for (const adapter of config?.adapters ?? []) {
    platform.runtime.adapters.register(adapter);
  }

  return {
    platform,
    client: platform.client(),
    store,
  };
}

export async function drainHandle(handle: RunHandle): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = [];
  for await (const event of handle.streamEvents()) {
    events.push(event);
  }
  return events;
}

