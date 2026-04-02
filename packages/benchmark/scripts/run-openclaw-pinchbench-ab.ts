import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareOpenClawPinchBenchTasks,
  compareOpenClawPinchBenchScenarios,
  formatOpenClawPinchBenchReport,
  formatOpenClawPinchBenchTaskReport,
  summarizeOpenClawPinchBenchScenario,
  type OpenClawPinchBenchComparison,
  type OpenClawPinchBenchScenario,
  type PinchBenchAggregateResult,
} from "../src/pinchbench/openclaw-pinchbench";

interface CliOptions {
  pinchbenchDir: string;
  model: string;
  suite: string;
  runs: number;
  judge?: string;
  timeoutMultiplier?: number;
  outputDir: string;
  contextMode: "inject" | "replace";
  scenario: "both" | OpenClawPinchBenchScenario;
  smoke: boolean;
  keepRuntimeState: boolean;
}

interface OpenClawConfig {
  auth?: Record<string, unknown>;
  models?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  commands?: Record<string, unknown>;
  skills?: Record<string, unknown>;
  plugins?: Record<string, unknown>;
  gateway?: Record<string, unknown>;
  [key: string]: unknown;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

const options = parseArgs(process.argv.slice(2));
const timestamp = Date.now();
const runOutputDir = resolve(options.outputDir, `openclaw-pinchbench-ab-${timestamp}`);
await mkdir(runOutputDir, { recursive: true });

const requestedScenarios = options.scenario === "both"
  ? (["without-platform", "with-platform"] as const)
  : ([options.scenario] as const);

const scenarioSummaries = new Map<OpenClawPinchBenchScenario, ReturnType<typeof summarizeOpenClawPinchBenchScenario>>();
const rawScenarioOutputs: Record<string, PinchBenchAggregateResult> = {};

for (const scenario of requestedScenarios) {
  const result = await runScenario(scenario, options, runOutputDir);
  rawScenarioOutputs[scenario] = result.aggregate;
  scenarioSummaries.set(
    scenario,
    summarizeOpenClawPinchBenchScenario(scenario, result.aggregate),
  );
}

let comparison: OpenClawPinchBenchComparison | null = null;
let taskComparisons: ReturnType<typeof compareOpenClawPinchBenchTasks> = [];
if (scenarioSummaries.has("without-platform") && scenarioSummaries.has("with-platform")) {
  comparison = compareOpenClawPinchBenchScenarios(
    scenarioSummaries.get("without-platform")!,
    scenarioSummaries.get("with-platform")!,
  );
  taskComparisons = compareOpenClawPinchBenchTasks(
    rawScenarioOutputs["without-platform"],
    rawScenarioOutputs["with-platform"],
  );
  const report = `${formatOpenClawPinchBenchReport(comparison)}\n\nPer-task breakdown:\n${formatOpenClawPinchBenchTaskReport(taskComparisons)}\n`;
  await writeFile(join(runOutputDir, "comparison.md"), report, "utf8");
  process.stdout.write(`${report}\n`);
}

await writeFile(
  join(runOutputDir, "comparison.json"),
  `${JSON.stringify({
    generatedAt: new Date(timestamp).toISOString(),
    options,
    scenarios: Object.fromEntries(scenarioSummaries),
    comparison,
    taskComparisons,
    rawScenarioOutputs,
  }, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`Saved PinchBench A/B artifacts to ${runOutputDir}\n`);
process.exit(0);

async function runScenario(
  scenario: OpenClawPinchBenchScenario,
  options: CliOptions,
  runOutputDir: string,
): Promise<{ aggregate: PinchBenchAggregateResult }> {
  const scenarioDir = join(runOutputDir, scenario);
  const runtimeRoot = join(scenarioDir, "runtime");
  const homeDir = join(runtimeRoot, "home");
  const stateDir = join(scenarioDir, ".openclaw-project");
  const resultsDir = join(scenarioDir, "results");
  const gatewayPort = await findOpenPort();
  const daemonPort = scenario === "with-platform" ? await findOpenPort() : undefined;

  await mkdir(resultsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(stateDir, "tmp"), { recursive: true });
  await prepareOpenClawState({
    scenario,
    stateDir,
    contextMode: options.contextMode,
    daemonPort,
    gatewayPort,
  });

  const env = buildScenarioEnv({ homeDir, stateDir });

  const gateway = await startOpenClawGateway({
    scenarioDir,
    env,
    gatewayPort,
  });

  let daemon: ReturnType<typeof spawn> | undefined;
  if (scenario === "with-platform") {
    daemon = await startPlatformDaemon({
      scenarioDir,
      stateDir,
      env,
      daemonPort: daemonPort!,
    });
  }

  try {
    const benchmarkArgs = [
      "run",
      resolve(repoRoot, "packages/benchmark/scripts/pinchbench-local-runner.py"),
      "--pinchbench-dir",
      options.pinchbenchDir,
      "--model",
      options.model,
      "--suite",
      options.suite,
      "--runs",
      String(options.runs),
      "--output-dir",
      resultsDir,
      "--no-upload",
    ];

    if (options.judge) {
      benchmarkArgs.push("--judge", options.judge);
    }
    if (typeof options.timeoutMultiplier === "number" && options.timeoutMultiplier !== 1) {
      benchmarkArgs.push("--timeout-multiplier", String(options.timeoutMultiplier));
    }

    process.stdout.write(`Running PinchBench scenario: ${scenario}\n`);
    await runCommand("uv", benchmarkArgs, {
      cwd: repoRoot,
      env,
      logPrefix: `[pinchbench:${scenario}]`,
    });

    const resultPath = await findNewestJson(resultsDir);
    const aggregate = JSON.parse(await readFile(resultPath, "utf8")) as PinchBenchAggregateResult;
    return { aggregate };
  } finally {
    if (daemon) {
      await stopProcessTree(daemon, "platform-daemon");
    }
    await stopProcessTree(gateway, "gateway");
    if (!options.keepRuntimeState) {
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }
}

async function prepareOpenClawState(input: {
  scenario: OpenClawPinchBenchScenario;
  stateDir: string;
  contextMode: "inject" | "replace";
  daemonPort?: number;
  gatewayPort: number;
}): Promise<void> {
  const configPath = join(input.stateDir, "openclaw.json");
  const globalConfig = await loadGlobalOpenClawConfig();
  const baseConfig: OpenClawConfig = {
    auth: cloneRecord(globalConfig.auth),
    models: cloneRecord(globalConfig.models),
    tools: cloneRecord(globalConfig.tools),
    commands: cloneRecord(globalConfig.commands),
    skills: cloneRecord(globalConfig.skills),
    agents: {
      defaults: cloneRecord(
        isRecord(globalConfig.agents) && isRecord(globalConfig.agents.defaults)
          ? globalConfig.agents.defaults
          : undefined,
      ),
    },
    gateway: {
      port: input.gatewayPort,
      mode: "local",
      bind: "loopback",
      auth: {
        mode: "none",
      },
    },
  };

  if (input.scenario === "without-platform") {
    await writeFile(configPath, `${JSON.stringify(baseConfig, null, 2)}\n`, "utf8");
    return;
  }

  const pluginRoot = resolve(repoRoot, "plugins/openclaw");
  const daemonUrl = `http://127.0.0.1:${input.daemonPort ?? 4318}`;
  const config: OpenClawConfig = {
    ...baseConfig,
    plugins: {
      load: {
        paths: [pluginRoot],
      },
      entries: {
        "ctx-platform-openclaw": {
          enabled: true,
          config: {
            daemonUrl,
            engineId: "ctx-platform",
            contextMode: input.contextMode,
          },
        },
      },
      slots: {
        contextEngine: "ctx-platform",
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function buildScenarioEnv(input: { homeDir: string; stateDir: string }): NodeJS.ProcessEnv {
  const tempRoot = join(input.stateDir, "tmp");
  return {
    ...process.env,
    HOME: input.homeDir,
    USERPROFILE: input.homeDir,
    OPENCLAW_STATE_DIR: input.stateDir,
    OPENCLAW_SOURCE_MAIN_AGENT_DIR: join(homedir(), ".openclaw", "agents", "main", "agent"),
    NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=4096",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    TEMP: tempRoot,
    TMP: tempRoot,
  };
}

async function startOpenClawGateway(input: {
  scenarioDir: string;
  env: NodeJS.ProcessEnv;
  gatewayPort: number;
}): Promise<ReturnType<typeof spawn>> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await startOpenClawGatewayOnce(input);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      process.stdout.write(`Gateway startup attempt ${attempt} failed: ${lastError.message}\n`);
    }
  }
  throw lastError ?? new Error("failed to start OpenClaw gateway");
}

async function startOpenClawGatewayOnce(input: {
  scenarioDir: string;
  env: NodeJS.ProcessEnv;
  gatewayPort: number;
}): Promise<ReturnType<typeof spawn>> {
  const gatewayOutPath = join(input.scenarioDir, "gateway.out.log");
  const gatewayErrPath = join(input.scenarioDir, "gateway.err.log");
  const outStream = createWriteStream(gatewayOutPath, { flags: "a" });
  const errStream = createWriteStream(gatewayErrPath, { flags: "a" });

  const child = spawn(
    process.env.ComSpec || "cmd.exe",
    [
      "/d",
      "/s",
      "/c",
      buildWindowsCommand([
        "openclaw.cmd",
        "gateway",
        "run",
        "--allow-unconfigured",
        "--auth",
        "none",
        "--bind",
        "loopback",
        "--port",
        String(input.gatewayPort),
        "--force",
      ]),
    ],
    {
      cwd: repoRoot,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);
  child.once("exit", () => {
    outStream.end();
    errStream.end();
  });
  try {
    await waitForGatewayHealth(input.gatewayPort, child);
    return child;
  } catch (error) {
    await stopProcessTree(child, "gateway");
    throw error;
  }
}

async function startPlatformDaemon(input: {
  scenarioDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  daemonPort: number;
}): Promise<ReturnType<typeof spawn>> {
  const daemonOutPath = join(input.scenarioDir, "platform-daemon.out.log");
  const daemonErrPath = join(input.scenarioDir, "platform-daemon.err.log");
  const outStream = createWriteStream(daemonOutPath, { flags: "a" });
  const errStream = createWriteStream(daemonErrPath, { flags: "a" });
  const daemonStateDir = join(input.stateDir, "ctx-platform-daemon");

  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--loader", "./scripts/ctx-node-loader.mjs", "scripts/openclaw-platform-daemon.mjs"],
    {
      cwd: repoRoot,
      env: {
        ...input.env,
        CTX_OPENCLAW_DAEMON_STATE_DIR: daemonStateDir,
        CTX_OPENCLAW_DAEMON_PORT: String(input.daemonPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);
  child.once("exit", () => {
    outStream.end();
    errStream.end();
  });
  await waitForHealth(`http://127.0.0.1:${input.daemonPort}/health`, child);
  return child;
}

async function waitForHealth(url: string, child: ReturnType<typeof spawn>): Promise<void> {
  const timeoutAt = Date.now() + 20_000;
  while (Date.now() < timeoutAt) {
    if (child.exitCode !== null) {
      throw new Error(`platform daemon exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for platform daemon health at ${url}`);
}

async function waitForGatewayHealth(
  gatewayPort: number,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  const timeoutAt = Date.now() + 60_000;
  while (Date.now() < timeoutAt) {
    if (child.exitCode !== null) {
      throw new Error(`OpenClaw gateway exited early with code ${child.exitCode}`);
    }
    try {
      await waitForTcpPort("127.0.0.1", gatewayPort, 1_000);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("timed out waiting for OpenClaw gateway health");
}

async function runCommand(
  command: string,
  args: string[],
  input: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    logPrefix: string;
  },
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      rejectPromise(new Error(`${input.logPrefix} failed to start: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${input.logPrefix} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function findNewestJson(dir: string): Promise<string> {
  const entries = await readdir(dir);
  const jsonFiles = entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(dir, entry));
  if (jsonFiles.length === 0) {
    throw new Error(`no PinchBench JSON results found in ${dir}`);
  }

  let newestPath = jsonFiles[0];
  let newestMtime = (await stat(newestPath)).mtimeMs;
  for (const filePath of jsonFiles.slice(1)) {
    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs > newestMtime) {
      newestPath = filePath;
      newestMtime = fileStat.mtimeMs;
    }
  }
  return newestPath;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const eqIndex = arg.indexOf("=");
    if (eqIndex >= 0) {
      values.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(arg.slice(2), next);
      index += 1;
      continue;
    }
    flags.add(arg.slice(2));
  }

  const smoke = flags.has("smoke");
  const scenarioValue = values.get("scenario");
  const scenario = scenarioValue === "without-platform" || scenarioValue === "with-platform"
    ? scenarioValue
    : "both";
  const suite = smoke ? "task_00_sanity" : (values.get("suite") ?? "all");
  const runs = smoke ? 1 : Math.max(1, Number.parseInt(values.get("runs") ?? "3", 10));
  const pinchbenchDir = values.get("pinchbench-dir");
  const model = values.get("model");
  const contextMode = values.get("context-mode") === "replace" ? "replace" : "inject";

  if (!pinchbenchDir) {
    throw new Error("missing required argument: --pinchbench-dir");
  }
  if (!model) {
    throw new Error("missing required argument: --model");
  }

  return {
    pinchbenchDir: resolve(pinchbenchDir),
    model,
    suite,
    runs,
    judge: values.get("judge"),
    timeoutMultiplier: values.has("timeout-multiplier")
      ? Number.parseFloat(values.get("timeout-multiplier")!)
      : undefined,
    outputDir: resolve(values.get("output-dir") ?? join(repoRoot, "results")),
    contextMode,
    scenario,
    smoke,
    keepRuntimeState: flags.has("keep-runtime-state"),
  };
}

async function onceExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolvePromise) => {
    child.once("exit", () => resolvePromise());
  });
}

async function stopProcessTree(
  child: ReturnType<typeof spawn>,
  label: string,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill();
  const exitedGracefully = await waitForExit(child, 5_000);
  if (exitedGracefully) {
    return;
  }

  if (typeof child.pid === "number") {
    try {
      await runCommand(process.env.ComSpec || "cmd.exe", [
        "/d",
        "/s",
        "/c",
        buildWindowsCommand(["taskkill", "/PID", String(child.pid), "/T", "/F"]),
      ], {
        cwd: repoRoot,
        env: process.env,
        logPrefix: `[shutdown:${label}]`,
      });
    } catch {
      // Fall through and let the final wait decide whether the child is gone.
    }
  }

  await waitForExit(child, 10_000);
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off("exit", handleExit);
      resolvePromise(false);
    }, timeoutMs);

    const handleExit = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };

    child.once("exit", handleExit);
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function findOpenPort(): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPromise(new Error("failed to allocate daemon port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise(port);
      });
    });
    server.on("error", (error) => {
      rejectPromise(error);
    });
  });
}

async function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error(`timed out connecting to ${host}:${port}`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      rejectPromise(error);
    });
  });
}

async function loadGlobalOpenClawConfig(): Promise<OpenClawConfig> {
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as OpenClawConfig;
  } catch {
    return {};
  }
}

function cloneRecord<T extends Record<string, unknown> | undefined>(value: T): T {
  if (!value) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function printHelp(): void {
  process.stdout.write(
    [
      "OpenClaw PinchBench A/B runner",
      "",
      "Required:",
      "  --pinchbench-dir <path>   Path to the PinchBench skill checkout",
      "  --model <model-id>        Model identifier to benchmark",
      "",
      "Optional:",
      "  --suite <value>           all | automated-only | comma-separated task ids",
      "  --runs <n>                Repeats per task (default: 3, smoke: 1)",
      "  --judge <model-id>        Override judge model",
      "  --timeout-multiplier <n>  Scale task timeouts",
      "  --output-dir <path>       Where to save artifacts",
      "  --context-mode <mode>     inject | replace (default: inject)",
      "  --scenario <value>        both | without-platform | with-platform",
      "  --smoke                   Run only the sanity task once",
      "  --keep-runtime-state      Keep generated .openclaw-project state dirs",
      "",
    ].join("\n"),
  );
}

function buildWindowsCommand(parts: string[]): string {
  return parts.map((part) => quoteWindowsArg(part)).join(" ");
}

function quoteWindowsArg(value: string): string {
  if (!value) {
    return "\"\"";
  }
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, "\\\"")}"`;
}
