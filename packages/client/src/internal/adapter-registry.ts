import type { AdapterCapabilities, AgentAdapter } from "@ctx/adapter-kit";
import type { AdapterRegistryAPI } from "../contracts";

export class AdapterRegistry implements AdapterRegistryAPI {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AgentAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      const error = new Error(`Adapter not found: ${name}`) as Error & { code: string };
      error.code = "ADAPTER_UNAVAILABLE";
      throw error;
    }
    return adapter;
  }

  list(): Array<{ name: string; version: string; invocationMode: string }> {
    return [...this.adapters.values()].map((adapter) => ({
      name: adapter.name,
      version: adapter.version,
      invocationMode: adapter.invocationMode,
    }));
  }

  capabilities(name: string): AdapterCapabilities {
    return this.get(name).capabilities;
  }
}

