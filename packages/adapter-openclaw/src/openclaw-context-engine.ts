export interface OpenClawAgentMessage {
  role: string;
  content: unknown;
  id?: string;
  [key: string]: unknown;
}

export interface OpenClawContextEngineIngestParams {
  sessionId: string;
  sessionKey?: string;
  message: OpenClawAgentMessage;
  isHeartbeat?: boolean;
}

export interface OpenClawContextEngineAssembleParams {
  sessionId: string;
  sessionKey?: string;
  messages: OpenClawAgentMessage[];
  tokenBudget?: number;
  model?: string;
  prompt?: string;
}

export interface OpenClawContextEngineCompactParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  tokenBudget?: number;
  force?: boolean;
  currentTokenCount?: number;
  compactionTarget?: "budget" | "threshold";
  customInstructions?: string;
  runtimeContext?: Record<string, unknown>;
}

export interface OpenClawContextEngineBridgeOptions {
  engineId: string;
  engineName?: string;
  engineVersion?: string;
  ownsCompaction?: boolean;
  bootstrap?: (params: { sessionId: string; sessionKey?: string; sessionFile: string }) => Promise<{ bootstrapped: boolean; importedMessages?: number; reason?: string }>;
  maintain?: (params: { sessionId: string; sessionKey?: string; sessionFile: string; runtimeContext?: Record<string, unknown> }) => Promise<{
    changed: boolean;
    bytesFreed: number;
    rewrittenEntries: number;
    reason?: string;
  }>;
  ingest?: (params: OpenClawContextEngineIngestParams) => Promise<{ ingested: boolean }>;
  ingestBatch?: (params: {
    sessionId: string;
    sessionKey?: string;
    messages: OpenClawAgentMessage[];
    isHeartbeat?: boolean;
  }) => Promise<{ ingestedCount: number }>;
  assemble: (params: OpenClawContextEngineAssembleParams) => Promise<{
    messages: OpenClawAgentMessage[];
    estimatedTokens: number;
    systemPromptAddition?: string;
  }>;
  compact: (params: OpenClawContextEngineCompactParams) => Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    result?: {
      summary?: string;
      firstKeptEntryId?: string;
      tokensBefore: number;
      tokensAfter?: number;
      details?: unknown;
    };
  }>;
  afterTurn?: (params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: OpenClawAgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }) => Promise<void>;
}

export interface OpenClawCompatibleContextEngine {
  readonly info: {
    id: string;
    name: string;
    version?: string;
    ownsCompaction?: boolean;
  };
  bootstrap?: NonNullable<OpenClawContextEngineBridgeOptions["bootstrap"]>;
  maintain?: NonNullable<OpenClawContextEngineBridgeOptions["maintain"]>;
  ingest(params: OpenClawContextEngineIngestParams): Promise<{ ingested: boolean }>;
  ingestBatch?: NonNullable<OpenClawContextEngineBridgeOptions["ingestBatch"]>;
  assemble(params: OpenClawContextEngineAssembleParams): Promise<{
    messages: OpenClawAgentMessage[];
    estimatedTokens: number;
    systemPromptAddition?: string;
  }>;
  compact(params: OpenClawContextEngineCompactParams): Promise<{
    ok: boolean;
    compacted: boolean;
    reason?: string;
    result?: {
      summary?: string;
      firstKeptEntryId?: string;
      tokensBefore: number;
      tokensAfter?: number;
      details?: unknown;
    };
  }>;
  afterTurn?: NonNullable<OpenClawContextEngineBridgeOptions["afterTurn"]>;
}

export interface OpenClawContextEnginePluginApiLike {
  registerContextEngine(id: string, factory: OpenClawContextEngineFactoryLike): void;
}

export type OpenClawContextEngineFactoryLike = () => OpenClawCompatibleContextEngine | Promise<OpenClawCompatibleContextEngine>;

export interface OpenClawContextEnginePluginDefinitionLike {
  id: string;
  name: string;
  description: string;
  kind: "context-engine";
  register(api: OpenClawContextEnginePluginApiLike): void;
}

export function createOpenClawContextEngineBridge(options: OpenClawContextEngineBridgeOptions): OpenClawCompatibleContextEngine {
  return {
    info: {
      id: options.engineId,
      name: options.engineName ?? options.engineId,
      version: options.engineVersion,
      ownsCompaction: options.ownsCompaction,
    },
    bootstrap: options.bootstrap,
    maintain: options.maintain,
    ingest: async (params) => {
      if (!options.ingest) {
        return { ingested: true };
      }
      return await options.ingest(params);
    },
    ingestBatch: options.ingestBatch,
    assemble: async (params) => {
      return await options.assemble(params);
    },
    compact: async (params) => {
      return await options.compact(params);
    },
    afterTurn: options.afterTurn,
  };
}

export function createOpenClawContextEnginePluginDefinition(input: {
  pluginId: string;
  pluginName: string;
  description: string;
  engineId?: string;
  createEngine: OpenClawContextEngineFactoryLike;
}): OpenClawContextEnginePluginDefinitionLike {
  return {
    id: input.pluginId,
    name: input.pluginName,
    description: input.description,
    kind: "context-engine",
    register(api) {
      api.registerContextEngine(input.engineId ?? input.pluginId, input.createEngine);
    },
  };
}
