#!/usr/bin/env node
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getOpenClawProjectStateDir, getOpenClawProjectWorkspaceDir } from "./openclaw-project-paths.mjs";

const stateHome = getOpenClawProjectStateDir();
const configPath = path.join(stateHome, "openclaw.json");
const pluginRoot = path.resolve(process.argv[2] || "plugins/openclaw");
const pluginId = "ctx-platform-openclaw";
const engineId = process.env.CTX_OPENCLAW_PLATFORM_ENGINE_ID || "ctx-platform";
const daemonUrl = process.env.CTX_OPENCLAW_PLATFORM_DAEMON_URL || "http://127.0.0.1:4318";
const contextMode = process.env.CTX_OPENCLAW_PLATFORM_CONTEXT_MODE === "replace" ? "replace" : "inject";
const workspaceDir = getOpenClawProjectWorkspaceDir();

await mkdir(stateHome, { recursive: true });
const existing = await loadConfig(configPath);

existing.plugins = isRecord(existing.plugins) ? existing.plugins : {};
existing.plugins.load = isRecord(existing.plugins.load) ? existing.plugins.load : {};
existing.plugins.entries = isRecord(existing.plugins.entries) ? existing.plugins.entries : {};
existing.plugins.slots = isRecord(existing.plugins.slots) ? existing.plugins.slots : {};

const loadPaths = Array.isArray(existing.plugins.load.paths)
  ? existing.plugins.load.paths.filter((value) => typeof value === "string")
  : [];
existing.plugins.load.paths = [...new Set([...loadPaths, pluginRoot])];
existing.plugins.entries[pluginId] = {
  ...(isRecord(existing.plugins.entries[pluginId]) ? existing.plugins.entries[pluginId] : {}),
  enabled: true,
  config: {
    ...(isRecord(existing.plugins.entries[pluginId]?.config) ? existing.plugins.entries[pluginId].config : {}),
    daemonUrl,
    engineId,
    contextMode,
    workspaceDir,
  },
};
existing.plugins.slots.contextEngine = engineId;
existing.agents = isRecord(existing.agents) ? existing.agents : {};
existing.agents.defaults = isRecord(existing.agents.defaults) ? existing.agents.defaults : {};
existing.agents.defaults.workspace = workspaceDir;

await writeFile(configPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
process.stdout.write(`[ctx-openclaw-install] plugin path registered in ${configPath}\n`);
process.stdout.write(`[ctx-openclaw-install] project state dir: ${stateHome}\n`);
process.stdout.write(`[ctx-openclaw-install] plugin root: ${pluginRoot}\n`);
process.stdout.write(`[ctx-openclaw-install] context engine slot: ${engineId}\n`);
process.stdout.write(`[ctx-openclaw-install] daemon url: ${daemonUrl}\n`);
process.stdout.write(`[ctx-openclaw-install] context mode: ${contextMode}\n`);
process.stdout.write(`[ctx-openclaw-install] workspace dir: ${workspaceDir}\n`);

async function loadConfig(filePath) {
  try {
    const raw = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "").trim();
    if (!raw) {
      return {};
    }
    return Function(`"use strict"; return (${raw});`)();
  } catch {
    return {};
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}
