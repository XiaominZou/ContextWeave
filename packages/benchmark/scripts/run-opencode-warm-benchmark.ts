import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  formatWarmBenchmarkReport,
  runWarmBenchmark,
  stringifyWarmBenchmarkReport,
} from "../src/runner/opencode-warm-benchmark";
import type { RunWarmBenchmarkInput } from "../src/runner/opencode-warm-benchmark";
import type { WarmBenchmarkRoundDefinition } from "../src/runner/warm-round-defs";

const args = new Set(process.argv.slice(2));
const smoke = args.has("--smoke");
const argv = process.argv.slice(2);
const transport = readTransportArg(argv);
const repeatCount = readNumberArg(argv, "--repeat-count");
const roundTimeoutMs = readNumberArg(argv, "--round-timeout-ms");
const smokeRounds: WarmBenchmarkRoundDefinition[] = [
  {
    pass: "pass2",
    round: 1,
    prompt: "[RAW]\nReply with exactly WARM_PASS2_A.\nDo not use tools.\nDo not read files.\nDo not modify files.\nDo not explain.",
    purpose: "patch",
  },
  {
    pass: "pass2",
    round: 2,
    prompt: "[RAW]\nReply with exactly WARM_PASS2_B.\nDo not use tools.\nDo not read files.\nDo not modify files.\nDo not explain.",
    purpose: "debug",
  },
];

const output = await runWarmBenchmark({
  repeatCount: repeatCount ?? (smoke ? 1 : 3),
  agent: smoke ? "build" : undefined,
  roundTimeoutMs: roundTimeoutMs ?? (smoke ? 45_000 : 180_000),
  rounds: smoke ? smokeRounds : undefined,
  transport: transport ?? "cli",
});

const resultsDir = resolve(process.cwd(), "results");
await mkdir(resultsDir, { recursive: true });
const outputPath = resolve(resultsDir, `opencode-warm-benchmark-${Date.now()}.json`);
await writeFile(outputPath, stringifyWarmBenchmarkReport(output), "utf8");

process.stdout.write(`${formatWarmBenchmarkReport(output)}\n\nSaved JSON report to ${outputPath}\n`);

function readTransportArg(argv: string[]): RunWarmBenchmarkInput["transport"] | undefined {
  const match = argv.find((arg) => arg.startsWith("--transport="));
  const value = match?.slice("--transport=".length);
  if (value === "cli" || value === "host" || value === "mixed-host") {
    return value;
  }
  return undefined;
}

function readNumberArg(argv: string[], flag: string): number | undefined {
  const match = argv.find((arg) => arg.startsWith(`${flag}=`));
  const rawValue = match?.slice(`${flag}=`.length);
  const value = rawValue ? Number.parseInt(rawValue, 10) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}
