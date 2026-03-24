import type { CapabilityPolicy } from "./policies";
import type { SerializedError } from "./errors";

export interface Workspace {
  id: string;
  name: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfile {
  id: string;
  workspaceId: string;
  name: string;
  defaultAdapter: string;
  defaultModel?: string;
  defaultContextPolicyId?: string;
  capabilityPolicy: CapabilityPolicy;
  toolBridge?: ToolBridgeConfig;
  metadata?: Record<string, unknown>;
}

export interface SessionParticipant {
  id: string;
  type: "user" | "agent" | "system";
}

export interface Session {
  id: string;
  workspaceId: string;
  externalRef?: string;
  title?: string;
  status: "active" | "paused" | "archived";
  participants?: SessionParticipant[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  sessionId: string;
  parentTaskId?: string;
  title: string;
  objective?: string;
  instructions?: string;
  status: "pending" | "ready" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  priority?: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface Run {
  id: string;
  workspaceId: string;
  sessionId: string;
  taskId: string;
  adapter: string;
  model?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  attempt: number;
  snapshotId?: string;
  externalRef?: string;
  capabilityPolicy?: Partial<CapabilityPolicy>;
  usage?: TokenUsage;
  startedAt?: string;
  endedAt?: string;
  error?: SerializedError;
  metadata?: Record<string, unknown>;
}

export interface MessagePart {
  type: string;
  content: unknown;
}

export interface Message {
  id: string;
  workspaceId: string;
  sessionId: string;
  taskId?: string;
  runId?: string;
  role: "system" | "user" | "assistant" | "tool" | "platform";
  kind: "text" | "structured" | "tool-call" | "tool-result" | "event-summary";
  content: string;
  parts?: MessagePart[];
  toolCallId?: string;
  artifactRefs?: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}


export interface Artifact {
  id: string;
  workspaceId: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  type: string;
  uri: string;
  mimeType?: string;
  title?: string;
  summary?: string;
  hash?: string;
  size?: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointPayloadEnvelope {
  version: "1";
  adapter: string;
  adapterVersion?: string;
  createdAt: string;
  payload: unknown;
}

export interface Checkpoint {
  id: string;
  workspaceId: string;
  sessionId: string;
  taskId: string;
  runId: string;
  adapter: string;
  payload: CheckpointPayloadEnvelope;
  createdAt: string;
}

export interface ContextPolicy {
  id: string;
  workspaceId: string;
  name: string;
  sources: ContextPolicySource[];
  ranking: ContextPolicyRanking;
  budget: ContextBudget;
  compression?: ContextCompressionConfig;
  redaction?: ContextRedactionConfig;
  createdAt: string;
  updatedAt: string;
}

export interface ContextPolicySource {
  kind:
    | "system-prompt"
    | "task"
    | "message-history"
    | "working-memory"
    | "episodic-memory"
    | "semantic-memory"
    | "procedural-memory"
    | "artifact"
    | "checkpoint";
  enabled: boolean;
  maxItems?: number;
  maxTokens?: number;
  priority: number;
}

export interface ContextPolicyRanking {
  strategy: "recency" | "importance" | "relevance" | "hybrid";
  weights?: {
    recency?: number;
    importance?: number;
    relevance?: number;
  };
}

export interface ContextBudget {
  maxInputTokens: number;
  reserveOutputTokens?: number;
  hardLimit?: boolean;
}

export interface ContextCompressionConfig {
  strategy?: string;
  maxSummaryTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextRedactionConfig {
  enabled?: boolean;
  rules?: string[];
  metadata?: Record<string, unknown>;
}

export interface ContextBlock {
  id: string;
  kind: "system" | "task" | "message" | "memory" | "artifact" | "checkpoint";
  title?: string;
  content: string;
  sourceRef: string;
  score?: number;
  tokenEstimate?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextExplanation {
  included: Array<{ blockId: string; reason: string; tokens: number }>;
  excluded: Array<{ sourceRef: string; reason: string }>;
  totalTokens: number;
}

export interface ContextSnapshot {
  id: string;
  workspaceId: string;
  sessionId: string;
  taskId?: string;
  policyId?: string;
  blocks: ContextBlock[];
  tokenEstimate: number;
  explanation?: ContextExplanation;
  createdAt: string;
}

export interface PlatformTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown, context: RunContext) => Promise<unknown>;
}

export interface ToolBridgeConfig {
  exposeMemorySearch?: boolean;
  exposeMemoryWrite?: boolean;
  exposeTaskGet?: boolean;
  exposeTaskUpdate?: boolean;
  exposeArtifactCreate?: boolean;
  customTools?: PlatformTool[];
}

export interface RunContext {
  workspaceId: string;
  sessionId: string;
  taskId: string;
  runId: string;
  adapter: string;
}



