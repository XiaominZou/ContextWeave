import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatBenchmarkReport, stringifyBenchmarkReport } from "../src/index.ts";
import { runRealOpenCodeProbe } from "../src/runner/opencode-real-probe";

const args = new Set(process.argv.slice(2));
const smoke = args.has("--smoke");

const output = await runRealOpenCodeProbe({
  repeatCount: smoke ? 1 : 3,
});

const resultsDir = resolve(process.cwd(), "results");
await mkdir(resultsDir, { recursive: true });
const outputPath = resolve(resultsDir, `opencode-real-probe-${Date.now()}.json`);
await writeFile(outputPath, stringifyBenchmarkReport(output), "utf8");

process.stdout.write(`${formatBenchmarkReport(output)}\n\nSaved JSON report to ${outputPath}\n`);
