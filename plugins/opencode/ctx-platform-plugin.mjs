#!/usr/bin/env node
import path from "node:path";

const BASE_URL = process.env.CTX_OPENCODE_PLATFORM_DAEMON_URL || "http://127.0.0.1:4317";
const CONTEXT_MODE = process.env.CTX_OPENCODE_PLATFORM_CONTEXT_MODE || "inject";

export default async function (input) {
  const directory = input?.directory || process.cwd();

  async function post(route, payload) {
    const response = await fetch(`${BASE_URL}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ctx platform daemon request failed: ${response.status} ${text}`);
    }

    return response.json();
  }

  function partsToText(parts) {
    if (!Array.isArray(parts)) {
      return "";
    }
    return parts
      .map((part) => {
        if (part && typeof part === "object" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return {
    "chat.message": async (hookInput, output) => {
      const text = partsToText(output?.parts);
      if (!text) {
        return;
      }
      await post("/v1/chat/message", {
        directory,
        opencodeSessionId: hookInput?.sessionID,
        text,
      });
    },
    "experimental.chat.system.transform": async (hookInput, output) => {
      const result = await post("/v1/context/system", {
        directory,
        opencodeSessionId: hookInput?.sessionID,
        model: hookInput?.model?.id || hookInput?.model?.name || null,
      });
      const systemBlock = typeof result.system === "string" ? result.system.trim() : "";
      if (!systemBlock) {
        return;
      }
      const wrapped = ["[CTX_PLATFORM]", systemBlock, "[/CTX_PLATFORM]"].join("\n");
      if (CONTEXT_MODE === "replace") {
        output.system = [wrapped];
        return;
      }
      output.system.push(wrapped);
    },
  };
}
