import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

export async function prepareBaselineConfigOverlay(): Promise<{ env: Record<string, string>; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "ctx-opencode-baseline-"));
  const configHome = path.join(root, "config");
  const configDir = path.join(configHome, "opencode");
  await mkdir(configDir, { recursive: true });

  const sourceConfigPath = path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config"), "opencode", "opencode.json");
  const targetConfigPath = path.join(configDir, "opencode.json");
  const existingConfig = await loadJsonObject(sourceConfigPath);
  const sanitizedConfig = {
    ...existingConfig,
    plugin: [],
  };
  await writeFile(targetConfigPath, `${JSON.stringify(sanitizedConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      XDG_CONFIG_HOME: configHome,
    },
    cleanup: async () => {
      await removePathWithRetry(root);
    },
  };
}

export async function copyFixtureToTemp(sourceDir: string): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "ctx-benchmark-fixture-"));
  const targetDir = path.join(root, "minikanban");
  await cp(sourceDir, targetDir, { recursive: true, force: true });
  return {
    dir: targetDir,
    cleanup: async () => {
      await removePathWithRetry(root);
    },
  };
}

async function loadJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function removePathWithRetry(targetPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(250 * (attempt + 1));
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
