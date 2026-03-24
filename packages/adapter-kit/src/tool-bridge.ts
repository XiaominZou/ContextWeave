import { fileURLToPath } from "node:url";

import {
  resolveDefaultMemoryChannel,
  type MemoryKindV1_1,
  type MemoryRecordV1_1,
  type MemorySearchQuery,
  type MemorySearchResult,
  type Run,
  type Task,
  type WriteConfirmedInput,
} from "@ctx/core";

import type { McpServerConfig, ToolSchema } from "./types";

export const PLATFORM_MEMORY_SEARCH_TOOL = "platform_memory_search";
export const PLATFORM_MEMORY_WRITE_TOOL = "platform_memory_write";
export const PLATFORM_MEMORY_MCP_SERVER = "platform-memory";
export const PLATFORM_TASK_GET_TOOL = "platform_task_get";
export const PLATFORM_TASK_LIST_TOOL = "platform_task_list";
export const PLATFORM_TASK_UPDATE_TOOL = "platform_task_update";
export const PLATFORM_TASKS_MCP_SERVER = "platform-tasks";

const MEMORY_KIND_VALUES = new Set<MemoryKindV1_1>([
  "fact",
  "preference",
  "procedure",
  "constraint",
  "insight",
  "decision",
]);

const TASK_STATUS_VALUES = new Set<Task["status"]>([
  "pending",
  "ready",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

export interface PlatformBridgeConnection {
  baseUrl: string;
  token: string;
}

export interface PlatformMemoryBridgeBindings {
  search(query: MemorySearchQuery): Promise<MemorySearchResult>;
  writeConfirmed(input: WriteConfirmedInput): Promise<MemoryRecordV1_1>;
}

export interface PlatformTaskUpdatePatch {
  title?: string;
  objective?: string;
  instructions?: string;
  status?: Task["status"];
  priority?: number;
  dependsOn?: string[];
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface PlatformTaskBridgeBindings {
  get(taskId: string): Promise<Task>;
  list(input: { sessionId?: string }): Promise<{ items: Task[] }>;
  update(taskId: string, patch: PlatformTaskUpdatePatch): Promise<Task>;
}

export interface PlatformToolExecutionContext {
  workspaceId: string;
  sessionId: string;
  taskId: string;
  runId: string;
  userId?: string;
}

export interface PlatformMemorySearchToolArgs {
  queryText: string;
  maxResults?: number;
  kind?: MemoryKindV1_1[];
}

export interface PlatformMemoryWriteToolArgs {
  kind: MemoryKindV1_1;
  title: string;
  content: string;
  summary?: string;
  keywords?: string[];
}

export interface PlatformTaskGetToolArgs {
  taskId?: string;
}

export interface PlatformTaskListToolArgs {
  sessionId?: string;
}

export interface PlatformTaskUpdateToolArgs extends PlatformTaskUpdatePatch {
  taskId?: string;
}

export interface PlatformMemorySearchToolResult {
  hits: Array<{
    id: string;
    title: string;
    summary?: string;
    content: string;
    kind: MemoryKindV1_1;
    scope: MemoryRecordV1_1["scope"];
    layer: MemoryRecordV1_1["layer"];
    channel: MemoryRecordV1_1["channel"];
    score: number;
  }>;
  namespacesSearched: MemorySearchResult["namespacesSearched"];
}

export interface PlatformMemoryWriteToolResult {
  record: {
    id: string;
    title: string;
    summary?: string;
    content: string;
    kind: MemoryKindV1_1;
    scope: MemoryRecordV1_1["scope"];
    layer: MemoryRecordV1_1["layer"];
    channel: MemoryRecordV1_1["channel"];
    status: MemoryRecordV1_1["status"];
  };
}

export interface PlatformTaskToolResult {
  task: PlatformTaskView;
}

export interface PlatformTaskListToolResult {
  items: PlatformTaskView[];
}

export interface PlatformTaskView {
  id: string;
  sessionId: string;
  title: string;
  objective?: string;
  instructions?: string;
  status: Task["status"];
  priority?: number;
  dependsOn?: string[];
  updatedAt: string;
  completedAt?: string;
}

export type PlatformMemoryToolName =
  | typeof PLATFORM_MEMORY_SEARCH_TOOL
  | typeof PLATFORM_MEMORY_WRITE_TOOL;

export type PlatformTaskToolName =
  | typeof PLATFORM_TASK_GET_TOOL
  | typeof PLATFORM_TASK_LIST_TOOL
  | typeof PLATFORM_TASK_UPDATE_TOOL;

export type PlatformToolName = PlatformMemoryToolName | PlatformTaskToolName;

export type PlatformMemoryToolResult = PlatformMemorySearchToolResult | PlatformMemoryWriteToolResult;
export type PlatformToolResult = PlatformMemoryToolResult | PlatformTaskToolResult | PlatformTaskListToolResult;

export function buildPlatformMemoryToolSchemas(): ToolSchema[] {
  return [
    {
      name: PLATFORM_MEMORY_SEARCH_TOOL,
      description: "Search platform-managed memory on demand for task-relevant context.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          queryText: { type: "string", description: "Natural-language query used to search platform memory." },
          maxResults: { type: "integer", minimum: 1, maximum: 10, description: "Optional maximum number of memories to return." },
          kind: {
            type: "array",
            description: "Optional memory kinds to filter.",
            items: { type: "string", enum: ["fact", "preference", "procedure", "constraint", "insight", "decision"] },
          },
        },
        required: ["queryText"],
      },
    },
    {
      name: PLATFORM_MEMORY_WRITE_TOOL,
      description: "Write a confirmed reusable memory into platform-managed long-term memory.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["fact", "preference", "procedure", "constraint", "insight", "decision"] },
          title: { type: "string", description: "Short human-readable title for the memory record." },
          content: { type: "string", description: "Canonical memory content to store." },
          summary: { type: "string", description: "Optional concise summary used for retrieval and prompt assembly." },
          keywords: { type: "array", description: "Optional keyword hints for future retrieval.", items: { type: "string" } },
        },
        required: ["kind", "title", "content"],
      },
    },
  ];
}

export function buildPlatformTaskToolSchemas(): ToolSchema[] {
  return [
    {
      name: PLATFORM_TASK_GET_TOOL,
      description: "Get the current canonical task or another task in the same session.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string", description: "Optional explicit task id. Defaults to the current run task." },
        },
      },
    },
    {
      name: PLATFORM_TASK_LIST_TOOL,
      description: "List canonical tasks in the current session.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string", description: "Optional explicit session id. Defaults to the current run session." },
        },
      },
    },
    {
      name: PLATFORM_TASK_UPDATE_TOOL,
      description: "Update the canonical task state tracked by the platform.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string", description: "Optional explicit task id. Defaults to the current run task." },
          title: { type: "string" },
          objective: { type: "string" },
          instructions: { type: "string" },
          status: { type: "string", enum: ["pending", "ready", "running", "blocked", "completed", "failed", "cancelled"] },
          priority: { type: "integer" },
          dependsOn: { type: "array", items: { type: "string" } },
          input: { type: "object" },
          output: { type: "object" },
          metadata: { type: "object" },
        },
      },
    },
  ];
}

export function buildPlatformMemoryMcpServers(run: Run, connection?: PlatformBridgeConnection): McpServerConfig[] {
  return [
    buildBridgeServer({
      name: PLATFORM_MEMORY_MCP_SERVER,
      run,
      route: "memory",
      connection,
    }),
  ];
}

export function buildPlatformTaskMcpServers(run: Run, connection?: PlatformBridgeConnection): McpServerConfig[] {
  return [
    buildBridgeServer({
      name: PLATFORM_TASKS_MCP_SERVER,
      run,
      route: "tasks",
      connection,
    }),
  ];
}

function buildBridgeServer(input: {
  name: string;
  run: Run;
  route: "memory" | "tasks";
  connection?: PlatformBridgeConnection;
}): McpServerConfig {
  const scriptPath = fileURLToPath(new URL("../bin/ctx-platform-memory-bridge.mjs", import.meta.url));
  return {
    name: input.name,
    command: process.execPath,
    args: [scriptPath],
    env: {
      CTX_TOOL_BRIDGE_KIND: input.route,
      CTX_WORKSPACE_ID: input.run.workspaceId,
      CTX_SESSION_ID: input.run.sessionId,
      CTX_TASK_ID: input.run.taskId,
      CTX_RUN_ID: input.run.id,
      ...(input.connection ? {
        CTX_TOOL_BRIDGE_BASE_URL: input.connection.baseUrl,
        CTX_TOOL_BRIDGE_TOKEN: input.connection.token,
      } : {}),
    },
  };
}

export async function executePlatformMemoryToolCall(input: {
  toolName: PlatformMemoryToolName;
  args: unknown;
  memory: PlatformMemoryBridgeBindings;
  context: PlatformToolExecutionContext;
}): Promise<PlatformMemoryToolResult> {
  if (input.toolName === PLATFORM_MEMORY_SEARCH_TOOL) {
    return executePlatformMemorySearch(input);
  }
  return executePlatformMemoryWrite(input);
}

export async function executePlatformTaskToolCall(input: {
  toolName: PlatformTaskToolName;
  args: unknown;
  tasks: PlatformTaskBridgeBindings;
  context: PlatformToolExecutionContext;
}): Promise<PlatformTaskToolResult | PlatformTaskListToolResult> {
  if (input.toolName === PLATFORM_TASK_GET_TOOL) {
    const args = parseTaskGetArgs(input.args);
    return { task: toTaskView(await input.tasks.get(args.taskId ?? input.context.taskId)) };
  }
  if (input.toolName === PLATFORM_TASK_LIST_TOOL) {
    const args = parseTaskListArgs(input.args);
    const result = await input.tasks.list({ sessionId: args.sessionId ?? input.context.sessionId });
    return { items: result.items.map(toTaskView) };
  }
  const args = parseTaskUpdateArgs(input.args);
  const task = await input.tasks.update(args.taskId ?? input.context.taskId, {
    title: args.title,
    objective: args.objective,
    instructions: args.instructions,
    status: args.status,
    priority: args.priority,
    dependsOn: args.dependsOn,
    input: args.input,
    output: args.output,
    metadata: args.metadata,
  });
  return { task: toTaskView(task) };
}

async function executePlatformMemorySearch(input: {
  args: unknown;
  memory: PlatformMemoryBridgeBindings;
  context: PlatformToolExecutionContext;
}): Promise<PlatformMemorySearchToolResult> {
  const args = parseSearchArgs(input.args);
  const result = await input.memory.search({
    anchor: {
      workspaceId: input.context.workspaceId,
      userId: input.context.userId,
      sessionId: input.context.sessionId,
      taskId: input.context.taskId,
      runId: input.context.runId,
    },
    queryText: args.queryText,
    kind: args.kind,
    maxResults: args.maxResults ?? 5,
  });

  return {
    hits: result.hits.map((hit) => ({
      id: hit.record.id,
      title: hit.record.title,
      summary: hit.record.summary,
      content: hit.record.content,
      kind: hit.record.kind,
      scope: hit.record.scope,
      layer: hit.record.layer,
      channel: hit.record.channel,
      score: hit.finalScore,
    })),
    namespacesSearched: result.namespacesSearched,
  };
}

async function executePlatformMemoryWrite(input: {
  args: unknown;
  memory: PlatformMemoryBridgeBindings;
  context: PlatformToolExecutionContext;
}): Promise<PlatformMemoryWriteToolResult> {
  const args = parseWriteArgs(input.args);
  const defaultChannel = resolveDefaultMemoryChannel(args.kind);
  const channel = defaultChannel === "profile" && !input.context.userId ? "collection" : defaultChannel;
  const scope = channel === "profile" && input.context.userId ? "user" : "workspace";
  const ownerRef = scope === "user" && input.context.userId
    ? ({ type: "user", id: input.context.userId } as const)
    : ({ type: "workspace", id: input.context.workspaceId } as const);

  const record = await input.memory.writeConfirmed({
    record: {
      workspaceId: input.context.workspaceId,
      userId: scope === "user" ? input.context.userId : undefined,
      sessionId: input.context.sessionId,
      taskId: input.context.taskId,
      runId: input.context.runId,
      ownerRef,
      scope,
      layer: "long_term",
      channel,
      kind: args.kind,
      status: "active",
      title: args.title,
      content: args.content,
      summary: args.summary,
      keywords: args.keywords,
      confirmedBy: "user",
      sourceRefs: [{ type: "run", id: input.context.runId }],
    },
  });

  return {
    record: {
      id: record.id,
      title: record.title,
      summary: record.summary,
      content: record.content,
      kind: record.kind,
      scope: record.scope,
      layer: record.layer,
      channel: record.channel,
      status: record.status,
    },
  };
}

function toTaskView(task: Task): PlatformTaskView {
  return {
    id: task.id,
    sessionId: task.sessionId,
    title: task.title,
    objective: task.objective,
    instructions: task.instructions,
    status: task.status,
    priority: task.priority,
    dependsOn: task.dependsOn,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
  };
}

function parseSearchArgs(value: unknown): PlatformMemorySearchToolArgs {
  const args = asRecord(value, PLATFORM_MEMORY_SEARCH_TOOL);
  const queryText = requireString(args.queryText, "queryText", PLATFORM_MEMORY_SEARCH_TOOL);
  const maxResults = args.maxResults === undefined ? undefined : requireIntegerInRange(args.maxResults, "maxResults", 1, 10, PLATFORM_MEMORY_SEARCH_TOOL);
  const kind = args.kind === undefined ? undefined : requireKindArray(args.kind, PLATFORM_MEMORY_SEARCH_TOOL);
  return { queryText, maxResults, kind };
}

function parseWriteArgs(value: unknown): PlatformMemoryWriteToolArgs {
  const args = asRecord(value, PLATFORM_MEMORY_WRITE_TOOL);
  const kind = requireKind(args.kind, "kind", PLATFORM_MEMORY_WRITE_TOOL);
  const title = requireString(args.title, "title", PLATFORM_MEMORY_WRITE_TOOL);
  const content = requireString(args.content, "content", PLATFORM_MEMORY_WRITE_TOOL);
  const summary = args.summary === undefined ? undefined : requireString(args.summary, "summary", PLATFORM_MEMORY_WRITE_TOOL);
  const keywords = args.keywords === undefined ? undefined : requireStringArray(args.keywords, "keywords", PLATFORM_MEMORY_WRITE_TOOL);
  return { kind, title, content, summary, keywords };
}

function parseTaskGetArgs(value: unknown): PlatformTaskGetToolArgs {
  const args = asRecord(value, PLATFORM_TASK_GET_TOOL);
  return { taskId: args.taskId === undefined ? undefined : requireString(args.taskId, "taskId", PLATFORM_TASK_GET_TOOL) };
}

function parseTaskListArgs(value: unknown): PlatformTaskListToolArgs {
  const args = asRecord(value, PLATFORM_TASK_LIST_TOOL);
  return { sessionId: args.sessionId === undefined ? undefined : requireString(args.sessionId, "sessionId", PLATFORM_TASK_LIST_TOOL) };
}

function parseTaskUpdateArgs(value: unknown): PlatformTaskUpdateToolArgs {
  const args = asRecord(value, PLATFORM_TASK_UPDATE_TOOL);
  return {
    taskId: args.taskId === undefined ? undefined : requireString(args.taskId, "taskId", PLATFORM_TASK_UPDATE_TOOL),
    title: args.title === undefined ? undefined : requireString(args.title, "title", PLATFORM_TASK_UPDATE_TOOL),
    objective: args.objective === undefined ? undefined : requireString(args.objective, "objective", PLATFORM_TASK_UPDATE_TOOL),
    instructions: args.instructions === undefined ? undefined : requireString(args.instructions, "instructions", PLATFORM_TASK_UPDATE_TOOL),
    status: args.status === undefined ? undefined : requireTaskStatus(args.status, "status", PLATFORM_TASK_UPDATE_TOOL),
    priority: args.priority === undefined ? undefined : requireInteger(args.priority, "priority", PLATFORM_TASK_UPDATE_TOOL),
    dependsOn: args.dependsOn === undefined ? undefined : requireStringArray(args.dependsOn, "dependsOn", PLATFORM_TASK_UPDATE_TOOL),
    input: args.input === undefined ? undefined : requireObject(args.input, "input", PLATFORM_TASK_UPDATE_TOOL),
    output: args.output === undefined ? undefined : requireObject(args.output, "output", PLATFORM_TASK_UPDATE_TOOL),
    metadata: args.metadata === undefined ? undefined : requireObject(args.metadata, "metadata", PLATFORM_TASK_UPDATE_TOOL),
  };
}

function asRecord(value: unknown, toolName: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  throw createToolInputError(toolName, "arguments must be an object");
}

function requireString(value: unknown, field: string, toolName: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw createToolInputError(toolName, `${field} must be a non-empty string`);
}

function requireObject(value: unknown, field: string, toolName: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw createToolInputError(toolName, `${field} must be an object`);
}

function requireInteger(value: unknown, field: string, toolName: string): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  throw createToolInputError(toolName, `${field} must be an integer`);
}

function requireIntegerInRange(value: unknown, field: string, min: number, max: number, toolName: string): number {
  const parsed = requireInteger(value, field, toolName);
  if (parsed >= min && parsed <= max) {
    return parsed;
  }
  throw createToolInputError(toolName, `${field} must be an integer between ${min} and ${max}`);
}

function requireKind(value: unknown, field: string, toolName: string): MemoryKindV1_1 {
  if (typeof value === "string" && MEMORY_KIND_VALUES.has(value as MemoryKindV1_1)) {
    return value as MemoryKindV1_1;
  }
  throw createToolInputError(toolName, `${field} must be a supported memory kind`);
}

function requireTaskStatus(value: unknown, field: string, toolName: string): Task["status"] {
  if (typeof value === "string" && TASK_STATUS_VALUES.has(value as Task["status"])) {
    return value as Task["status"];
  }
  throw createToolInputError(toolName, `${field} must be a supported task status`);
}

function requireKindArray(value: unknown, toolName: string): MemoryKindV1_1[] {
  if (!Array.isArray(value)) {
    throw createToolInputError(toolName, "kind must be an array of supported memory kinds");
  }
  return value.map((item) => requireKind(item, "kind[]", toolName));
}

function requireStringArray(value: unknown, field: string, toolName: string): string[] {
  if (!Array.isArray(value)) {
    throw createToolInputError(toolName, `${field} must be an array of strings`);
  }
  return value.map((item) => {
    if (typeof item === "string" && item.trim().length > 0) {
      return item;
    }
    throw createToolInputError(toolName, `${field} must contain only non-empty strings`);
  });
}

function createToolInputError(toolName: string, message: string): Error & { code: string } {
  const error = new Error(`${toolName}: ${message}`) as Error & { code: string };
  error.code = "INVALID_TOOL_INPUT";
  return error;
}
