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

export interface OpenClawContextEngineAfterTurnParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  messages: OpenClawAgentMessage[];
  prePromptMessageCount: number;
  autoCompactionSummary?: string;
  isHeartbeat?: boolean;
  tokenBudget?: number;
  model?: string;
  runtimeContext?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  status?: string;
  error?: unknown;
  cancelled?: boolean;
}

export interface OpenClawContextEngineBridgeOptions {
  engineId: string;
  engineName?: string;
  engineVersion?: string;
  ownsCompaction?: boolean;
  bootstrap?: (params: { sessionId: string; sessionKey?: string; sessionFile: string }) => Promise<{ bootstrapped: boolean; importedMessages?: number; reason?: string }>;
  ingest?: (params: OpenClawContextEngineIngestParams) => Promise<{ ingested: boolean }>;
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
  afterTurn?: (params: OpenClawContextEngineAfterTurnParams) => Promise<void>;
}

export interface OpenClawCompatibleContextEngine {
  readonly info: {
    id: string;
    name: string;
    version?: string;
    ownsCompaction?: boolean;
  };
  bootstrap?: NonNullable<OpenClawContextEngineBridgeOptions["bootstrap"]>;
  ingest(params: OpenClawContextEngineIngestParams): Promise<{ ingested: boolean }>;
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

export function createOpenClawContextEngineBridge(options: OpenClawContextEngineBridgeOptions): OpenClawCompatibleContextEngine {
  return {
    info: {
      id: options.engineId,
      name: options.engineName ?? options.engineId,
      version: options.engineVersion,
      ownsCompaction: options.ownsCompaction,
    },
    bootstrap: options.bootstrap,
    ingest: async (params) => {
      if (!options.ingest) {
        return { ingested: true };
      }
      return await options.ingest(params);
    },
    assemble: async (params) => {
      return await options.assemble(params);
    },
    compact: async (params) => {
      return await options.compact(params);
    },
    afterTurn: options.afterTurn,
  };
}
