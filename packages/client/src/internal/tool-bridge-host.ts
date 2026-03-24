import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Run } from "@ctx/core";
import {
  executePlatformMemoryToolCall,
  executePlatformTaskToolCall,
  type PlatformBridgeConnection,
  type PlatformMemoryBridgeBindings,
  type PlatformMemoryToolName,
  type PlatformTaskBridgeBindings,
  type PlatformTaskToolName,
  type PlatformToolExecutionContext,
} from "@ctx/adapter-kit";

interface ToolBridgeRegistration {
  token: string;
  context: PlatformToolExecutionContext;
}

export interface RegisterToolBridgeRunInput {
  run: Run;
  userId?: string;
}

export interface ToolBridgeHost {
  registerRun(input: RegisterToolBridgeRunInput): Promise<PlatformBridgeConnection>;
  unregisterRun(runId: string): void;
  close(): Promise<void>;
}

export function createToolBridgeHost(input: {
  memory: PlatformMemoryBridgeBindings;
  tasks: PlatformTaskBridgeBindings;
}): ToolBridgeHost {
  const registrations = new Map<string, ToolBridgeRegistration>();
  let serverPromise: Promise<{ server: Server; baseUrl: string }> | null = null;

  return {
    async registerRun(registrationInput) {
      const serverState = await ensureServer();
      const token = randomUUID();
      registrations.set(registrationInput.run.id, {
        token,
        context: {
          workspaceId: registrationInput.run.workspaceId,
          sessionId: registrationInput.run.sessionId,
          taskId: registrationInput.run.taskId,
          runId: registrationInput.run.id,
          userId: registrationInput.userId,
        },
      });
      return {
        baseUrl: serverState.baseUrl,
        token,
      };
    },
    unregisterRun(runId) {
      registrations.delete(runId);
    },
    async close() {
      const serverState = serverPromise ? await serverPromise : null;
      registrations.clear();
      if (!serverState) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        serverState.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      serverPromise = null;
    },
  };

  async function ensureServer(): Promise<{ server: Server; baseUrl: string }> {
    if (serverPromise) {
      return serverPromise;
    }

    serverPromise = new Promise((resolve, reject) => {
      const server = createServer(async (request, response) => {
        try {
          await handleRequest(request, response);
        } catch (error) {
          const message = error instanceof Error ? error.message : "tool-bridge host failed";
          const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
            ? String((error as { code: string }).code)
            : "TOOL_BRIDGE_HOST_ERROR";
          writeJson(response, 500, { error: { code, message } });
        }
      });

      server.on("error", (error) => reject(error));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("tool-bridge host failed to bind to a TCP port"));
          return;
        }
        resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
      });
    });

    return serverPromise;
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || (request.url !== "/memory/invoke" && request.url !== "/tasks/invoke")) {
      writeJson(response, 404, { error: { code: "TOOL_BRIDGE_NOT_FOUND", message: "tool-bridge route not found" } });
      return;
    }

    const body = await readJsonBody(request);
    if (!isRecord(body)) {
      writeJson(response, 400, { error: { code: "INVALID_TOOL_BRIDGE_REQUEST", message: "request body must be an object" } });
      return;
    }

    const token = typeof body.token === "string" ? body.token : undefined;
    const toolName = typeof body.toolName === "string" ? body.toolName : undefined;
    if (!token || !toolName) {
      writeJson(response, 400, { error: { code: "INVALID_TOOL_BRIDGE_REQUEST", message: "token and toolName are required" } });
      return;
    }

    const registration = [...registrations.values()].find((entry) => entry.token === token);
    if (!registration) {
      writeJson(response, 403, { error: { code: "TOOL_BRIDGE_TOKEN_INVALID", message: "tool-bridge token is invalid or expired" } });
      return;
    }

    try {
      const result = request.url === "/memory/invoke"
        ? await executePlatformMemoryToolCall({
            toolName: toolName as PlatformMemoryToolName,
            args: body.arguments,
            memory: input.memory,
            context: registration.context,
          })
        : await executePlatformTaskToolCall({
            toolName: toolName as PlatformTaskToolName,
            args: body.arguments,
            tasks: input.tasks,
            context: registration.context,
          });
      writeJson(response, 200, { result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "tool execution failed";
      const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : "TOOL_BRIDGE_EXECUTION_FAILED";
      writeJson(response, 400, { error: { code, message } });
    }
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
