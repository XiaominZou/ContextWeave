import type {
  AdapterCapabilitySupport,
  AgentEventEnvelope,
  CapabilityPolicy,
  Checkpoint,
  ContextSnapshot,
  Run,
} from "@ctx/core";

export interface CanonicalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ToolBridgeRenderContext {
  memoryMcpServers?: McpServerConfig[];
  taskMcpServers?: McpServerConfig[];
}

export interface SdkAdapterPayload {
  mode: "sdk";
  systemPrompt: string;
  messages: CanonicalMessage[];
  tools?: ToolSchema[];
}

export interface CliAdapterPayload {
  mode: "cli-process";
  argv: string[];
  env: Record<string, string>;
  stdin?: string;
  configFileInjection?: string;
  mcpServers?: McpServerConfig[];
}

export interface HttpSseAdapterPayload {
  mode: "http-sse";
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

export type AdapterPayload = SdkAdapterPayload | CliAdapterPayload | HttpSseAdapterPayload;

export interface RenderContextInput {
  snapshot: ContextSnapshot | null;
  policy: CapabilityPolicy;
  run: Run;
  toolBridge?: ToolBridgeRenderContext;
}

export interface AdapterRunInput {
  run: Run;
  payload: AdapterPayload;
  policy: CapabilityPolicy;
}

export interface ResumeRunInput {
  run: Run;
  checkpoint: Checkpoint;
}

export interface WorkspaceContext {
  workspaceId: string;
}

export interface AdapterCredentials {
  kind: "api-key" | "oauth-token" | "cli-config" | "custom";
  value: unknown;
  expiresAt?: string;
}

export interface AdapterRunHandle {
  externalRef?: string;
  streamEvents(): AsyncIterable<unknown>;
  cancel(): Promise<void>;
}

export interface AdapterCapabilities {
  invocationMode: "sdk" | "cli-process" | "http-sse";
  streaming: boolean;
  toolCalls: boolean;
  checkpoints: boolean;
  resume: boolean;
  interrupt: boolean;
  nativeMcp: boolean;
  capabilitySupport: AdapterCapabilitySupport;
}

export interface AgentAdapter {
  readonly name: string;
  readonly version: string;
  readonly invocationMode: "sdk" | "cli-process" | "http-sse";
  readonly capabilities: AdapterCapabilities;

  renderContext(input: RenderContextInput): Promise<AdapterPayload>;
  createRun(input: AdapterRunInput): Promise<AdapterRunHandle>;
  normalizeEvent(rawEvent: unknown): AgentEventEnvelope | null;

  resumeRun?(input: ResumeRunInput): Promise<AdapterRunHandle>;
  createCheckpoint?(runId: string): Promise<Checkpoint>;
  resolveCredentials?(context: WorkspaceContext): Promise<AdapterCredentials>;
}
