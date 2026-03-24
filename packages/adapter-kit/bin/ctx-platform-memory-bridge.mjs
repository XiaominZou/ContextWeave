#!/usr/bin/env node
import { createInterface } from "node:readline";

const PLATFORM_MEMORY_MCP_SERVER = "platform-memory";
const PLATFORM_MEMORY_SEARCH_TOOL = "platform_memory_search";
const PLATFORM_MEMORY_WRITE_TOOL = "platform_memory_write";
const PLATFORM_TASKS_MCP_SERVER = "platform-tasks";
const PLATFORM_TASK_GET_TOOL = "platform_task_get";
const PLATFORM_TASK_LIST_TOOL = "platform_task_list";
const PLATFORM_TASK_UPDATE_TOOL = "platform_task_update";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const baseUrl = process.env.CTX_TOOL_BRIDGE_BASE_URL;
const token = process.env.CTX_TOOL_BRIDGE_TOKEN;
const bridgeKind = process.env.CTX_TOOL_BRIDGE_KIND === "tasks" ? "tasks" : "memory";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    writeJsonRpcError(null, -32700, "Parse error");
    return;
  }

  if (!isRecord(message)) {
    writeJsonRpcError(null, -32600, "Invalid Request");
    return;
  }

  if (typeof message.id === "undefined") {
    return;
  }

  try {
    const result = await handleRequest(message);
    writeJsonRpcResult(message.id, result);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
    writeJsonRpcError(message.id, -32000, messageText, code ? { code } : undefined);
  }
});

async function handleRequest(message) {
  const method = typeof message.method === "string" ? message.method : "";
  switch (method) {
    case "initialize": {
      const requestedVersion = isRecord(message.params) && typeof message.params.protocolVersion === "string"
        ? message.params.protocolVersion
        : undefined;
      return {
        protocolVersion: negotiateProtocolVersion(requestedVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: bridgeKind === "tasks" ? PLATFORM_TASKS_MCP_SERVER : PLATFORM_MEMORY_MCP_SERVER,
          version: "0.1.0",
        },
      };
    }
    case "notifications/initialized":
    case "ping":
      return {};
    case "tools/list":
      return { tools: bridgeKind === "tasks" ? buildPlatformTaskToolSchemas() : buildPlatformMemoryToolSchemas() };
    case "tools/call": {
      if (!baseUrl || !token) {
        throw withCode("TOOL_BRIDGE_NOT_CONFIGURED", "tool-bridge base URL/token are missing");
      }
      const params = isRecord(message.params) ? message.params : {};
      const toolName = typeof params.name === "string" ? params.name : "";
      const args = isRecord(params.arguments) ? params.arguments : {};
      const structuredContent = await invokeBridgeHost({ toolName, args });
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
        isError: false,
      };
    }
    default:
      throw withCode("METHOD_NOT_FOUND", `Unsupported MCP method: ${method || "<missing>"}`);
  }
}

async function invokeBridgeHost(input) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/${bridgeKind}/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, toolName: input.toolName, arguments: input.args }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const payloadError = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const message = payloadError && typeof payloadError.message === "string" ? payloadError.message : `Bridge host responded with ${response.status}`;
    const code = payloadError && typeof payloadError.code === "string" ? payloadError.code : "TOOL_BRIDGE_HTTP_ERROR";
    throw withCode(code, message);
  }
  if (isRecord(payload) && "error" in payload && payload.error) {
    const payloadError = isRecord(payload.error) ? payload.error : null;
    const code = payloadError && typeof payloadError.code === "string" ? payloadError.code : "TOOL_BRIDGE_ERROR";
    const message = payloadError && typeof payloadError.message === "string" ? payloadError.message : "Bridge host returned an error";
    throw withCode(code, message);
  }
  if (isRecord(payload) && "result" in payload) {
    return payload.result;
  }
  throw withCode("TOOL_BRIDGE_INVALID_RESPONSE", "Bridge host returned an invalid payload");
}

function buildPlatformMemoryToolSchemas() {
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
          kind: { type: "array", description: "Optional memory kinds to filter.", items: { type: "string", enum: ["fact", "preference", "procedure", "constraint", "insight", "decision"] } },
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
          title: { type: "string" },
          content: { type: "string" },
          summary: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
        },
        required: ["kind", "title", "content"],
      },
    },
  ];
}

function buildPlatformTaskToolSchemas() {
  return [
    {
      name: PLATFORM_TASK_GET_TOOL,
      description: "Get the current canonical task or another task in the same session.",
      inputSchema: { type: "object", additionalProperties: false, properties: { taskId: { type: "string" } } },
    },
    {
      name: PLATFORM_TASK_LIST_TOOL,
      description: "List canonical tasks in the current session.",
      inputSchema: { type: "object", additionalProperties: false, properties: { sessionId: { type: "string" } } },
    },
    {
      name: PLATFORM_TASK_UPDATE_TOOL,
      description: "Update the canonical task state tracked by the platform.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
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

function negotiateProtocolVersion(requestedVersion) {
  if (requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
    return requestedVersion;
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

function writeJsonRpcResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}
`);
}

function writeJsonRpcError(id, errorCode, message, data) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: errorCode, message, data } })}
`);
}

function withCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
