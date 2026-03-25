import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { CompletionScore } from "./schema";

export interface ScoreCompletionInput {
  publicTestsPassed: number;
  publicTestsTotal: number;
  hiddenTestsPassed: number;
  hiddenTestsTotal: number;
  codeQualityPassed: boolean;
  deliveryPassed: boolean;
  processPassed: boolean;
}

export function scoreCompletion(input: ScoreCompletionInput): CompletionScore {
  const publicPoints = scaledPoints(input.publicTestsPassed, input.publicTestsTotal, 35);
  const hiddenPoints = scaledPoints(input.hiddenTestsPassed, input.hiddenTestsTotal, 25);
  const codeQualityPoints = input.codeQualityPassed ? 10 : 0;
  const deliveryPoints = input.deliveryPassed ? 15 : 0;
  const processPoints = input.processPassed ? 15 : 0;

  return {
    total: publicPoints + hiddenPoints + codeQualityPoints + deliveryPoints + processPoints,
    publicTestsPassed: input.publicTestsPassed,
    publicTestsTotal: input.publicTestsTotal,
    hiddenTestsPassed: input.hiddenTestsPassed,
    hiddenTestsTotal: input.hiddenTestsTotal,
    codeQualityPoints,
    deliveryPoints,
    processPoints,
  };
}

export async function scoreCompletionForFixture(input?: {
  fixtureDir?: string;
  pythonCommand?: string;
}): Promise<CompletionScore> {
  const fixtureDir = resolve(input?.fixtureDir ?? "packages/benchmark/fixtures/minikanban");
  const pythonCommand = input?.pythonCommand ?? "python";

  const publicResult = await runPytest({
    pythonCommand,
    fixtureDir,
    args: ["-m", "pytest", "tests/test_boards.py", "tests/test_tasks.py", "tests/test_stats.py", "-q"],
  });
  const hiddenResult = await runPytest({
    pythonCommand,
    fixtureDir,
    args: ["-m", "pytest", "tests/test_hidden.py", "-q"],
  });

  const readmePath = resolve(fixtureDir, "README.md");
  const readmeText = await readFile(readmePath, "utf8");
  const deliveryPassed = readmeText.includes("uvicorn") && readmeText.includes("pytest");

  const processPassed = true;
  const codeQualityPassed = publicResult.exitCode === 0 && hiddenResult.exitCode === 0;

  return scoreCompletion({
    publicTestsPassed: publicResult.passed,
    publicTestsTotal: publicResult.total,
    hiddenTestsPassed: hiddenResult.passed,
    hiddenTestsTotal: hiddenResult.total,
    codeQualityPassed,
    deliveryPassed,
    processPassed,
  });
}

function scaledPoints(passed: number, total: number, maxPoints: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((passed / total) * maxPoints);
}

async function runPytest(input: {
  pythonCommand: string;
  fixtureDir: string;
  args: string[];
}): Promise<{ passed: number; total: number; exitCode: number }> {
  const result = await spawnAndCollect(input.pythonCommand, input.args, input.fixtureDir);
  const passed = extractPassedCount(result.stdout);
  const failed = extractFailedCount(result.stdout);
  return {
    passed,
    total: passed + failed,
    exitCode: result.exitCode,
  };
}

async function spawnAndCollect(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  await access(cwd);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
      });
    });
  });
}

function extractPassedCount(output: string): number {
  const matches = output.match(/(\d+)\s+passed/g);
  if (!matches || matches.length === 0) {
    return 0;
  }
  return matches.reduce((total, match) => total + Number(match.match(/\d+/)?.[0] ?? 0), 0);
}

function extractFailedCount(output: string): number {
  const matches = output.match(/(\d+)\s+failed/g);
  if (!matches || matches.length === 0) {
    return 0;
  }
  return matches.reduce((total, match) => total + Number(match.match(/\d+/)?.[0] ?? 0), 0);
}
