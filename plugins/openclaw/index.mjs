import path from "node:path";

import { delegateCompactionToRuntime } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:4318";
const DEFAULT_PLUGIN_ID = "ctx-platform-openclaw";
const DEFAULT_ENGINE_ID = "ctx-platform";

export default definePluginEntry({
  id: DEFAULT_PLUGIN_ID,
  name: "Context Platform OpenClaw",
  description: "Use the Context Platform as OpenClaw's native context engine.",
  kind: "context-engine",
  register(api) {
    const pluginConfig = isRecord(api.pluginConfig) ? api.pluginConfig : {};
    const daemonUrl = trimString(pluginConfig.daemonUrl) || process.env.CTX_OPENCLAW_PLATFORM_DAEMON_URL || DEFAULT_DAEMON_URL;
    const engineId = trimString(pluginConfig.engineId) || process.env.CTX_OPENCLAW_PLATFORM_ENGINE_ID || DEFAULT_ENGINE_ID;
    const workspaceDir = trimString(pluginConfig.workspaceDir) || process.cwd();
    const usePlatformCompaction = Boolean(pluginConfig.usePlatformCompaction);

    api.registerContextEngine(engineId, () => ({
      info: {
        id: engineId,
        name: "Context Platform",
        version: "0.1.0",
        ownsCompaction: false,
      },
      async bootstrap(params) {
        return await postJson(daemonUrl, "/v1/openclaw/context-engine/bootstrap", {
          ...params,
          workspaceDir,
        });
      },
      async ingest(params) {
        return await postJson(daemonUrl, "/v1/openclaw/context-engine/ingest", {
          ...params,
          workspaceDir,
        });
      },
      async assemble(params) {
        const result = await postJson(daemonUrl, "/v1/openclaw/context-engine/assemble", {
          ...params,
          workspaceDir,
        });
        return {
          messages: Array.isArray(result.messages) ? result.messages : params.messages,
          estimatedTokens: typeof result.estimatedTokens === "number" ? result.estimatedTokens : estimateTokens(params.messages),
          systemPromptAddition: typeof result.systemPromptAddition === "string" ? result.systemPromptAddition : undefined,
        };
      },
      async compact(params) {
        if (!usePlatformCompaction) {
          return await delegateCompactionToRuntime(params);
        }
        return await postJson(daemonUrl, "/v1/openclaw/context-engine/compact", {
          ...params,
          workspaceDir,
        });
      },
      async afterTurn(params) {
        await postJson(daemonUrl, "/v1/openclaw/context-engine/after-turn", {
          ...params,
          workspaceDir,
        });
      },
    }));
  },
});

async function postJson(baseUrl, route, payload) {
  const response = await fetch(new URL(route, ensureTrailingSlash(baseUrl)), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ctx-platform-openclaw request failed: ${response.status} ${text}`);
  }

  return await response.json();
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function trimString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function estimateTokens(messages) {
  if (!Array.isArray(messages)) {
    return 0;
  }
  const text = messages
    .map((message) => {
      if (!isRecord(message)) {
        return "";
      }
      return stringifyContent(message.content);
    })
    .join("\n");
  return Math.ceil(text.length / 4);
}

function stringifyContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (isRecord(part) && typeof part.text === "string") {
        return part.text;
      }
      return "";
    }).join("\n");
  }
  if (isRecord(content) && typeof content.text === "string") {
    return content.text;
  }
  return "";
}
