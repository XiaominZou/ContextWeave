import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";

const OPENCODE_DIRNAME = "opencode";
const OPENCODE_CONFIG_FILENAME = "opencode.json";
const PLATFORM_PLUGIN_FILENAME = "ctx-platform-transparent-plugin.mjs";

const PLATFORM_PLUGIN_SOURCE = `export default async function () {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const context = (process.env.CTX_OPENCODE_PLATFORM_CONTEXT ?? "").trim();
      if (!context) {
        return;
      }

      const policy = process.env.CTX_OPENCODE_CONTEXT_POLICY ?? "inject";
      const block = ["[PLATFORM_CONTEXT]", context, "[/PLATFORM_CONTEXT]"].join("\\n");

      if (policy === "replace") {
        output.system = [block];
        return;
      }

      output.system.push(block);
    },
  };
}
`;

export interface OpenCodeTransparentPluginSetup {
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export async function prepareTransparentPluginOverlay(input: {
  platformContext: string;
  policy: "inject" | "replace";
  env: NodeJS.ProcessEnv;
}): Promise<OpenCodeTransparentPluginSetup> {
  const root = await mkdtemp(path.join(tmpdir(), "ctx-opencode-plugin-"));
  const configHome = path.join(root, "config");
  const configDir = path.join(configHome, OPENCODE_DIRNAME);
  await mkdir(configDir, { recursive: true });

  const sourceConfigHome = resolveConfigHome(input.env);
  const sourceConfigDir = path.join(sourceConfigHome, OPENCODE_DIRNAME);
  const sourceConfigPath = path.join(sourceConfigDir, OPENCODE_CONFIG_FILENAME);
  const targetConfigPath = path.join(configDir, OPENCODE_CONFIG_FILENAME);
  const targetPluginPath = path.join(configDir, PLATFORM_PLUGIN_FILENAME);

  const existingConfig = await loadExistingConfig(sourceConfigPath);
  const pluginList = Array.isArray(existingConfig.plugin)
    ? existingConfig.plugin.filter((value): value is string => typeof value === "string")
    : [];

  await writeFile(targetPluginPath, PLATFORM_PLUGIN_SOURCE, "utf8");

  const mergedConfig = {
    ...existingConfig,
    plugin: dedupeStrings([...pluginList, targetPluginPath]),
  };

  await writeFile(targetConfigPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, "utf8");
  await mirrorNodeModules(sourceConfigDir, configDir);

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: configHome,
      CTX_OPENCODE_PLATFORM_CONTEXT: input.platformContext,
      CTX_OPENCODE_CONTEXT_POLICY: input.policy,
    },
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function loadExistingConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = parseTrustedJsoncObject(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseTrustedJsoncObject(text: string): unknown {
  const source = text.replace(/^\uFEFF/, "").trim();
  if (!source) {
    return {};
  }
  return Function(`"use strict"; return (${source});`)();
}

function resolveConfigHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME?.trim() ? env.XDG_CONFIG_HOME : path.join(homedir(), ".config");
}

async function mirrorNodeModules(sourceConfigDir: string, targetConfigDir: string): Promise<void> {
  const sourceNodeModules = path.join(sourceConfigDir, "node_modules");
  const targetNodeModules = path.join(targetConfigDir, "node_modules");
  if (!(await pathExists(sourceNodeModules))) {
    return;
  }

  try {
    await symlink(sourceNodeModules, targetNodeModules, "junction");
    return;
  } catch {
    await cp(sourceNodeModules, targetNodeModules, { recursive: true, force: true });
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
