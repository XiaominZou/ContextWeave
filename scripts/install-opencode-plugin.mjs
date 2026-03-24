#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
const opencodeDir = path.join(configHome, "opencode");
const configPath = path.join(opencodeDir, "opencode.json");
const pluginPath = path.resolve(process.argv[2] || "plugins/opencode/ctx-platform-plugin.mjs");

await mkdir(opencodeDir, { recursive: true });
const existing = await loadConfig(configPath);
const plugin = Array.isArray(existing.plugin) ? existing.plugin.filter((value) => typeof value === "string") : [];
existing.plugin = [...new Set([...plugin, pluginPath])];
await writeFile(configPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
process.stdout.write(`[ctx-opencode-install] plugin registered in ${configPath}\n`);
process.stdout.write(`[ctx-opencode-install] plugin path: ${pluginPath}\n`);

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
