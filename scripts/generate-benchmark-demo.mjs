import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const outputPath = resolve(root, "docs/benchmark-demo/demo-data.js");
const latestWarmResultPath = await findLatestWarmResultPath();
const WARM_ROUND_TASKS = {
  1: {
    title: "Round 1 · Find the highest-value missing behaviors",
    prompt: "Resume the partially completed MiniKanban implementation. Inspect the current code and identify the highest-value missing behaviors before making targeted fixes.",
    purpose: "patch",
  },
  2: {
    title: "Round 2 · Continue targeted implementation",
    prompt: "Continue implementing the missing behaviors in the existing codebase. Use focused edits and validate progress as needed.",
    purpose: "patch",
  },
  3: {
    title: "Round 3 · Validate and finish",
    prompt: "Run the relevant checks, finish the remaining fixes, and stop when the MiniKanban fixture is complete.",
    purpose: "debug",
  },
};

const warmContinuation = await readJson(latestWarmResultPath);

const payload = {
  generatedAt: new Date().toISOString(),
  hero: buildHero(warmContinuation),
  warmProcess: buildWarmProcess(warmContinuation, latestWarmResultPath),
  sources: [
    sourceDescriptor("warm-continuation", "Latest warm benchmark", latestWarmResultPath),
  ],
};

await mkdir(resolve(root, "docs/benchmark-demo"), { recursive: true });
await writeFile(
  outputPath,
  `window.BENCHMARK_DEMO_DATA = ${JSON.stringify(payload, null, 2)};\n`,
  "utf8",
);

process.stdout.write(`Wrote benchmark demo data to ${outputPath}\n`);

async function readJson(relativePath) {
  const absolutePath = resolve(root, relativePath);
  const raw = await readFile(absolutePath, "utf8");
  return JSON.parse(raw);
}

async function findLatestWarmResultPath() {
  const resultsDir = resolve(root, "results");
  const entries = await readdir(resultsDir, { withFileTypes: true });
  const warmFiles = entries
    .filter((entry) => entry.isFile() && /^opencode-warm-benchmark-\d+\.json$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => {
      const leftStamp = Number.parseInt(left.match(/(\d+)\.json$/)?.[1] ?? "0", 10);
      const rightStamp = Number.parseInt(right.match(/(\d+)\.json$/)?.[1] ?? "0", 10);
      return rightStamp - leftStamp;
    });

  if (warmFiles.length === 0) {
    throw new Error("No warm benchmark result found under results/.");
  }

  return `results/${warmFiles[0]}`;
}

function sourceDescriptor(id, label, relativePath) {
  return { id, label, path: relativePath };
}

function buildHero(warmData) {
  const warmSummaries = mapByMode(warmData.analysis.summaries);
  const warmBaseline = warmSummaries.baseline;
  const warmPlatform = warmSummaries["platform-context"];

  return {
    warm: {
      label: "Warm continuation: tomorrow the agent resumes with context",
      partialCompletion: warmBaseline.partialCompletionAfterPass1.median,
      finalCompletion: {
        baseline: warmBaseline.finalCompletionScore.median,
        platform: warmPlatform.finalCompletionScore.median,
      },
      metrics: [
        buildMetric(
          "Pass2 input+cache tokens",
          warmBaseline.pass2InputTokensWithCache.median,
          warmPlatform.pass2InputTokensWithCache.median,
        ),
        buildMetric("Pass2 LLM calls", warmBaseline.pass2LlmCalls.median, warmPlatform.pass2LlmCalls.median),
        buildMetric("Calls before first edit", warmBaseline.pass2CallsBeforeFirstEdit.median, warmPlatform.pass2CallsBeforeFirstEdit.median),
      ],
      fairness: warmData.analysis.fairness?.[0]?.check ?? null,
    },
  };
}

function buildWarmProcess(warmData, relativePath) {
  const validRuns = (warmData.runs ?? []).filter((run) => !run.pass1TooComplete);
  const baselineSummary = warmData.analysis.summaries.find((summary) => summary.mode === "baseline");
  const platformSummary = warmData.analysis.summaries.find((summary) => summary.mode === "platform-context");
  const baselineRun = selectWarmRepresentativeRun(
    validRuns.filter((run) => run.mode === "baseline"),
    baselineSummary.pass2CallsBeforeFirstEdit.median,
  );
  const platformRun = selectWarmRepresentativeRun(
    validRuns.filter((run) => run.mode === "platform-context"),
    platformSummary.pass2CallsBeforeFirstEdit.median,
  );
  const baselineReplay = buildWarmReplay(baselineRun, "baseline");
  const platformReplay = buildWarmReplay(platformRun, "platform-context");

  return {
    path: relativePath,
    title: "Warm continuation: what happens before the first edit",
    subtitle: "Headline metrics use medians across the full warm benchmark. The replay below uses representative median runs so the process view stays honest.",
    representativeRuns: {
      baselineIteration: baselineRun.iteration,
      platformIteration: platformRun.iteration,
    },
    headline: {
      partialCompletion: baselineSummary.partialCompletionAfterPass1.median,
      finalCompletionBaseline: baselineRun.finalCompletion.total,
      finalCompletionPlatform: platformRun.finalCompletion.total,
      tokenSaved: baselineSummary.pass2InputTokensWithCache.median - platformSummary.pass2InputTokensWithCache.median,
      tokenSavedPct: reductionPct(
        baselineSummary.pass2InputTokensWithCache.median,
        platformSummary.pass2InputTokensWithCache.median,
      ),
    },
    baseline: {
      label: "Baseline",
      callsBeforeFirstEdit: baselineSummary.pass2CallsBeforeFirstEdit.median,
      repeatedReadRatio: baselineSummary.pass2RepeatedReadRatio.median,
      countsByTool: countToolCalls(baselineRun.pass2.toolCalls),
      prelude: baselineReplay.prelude,
      rounds: baselineReplay.rounds,
    },
    platform: {
      label: "Platform + Context",
      callsBeforeFirstEdit: platformSummary.pass2CallsBeforeFirstEdit.median,
      repeatedReadRatio: platformSummary.pass2RepeatedReadRatio.median,
      countsByTool: countToolCalls(platformRun.pass2.toolCalls),
      prelude: platformReplay.prelude,
      rounds: platformReplay.rounds,
    },
    delta: {
      callsBeforeFirstEditSaved: baselineSummary.pass2CallsBeforeFirstEdit.median - platformSummary.pass2CallsBeforeFirstEdit.median,
      callsBeforeFirstEditSavedPct: reductionPct(
        baselineSummary.pass2CallsBeforeFirstEdit.median,
        platformSummary.pass2CallsBeforeFirstEdit.median,
      ),
      llmCallsSaved: baselineSummary.pass2LlmCalls.median - platformSummary.pass2LlmCalls.median,
      llmCallsSavedPct: reductionPct(baselineSummary.pass2LlmCalls.median, platformSummary.pass2LlmCalls.median),
      toolCallsSaved: baselineSummary.pass2ToolCalls.median - platformSummary.pass2ToolCalls.median,
      toolCallsSavedPct: reductionPct(baselineSummary.pass2ToolCalls.median, platformSummary.pass2ToolCalls.median),
    },
    race: {
      maxStep: Math.max(
        baselineReplay.firstEditStep,
        platformReplay.firstEditStep,
      ),
      openingStep: 1,
      platformFirstEditStep: platformReplay.firstEditStep,
      baselineFirstEditStep: baselineReplay.firstEditStep,
    },
    sessionBase: buildWarmSessionBase(platformRun),
    playback: buildWarmPlayback(baselineRun, platformRun),
  };
}

function selectWarmRepresentativeRun(runs, targetStepsBeforeFirstEdit) {
  return [...runs]
    .sort((left, right) => {
      const leftDistance = Math.abs((left.pass2Trace?.stepsBeforeFirstEdit ?? Number.POSITIVE_INFINITY) - targetStepsBeforeFirstEdit);
      const rightDistance = Math.abs((right.pass2Trace?.stepsBeforeFirstEdit ?? Number.POSITIVE_INFINITY) - targetStepsBeforeFirstEdit);
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      return (left.iteration ?? 0) - (right.iteration ?? 0);
    })[0];
}

function buildWarmReplay(run, mode) {
  const trace = run.pass2Trace;
  const firstEditStep = trace?.firstEditStep ?? 1;
  const steps = (trace?.steps ?? []).map((step) => normalizeWarmStep(step, mode, trace?.seedContext));
  const preludeEvents = steps.filter((step) => step.step < firstEditStep);
  const firstEdit = steps.find((step) => step.step === firstEditStep) ?? null;
  return {
    firstEditStep,
    prelude: {
      totalEventsBeforeFirstEdit: trace?.stepsBeforeFirstEdit ?? Math.max(0, firstEditStep - 1),
      events: preludeEvents,
      firstEdit,
    },
    rounds: (trace?.rounds ?? []).map((round) => ({
      round: round.round,
      llmCalls: round.llmCalls,
      toolCalls: round.toolCalls,
      inputWithCache: round.inputTokensWithCache,
      snapshotBlocks: round.snapshotBlocks,
    })),
  };
}

function buildWarmSessionBase(run) {
  const seed = run.pass2Trace?.seedContext ?? {};
  return {
    assistantOutputPreview: seed.assistantOutputPreview ?? "",
    recentEditedFilePaths: (seed.recentEditedFilePaths ?? []).map(cleanWarmTargetPath),
    recentReadFilePaths: (seed.recentReadFilePaths ?? []).map(cleanWarmTargetPath),
    recentCommandPreviews: seed.recentCommandPreviews ?? [],
    failingTests: seed.failingTests ?? [],
    unresolvedConstraints: seed.unresolvedConstraints ?? [],
  };
}

function buildWarmPlayback(baselineRun, platformRun) {
  const rounds = [...new Set([
    ...(baselineRun.pass2Trace?.rounds ?? []).map((round) => round.round),
    ...(platformRun.pass2Trace?.rounds ?? []).map((round) => round.round),
  ])].sort((left, right) => left - right);

  return rounds.map((roundNumber) => {
    const baseline = buildWarmPlaybackLane(baselineRun, roundNumber);
    const platform = buildWarmPlaybackLane(platformRun, roundNumber);
    return {
      round: roundNumber,
      title: WARM_ROUND_TASKS[roundNumber]?.title ?? `Round ${roundNumber}`,
      prompt: WARM_ROUND_TASKS[roundNumber]?.prompt ?? "",
      purpose: WARM_ROUND_TASKS[roundNumber]?.purpose ?? "other",
      maxTurns: Math.max(baseline.turns.length, platform.turns.length, 1),
      baseline,
      platform,
    };
  });
}

function buildWarmPlaybackLane(run, roundNumber) {
  const roundTrace = run.pass2Trace?.rounds?.find((round) => round.round === roundNumber);
  const turns = (roundTrace?.conversationTurns ?? []).map((turn) => ({
    turn: turn.turn,
    goal: cleanWarmGoal(turn.goal),
    inputTokens: turn.inputTokens,
    cacheReadInputTokens: turn.cacheReadInputTokens ?? 0,
    inputTokensWithCache: turn.inputTokensWithCache,
    outputTokens: turn.outputTokens,
    assistantMessagePreview: turn.assistantMessagePreview,
    toolActions: (turn.toolActions ?? []).map((action) => ({
      ...action,
      targetPath: action.targetPath ? cleanWarmTargetPath(action.targetPath) : undefined,
      label: normalizeWarmActionLabel(action),
      guidanceTag: displayWarmGuidanceTag(
        action,
        action.targetPath ? cleanWarmTargetPath(action.targetPath) : undefined,
        run.pass2Trace?.seedContext,
      ),
      detail: action.targetPath ? cleanWarmTargetPath(action.targetPath) : action.detail,
    })),
  }));
  return {
    iteration: run.iteration,
    llmCalls: roundTrace?.llmCalls ?? 0,
    llmInputTokens: roundTrace?.inputTokens ?? 0,
    llmInputTokensWithCache: roundTrace?.inputTokensWithCache ?? 0,
    llmOutputTokens: roundTrace?.outputTokens ?? 0,
    toolCalls: roundTrace?.toolCalls ?? 0,
    readCalls: sum(turns.map((turn) => turn.toolActions.filter((action) => action.toolName === "read").length)),
    bashCalls: sum(turns.map((turn) => turn.toolActions.filter((action) => action.toolName === "bash").length)),
    editCalls: sum(turns.map((turn) => turn.toolActions.filter((action) => ["edit", "write", "write_file"].includes(action.toolName)).length)),
    snapshotTokenEstimate: roundTrace?.snapshotTokenEstimate ?? 0,
    promptTextLength: roundTrace?.promptTextLength ?? 0,
    renderedPromptPreview: roundTrace?.renderedPromptPreview ?? "",
    sourceTypeCounts: roundTrace?.sourceTypeCounts ?? {},
    retentionCounts: roundTrace?.retentionCounts ?? {},
    snapshotBlocks: (roundTrace?.snapshotBlocks ?? []).slice(0, 6),
    turns,
  };
}

function normalizeWarmStep(step, mode, seedContext) {
  const targetPath = typeof step.targetPath === "string" && step.targetPath.length > 0
    ? cleanWarmTargetPath(step.targetPath)
    : undefined;
  const guidanceTag = mode === "platform-context"
    ? displayWarmGuidanceTag(step, targetPath, seedContext)
    : undefined;
  const label = targetPath && step.label.startsWith("Read ")
    ? `Read ${targetPath}`
    : targetPath && step.label.startsWith("Edit ")
      ? `Edit ${targetPath}`
      : step.label;
  return {
    ...step,
    label,
    guidanceTag,
    detail: targetPath ?? step.detail,
  };
}

function cleanWarmTargetPath(targetPath) {
  const normalized = targetPath.replaceAll("\\", "/");
  const repoMarker = "/minikanban";
  const markerIndex = normalized.toLowerCase().lastIndexOf(repoMarker);
  if (markerIndex >= 0) {
    const suffix = normalized.slice(markerIndex + repoMarker.length);
    return suffix.length > 0 ? suffix : "/";
  }
  return normalized;
}

function cleanWarmGoal(goal) {
  if (typeof goal !== "string" || goal.length === 0) {
    return "Advance the round";
  }
  if (goal.includes("ctx-benchmark-fixture") && goal.toLowerCase().includes("minikanban")) {
    if (goal.startsWith("Read ")) {
      return "Inspect workspace root";
    }
    if (goal.startsWith("Patch ")) {
      return "Patch workspace files";
    }
  }
  if (goal.startsWith("Read ")) {
    const cleaned = cleanWarmTargetPath(goal.slice("Read ".length));
    return cleaned === "/" ? "Inspect workspace root" : `Read ${cleaned}`;
  }
  if (goal.startsWith("Patch ")) {
    const cleaned = cleanWarmTargetPath(goal.slice("Patch ".length));
    return cleaned === "/" ? "Patch workspace root" : `Patch ${cleaned}`;
  }
  if (goal.startsWith("Reopen last edited file ")) {
    const cleaned = cleanWarmTargetPath(goal.slice("Reopen last edited file ".length));
    return cleaned === "/" ? "Reopen last edited workspace area" : `Reopen last edited file ${cleaned}`;
  }
  if (goal.startsWith("Inspect failing test ")) {
    const cleaned = cleanWarmTargetPath(goal.slice("Inspect failing test ".length));
    return `Inspect failing test ${cleaned}`;
  }
  return goal;
}

function normalizeWarmActionLabel(action) {
  const cleanedTarget = action.targetPath ? cleanWarmTargetPath(action.targetPath) : undefined;
  if (action.toolName === "read") {
    if (action.label.includes("ctx-benchmark-fixture") && action.label.toLowerCase().includes("minikanban")) {
      return "Read /";
    }
    return `Read ${cleanedTarget ?? action.label.replace(/^Read\s+/, "")}`;
  }
  if (["edit", "write", "write_file"].includes(action.toolName)) {
    return `Edit ${cleanedTarget ?? action.label.replace(/^Edit\s+/, "")}`;
  }
  return action.label;
}

function displayWarmGuidanceTag(step, targetPath, seedContext) {
  if (step.guidanceTag === "task-brief") {
    return "task brief";
  }
  if (step.guidanceTag === "from-last-run") {
    return "from last run";
  }
  if (step.guidanceTag === "recent-read") {
    return "recent read";
  }
  if (step.guidanceTag === "seed-command") {
    return "seed command";
  }
  if (step.guidanceTag === "failing-test") {
    return "failing test";
  }
  if (
    targetPath &&
    targetPath.startsWith("/tests/") &&
    seedContext?.failingTests?.some((testId) => testId.startsWith(`tests${targetPath.slice("/tests".length)}`))
  ) {
    return "failing test";
  }
  return undefined;
}

function extractPath(inputSignature) {
  const parsed = parseJson(inputSignature);
  const rawPath = firstString(parsed.filePath, parsed.path, parsed.file, parsed.pathname, "");
  if (!rawPath) {
    return "target";
  }
  const normalized = String(rawPath).replaceAll("\\", "/");
  const marker = "/minikanban/";
  if (normalized.endsWith("/minikanban")) {
    return "/";
  }
  if (normalized.includes(marker)) {
    return normalized.slice(normalized.indexOf(marker) + marker.length - 1);
  }
  return normalized;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function countToolCalls(toolCalls) {
  const counts = {};
  for (const call of toolCalls) {
    counts[call.toolName] = (counts[call.toolName] ?? 0) + 1;
  }
  return counts;
}

function buildRoundSequence(run, round) {
  const events = [
    ...run.llmCalls
      .filter((call) => call.round === round)
      .map((call) => ({
        kind: "llm",
        sortKey: Date.parse(call.timestamp),
        label: `${call.purpose.toUpperCase()} call`,
        detail: `${call.inputTokens.toLocaleString()} input · ${call.outputTokens.toLocaleString()} output`,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        toolName: undefined,
      })),
    ...run.toolCalls
      .filter((call) => call.round === round)
      .map((call) => ({
        kind: "tool",
        sortKey: Date.parse(call.timestamp),
        label: shortRealToolLabel(call.toolName),
        detail: `tool=${call.toolName}`,
        inputTokens: 0,
        outputTokens: 0,
        toolName: call.toolName,
      })),
  ].sort((left, right) => left.sortKey - right.sortKey);

  const cumulative = {
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    readCalls: 0,
    bashCalls: 0,
  };

  return events.map((event, index) => {
    if (event.kind === "llm") {
      cumulative.llmCalls += 1;
      cumulative.inputTokens += event.inputTokens ?? 0;
      cumulative.outputTokens += event.outputTokens ?? 0;
    } else {
      cumulative.toolCalls += 1;
      if (event.toolName === "read") {
        cumulative.readCalls += 1;
      }
      if (event.toolName === "bash") {
        cumulative.bashCalls += 1;
      }
    }

    return {
      ...event,
      step: index + 1,
      cumulative: { ...cumulative },
    };
  });
}

function shortRealToolLabel(toolName) {
  switch (toolName) {
    case "read":
      return "Read probe";
    case "bash":
      return "Run bash";
    case "invalid":
      return "Invalid tool";
    default:
      return toolName;
  }
}

function aggregateRoundCalls(llmCalls, round) {
  const calls = llmCalls.filter((call) => call.round === round);
  return {
    calls: calls.length,
    inputTokens: calls.reduce((total, call) => total + call.inputTokens, 0),
    outputTokens: calls.reduce((total, call) => total + call.outputTokens, 0),
  };
}

function shapeSnapshot(diagnostic) {
  return {
    tokenEstimate: diagnostic.snapshotTokenEstimate,
    includedBlockCount: diagnostic.includedBlockCount,
    excludedBlockCount: diagnostic.excludedBlockCount,
    promptTextLength: diagnostic.promptTextLength,
    sourceTypeCounts: diagnostic.sourceTypeCounts,
    retentionCounts: diagnostic.retentionCounts,
  };
}

function roundInsight(baselineDiagnostic, platformDiagnostic, baselineAggregate, platformAggregate) {
  if ((baselineDiagnostic.sourceTypeCounts["run-summary"] ?? 0) > (platformDiagnostic.sourceTypeCounts["run-summary"] ?? 0)) {
    return "The platform suppresses early run summaries here, so the model stays on the task brief instead of spiraling into history-driven replanning.";
  }
  if (platformAggregate.inputTokens < baselineAggregate.inputTokens / 4) {
    return "Once the strategy is aligned, the platform keeps the same task moving with a dramatically smaller prompt footprint and fewer follow-up turns.";
  }
  return "This round shows the platform keeping context compact while preserving the same completion target.";
}

function buildMetric(label, baseline, platform) {
  return {
    label,
    baseline,
    platform,
    saved: baseline - platform,
    savedPct: reductionPct(baseline, platform),
  };
}

function reductionPct(baseline, platform) {
  if (!baseline) {
    return 0;
  }
  return Number((((baseline - platform) / baseline) * 100).toFixed(1));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function mapByMode(items) {
  return Object.fromEntries((items ?? []).map((item) => [item.mode, item]));
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
