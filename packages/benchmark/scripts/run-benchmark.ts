import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatBenchmarkReport, runBenchmark, stringifyBenchmarkReport } from "../src/index.ts";

const args = new Set(process.argv.slice(2));
const smoke = args.has("--smoke");
const includeAuxiliary = args.has("--with-aux");

const output = await runBenchmark({
  repeatCount: smoke ? 1 : 5,
  includeAuxiliaryMode: includeAuxiliary,
});

const resultsDir = resolve(process.cwd(), "results");
await mkdir(resultsDir, { recursive: true });
const outputPath = resolve(resultsDir, `benchmark-${Date.now()}.json`);
await writeFile(outputPath, stringifyBenchmarkReport(output), "utf8");

process.stdout.write(`${formatBenchmarkReport(output)}\n\nSaved JSON report to ${outputPath}\n`);
