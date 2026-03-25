import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatBenchmarkReport, stringifyBenchmarkReport } from "../src/index.ts";
import { runRealBenchmark } from "../src/runner/opencode-real-benchmark";
import type { BenchmarkRoundDefinition } from "../src/runner/round-defs";
import type { RunRealBenchmarkInput } from "../src/runner/opencode-real-benchmark";

const args = new Set(process.argv.slice(2));
const smoke = args.has("--smoke");
const transport = readTransportArg(process.argv.slice(2));
const smokeRounds: BenchmarkRoundDefinition[] = [
  {
    round: 1,
    prompt: "[RAW]\nReply with exactly MINIKANBAN.\nDo not use tools.\nDo not read files.\nDo not modify files.\nDo not explain.",
    purpose: "plan",
  },
];

const output = await runRealBenchmark({
  repeatCount: smoke ? 1 : 3,
  agent: smoke ? "build" : undefined,
  roundLimit: smoke ? 1 : undefined,
  roundTimeoutMs: smoke ? 45_000 : 180_000,
  rounds: smoke ? smokeRounds : undefined,
  transport: transport ?? "cli",
});

const resultsDir = resolve(process.cwd(), "results");
await mkdir(resultsDir, { recursive: true });
const outputPath = resolve(resultsDir, `opencode-real-benchmark-${Date.now()}.json`);
await writeFile(outputPath, stringifyBenchmarkReport(output), "utf8");

process.stdout.write(`${formatBenchmarkReport(output)}\n\nSaved JSON report to ${outputPath}\n`);

function readTransportArg(argv: string[]): RunRealBenchmarkInput["transport"] | undefined {
  const match = argv.find((arg) => arg.startsWith("--transport="));
  const value = match?.slice("--transport=".length);
  if (value === "cli" || value === "host" || value === "mixed-host") {
    return value;
  }
  return undefined;
}
