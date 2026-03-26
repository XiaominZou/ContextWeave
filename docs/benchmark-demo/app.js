(function renderBenchmarkDemo() {
  const data = window.BENCHMARK_DEMO_DATA;
  if (!data) {
    return;
  }

  renderHeroStatus(data.warmProcess, data.sources);
  renderWarmProcess(data.warmProcess);
})();

function renderHeroStatus(warmProcess, sources) {
  const container = byId("hero-status");
  container.innerHTML = "";
  const warmSource = sources.find((source) => source.id === "warm-continuation");

  const card = div("status-card alert");
  card.append(
    badge("Latest warm benchmark"),
    h3(`Representative replay: baseline ${warmProcess.representativeRuns.baselineIteration} vs platform ${warmProcess.representativeRuns.platformIteration}`),
    p(
      `This page is locked to the newest real warm benchmark result. Headline numbers use medians across the full run set, and the replay uses representative median iterations.`,
      "muted",
    ),
    chipPath(warmSource?.path ?? warmProcess.path),
  );
  container.append(card);
}

function renderHeadline(hero) {
  const container = byId("headline-grid");
  container.innerHTML = "";
  container.append(buildHeadlineCard(hero.warm, "cool", "warm"));
}

function buildHeadlineCard(section, tone, type) {
  const card = div(`headline-card ${tone}`);
  const header = type === "real"
    ? `Completion ${section.completion.baseline} vs ${section.completion.platform}`
    : `Resume from ${section.partialCompletion} and still land at ${section.finalCompletion.platform}`;

  card.append(
    badge(type === "real" ? "Real benchmark" : "Warm continuation"),
    h3(section.label),
    p(header, "muted"),
  );

  if (section.fairness) {
    card.append(
      p(
        `Fairness check: ${section.fairness.valid ? "valid" : "needs review"} · hidden delta ${section.fairness.hiddenTestPassDelta} · score delta ${section.fairness.completionScoreDelta}`,
        "muted",
      ),
    );
  }

  const grid = div("metric-row");
  for (const metric of section.metrics) {
    const box = div("metric-box");
    box.append(
      label(metric.label),
      strong(`${metric.savedPct}%`),
      p(
        `${formatNumber(metric.baseline)} -> ${formatNumber(metric.platform)} · saved ${formatNumber(metric.saved)}`,
        "comparison",
      ),
    );
    grid.append(box);
  }

  card.append(grid);
  return card;
}

function renderRealProcess(realProcess) {
  const controls = byId("round-controls");
  const stage = byId("round-stage");
  const sequence = byId("round-sequence");
  const bars = byId("round-bars");
  let activeRound = realProcess.rounds[0]?.round ?? 1;

  controls.innerHTML = "";
  const buttons = realProcess.rounds.map((round) => {
    const button = document.createElement("button");
    button.className = "round-button";
    button.type = "button";
    button.textContent = `Round ${round.round} · ${round.purpose}`;
    button.addEventListener("click", () => {
      activeRound = round.round;
      syncButtons();
      renderStage();
    });
    controls.append(button);
    return { round: round.round, button };
  });

  renderBars();
  syncButtons();
  renderStage();

  function syncButtons() {
    for (const item of buttons) {
      item.button.classList.toggle("active", item.round === activeRound);
    }
  }

  function renderStage() {
    stage.innerHTML = "";
    sequence.innerHTML = "";
    const round = realProcess.rounds.find((item) => item.round === activeRound);
    if (!round) {
      return;
    }

    stage.append(
      buildRoundPanel("Baseline", "baseline", round.baseline),
      buildDeltaPanel(round),
      buildRoundPanel("Platform + Context", "platform", round.platform),
    );
    sequence.append(buildRoundSequencePanel(round));
  }

  function renderBars() {
    bars.innerHTML = "";
    bars.append(
      buildBarPanel("LLM calls by round", realProcess.rounds, (round) => round.baseline.calls, (round) => round.platform.calls),
      buildBarPanel("Input tokens by round", realProcess.rounds, (round) => round.baseline.inputTokens, (round) => round.platform.inputTokens),
    );
  }
}

function buildRoundSequencePanel(round) {
  const panel = div("bar-panel round-sequence-panel");
  panel.append(
    badge(`Round ${round.round} sequence`),
    h3("What actually happened inside this round"),
    p("Real benchmark does not preserve full file-level detail here, but it does preserve the event order. That is enough to show one lane spiraling into more turns while the other stays short.", "muted"),
  );

  const compare = div("round-sequence-compare");
  compare.append(
    buildRoundEventLane("Baseline", round.baseline.events),
    buildRoundEventLane("Platform + Context", round.platform.events),
  );
  panel.append(compare);
  return panel;
}

function buildRoundEventLane(title, events) {
  const lane = div("compare-card");
  lane.append(
    badge(title),
    h3(`${formatNumber(events.length)} events in this round`),
  );

  const finalCumulative = events.at(-1)?.cumulative ?? { llmCalls: 0, inputTokens: 0, toolCalls: 0, readCalls: 0, bashCalls: 0 };
  const metrics = div("compare-metrics");
  metrics.append(
    toolMetric("LLM calls", formatNumber(finalCumulative.llmCalls)),
    toolMetric("Input", formatNumber(finalCumulative.inputTokens)),
    toolMetric("Tool calls", formatNumber(finalCumulative.toolCalls)),
    toolMetric("Reads", formatNumber(finalCumulative.readCalls)),
    toolMetric("Bash", formatNumber(finalCumulative.bashCalls)),
    toolMetric("Output", formatNumber(events.at(-1)?.cumulative?.outputTokens ?? 0)),
  );
  lane.append(metrics);

  const feed = div("event-feed");
  for (const event of events.slice(0, 10)) {
    const item = div("event-item");
    item.append(
      div("event-head"),
    );
    item.firstChild.append(
      tagChip(`${event.kind.toUpperCase()} ${event.step}`),
      miniText(event.detail),
    );
    item.append(divText(event.label, "event-title"));
    feed.append(item);
  }
  if (events.length > 10) {
    feed.append(divText(`... ${events.length - 10} more events in this round`, "footnote"));
  }
  lane.append(feed);
  return lane;
}

function buildRoundPanel(title, variant, data) {
  const panel = div(`round-panel ${variant}`);
  panel.append(
    badge(title),
    h3(`${formatNumber(data.calls)} LLM calls`),
  );

  const tiny = div("tiny-grid");
  tiny.append(
    tinyStat("Input", formatNumber(data.inputTokens)),
    tinyStat("Output", formatNumber(data.outputTokens)),
    tinyStat("Blocks", formatNumber(data.snapshot.includedBlockCount)),
  );
  panel.append(tiny);

  const snapshot = div("snapshot-grid");
  snapshot.append(
    snapshotItem("Snapshot tokens", formatNumber(data.snapshot.tokenEstimate)),
    snapshotItem("Prompt length", formatNumber(data.snapshot.promptTextLength)),
    snapshotItem("Included blocks", formatNumber(data.snapshot.includedBlockCount)),
    snapshotItem("Excluded blocks", formatNumber(data.snapshot.excludedBlockCount)),
  );
  panel.append(snapshot);

  panel.append(
    chipRow("Source blocks", data.snapshot.sourceTypeCounts),
    chipRow("Retention", data.snapshot.retentionCounts),
  );
  return panel;
}

function buildDeltaPanel(round) {
  const panel = div("delta-panel");
  panel.append(
    badge(`Round ${round.round}`),
    h3(`${round.purpose.toUpperCase()} is where the control plane shows up`),
  );

  const big = document.createElement("div");
  big.className = "hero-number";
  big.textContent = "0%";
  panel.append(big);

  panel.append(
    p(`Input tokens fall from ${formatNumber(round.baseline.inputTokens)} to ${formatNumber(round.platform.inputTokens)}.`, "muted"),
    p(`LLM calls fall from ${formatNumber(round.baseline.calls)} to ${formatNumber(round.platform.calls)}.`, "muted"),
  );

  const insight = div("insight");
  insight.textContent = round.insight;
  panel.append(insight);

  requestAnimationFrame(() => animatePercent(big, round.delta.inputSavedPct));
  return panel;
}

function buildBarPanel(title, rounds, baselineSelector, platformSelector) {
  const panel = div("bar-panel");
  panel.append(h3(title));
  const chart = div("bar-chart");
  const maxValue = Math.max(
    ...rounds.flatMap((round) => [baselineSelector(round), platformSelector(round)]),
    1,
  );

  for (const round of rounds) {
    chart.append(
      barRow(`R${round.round} B`, baselineSelector(round), maxValue, "baseline"),
      barRow(`R${round.round} P`, platformSelector(round), maxValue, "platform"),
    );
  }
  panel.append(chart);
  return panel;
}

function barRow(name, value, maxValue, variant) {
  const row = div("bar-row");
  const nameEl = label(name);
  const track = div("bar-track");
  const fill = div(`bar-fill ${variant}`);
  fill.style.width = `${(value / maxValue) * 100}%`;
  track.append(fill);
  const valueEl = div("value");
  valueEl.textContent = formatNumber(value);
  row.append(nameEl, track, valueEl);
  return row;
}

function renderWarmProcess(warmProcess) {
  const summary = byId("warm-summary");
  const missions = byId("warm-missions");
  summary.innerHTML = "";
  missions.innerHTML = "";

  summary.append(buildCompactSummaryStrip(warmProcess));

  missions.append(buildWarmPlaybackCard(warmProcess));
}

function buildCompactSummaryStrip(warmProcess) {
  const card = div("warm-card compact-summary");
  card.append(
    badge("Result Strip"),
    h3("Same continuation, smaller working set"),
    p(
      `OpenCode can already continue a session. The platform advantage here is pruning that long session into a smaller working set, so the next turns cost less while still finishing at 100.`,
      "muted",
    ),
  );

  const grid = div("metric-row");
  for (const item of [
    ["Pass2 input+cache", `${warmProcess.headline.tokenSavedPct}% lower`, `${formatNumber(warmProcess.headline.tokenSaved)} tokens saved`],
    ["LLM calls", `${warmProcess.delta.llmCallsSavedPct}% lower`, `${formatNumber(warmProcess.delta.llmCallsSaved)} fewer sends`],
    ["Before first edit", `${warmProcess.delta.callsBeforeFirstEditSavedPct}% faster`, `${formatNumber(warmProcess.delta.callsBeforeFirstEditSaved)} fewer steps`],
  ]) {
    const box = div("metric-box");
    box.append(label(item[0]), strong(item[1]), p(item[2], "comparison"));
    grid.append(box);
  }
  card.append(grid);
  return card;
}

function buildWarmPlaybackCard(warmProcess) {
  const card = div("timeline-card mission-card playback-card");
  card.append(
    badge("Why Tokens Drop"),
    h3("Follow one real continuation turn from session memory to token cost"),
    p("Start at the bottom layer, then move upward. This stack replays one real turn from the warm benchmark using recorded session state, loaded context, LLM sends, tool calls, and returned content.", "muted"),
  );

  const controls = div("round-controls");
  const playbackControls = div("race-controls");
  const body = div("mission-body");
  let activeRound = warmProcess.playback[0]?.round ?? 1;
  let activeTurn = 1;
  let playing = false;
  let timer = null;

  const buttons = warmProcess.playback.map((mission) => {
    const button = makeButton(`Round ${mission.round}`);
    button.addEventListener("click", () => {
      activeRound = mission.round;
      activeTurn = 1;
      playing = false;
      syncButtons();
      render();
      syncTimer();
    });
    controls.append(button);
    return { round: mission.round, button };
  });

  const playButton = makeButton("Play turns");
  const replayButton = makeButton("Replay round");
  const prevButton = makeButton("Previous turn");
  const nextButton = makeButton("Next turn");
  playbackControls.append(playButton, replayButton, prevButton, nextButton);

  playButton.addEventListener("click", () => {
    playing = !playing;
    playButton.textContent = playing ? "Pause" : "Play turns";
    syncTimer();
  });

  replayButton.addEventListener("click", () => {
    activeTurn = 1;
    playing = true;
    playButton.textContent = "Pause";
    render();
    syncTimer();
  });

  prevButton.addEventListener("click", () => {
    activeTurn = Math.max(1, activeTurn - 1);
    playing = false;
    playButton.textContent = "Play turns";
    render();
    syncTimer();
  });

  nextButton.addEventListener("click", () => {
    const mission = warmProcess.playback.find((item) => item.round === activeRound);
    activeTurn = Math.min(mission?.maxTurns ?? 1, activeTurn + 1);
    playing = false;
    playButton.textContent = "Play turns";
    render();
    syncTimer();
  });

  card.append(controls, playbackControls, body);
  syncButtons();
  render();
  return card;

  function syncButtons() {
    for (const item of buttons) {
      item.button.classList.toggle("active", item.round === activeRound);
    }
  }

  function render() {
    body.innerHTML = "";
    const mission = warmProcess.playback.find((item) => item.round === activeRound);
    if (!mission) {
      return;
    }
    activeTurn = Math.max(1, Math.min(activeTurn, mission.maxTurns));

    const header = div("mission-header");
    header.append(
      buildWarmSummaryCard(
        mission.title,
        mission.prompt,
        [
          ["Purpose", mission.purpose],
          ["Turn", `${activeTurn} / ${mission.maxTurns}`],
          ["Baseline replay", `iteration ${mission.baseline.iteration}`],
          ["Platform replay", `iteration ${mission.platform.iteration}`],
        ],
      ),
    );

    body.append(
      header,
      buildPlaybackGuide(mission, activeTurn),
      buildPlaybackFlow(warmProcess.sessionBase, mission, activeTurn, handleTurnSelect),
    );
  }

  function syncTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!playing) {
      return;
    }
    timer = setInterval(() => {
      const mission = warmProcess.playback.find((item) => item.round === activeRound);
      const maxTurns = mission?.maxTurns ?? 1;
      if (activeTurn >= maxTurns) {
        playing = false;
        playButton.textContent = "Play turns";
        syncTimer();
        return;
      }
      activeTurn += 1;
      render();
    }, 1400);
  }

  function handleTurnSelect(turn) {
    activeTurn = Math.max(1, turn);
    playing = false;
    playButton.textContent = "Play turns";
    render();
    syncTimer();
  }
}

function buildPlaybackGuide(mission, activeTurn) {
  const card = div("playback-guide");
  card.append(
    badge("How To Read"),
    h3(`Start at Layer 1, then move upward to Layer 5 · Turn ${activeTurn}`),
    p("Both lanes are continuing the same task. The difference is Layer 3: baseline reconstructs relevance by rereading the session, while the platform prunes the session graph into a tighter working set before the next send.", "muted"),
  );
  return card;
}

function buildPlaybackFlow(sessionBase, mission, activeTurn, onSelectTurn) {
  const stack = div("playback-stack-flow");
  stack.append(
    buildPlaybackStatsLayer(mission, activeTurn),
    buildPlaybackInteractionLayer(mission, activeTurn, onSelectTurn),
    buildPlaybackLoadLayer(mission),
    buildPlaybackRoundLayer(mission, activeTurn),
    buildPlaybackSessionLayer(sessionBase),
  );
  return stack;
}

function buildSessionBasePanel(sessionBase) {
  const panel = div("session-base");
  panel.append(
    divText("What The Platform Already Knows", "event-title"),
    divText("These are the continuation clues carried over from the previous run before the new round begins.", "event-detail"),
  );
  const grid = div("playback-stack-grid");
  grid.append(
    buildPlaybackStack("Recent edits", sessionBase.recentEditedFilePaths),
    buildPlaybackStack("Failing tests", sessionBase.failingTests),
    buildPlaybackStack("Constraints", sessionBase.unresolvedConstraints),
  );
  panel.append(grid);
  if (sessionBase.assistantOutputPreview) {
    panel.append(divText(sessionBase.assistantOutputPreview, "footnote"));
  }
  return panel;
}

function buildPlaybackStatsLayer(mission, activeTurn) {
  const baselineTurn = mission.baseline.turns[activeTurn - 1];
  const platformTurn = mission.platform.turns[activeTurn - 1];
  const card = div("playback-layer playback-layer-top");
  card.append(
    badge("Layer 5 · Cost Summary"),
    h3("What this turn cost at the top of the stack"),
  );

  const metrics = div("compare-metrics");
  metrics.append(
    toolMetric("Turn input", comparePair(baselineTurn?.inputTokens ?? 0, platformTurn?.inputTokens ?? 0)),
    toolMetric("Turn input+cache", comparePair(baselineTurn?.inputTokensWithCache ?? 0, platformTurn?.inputTokensWithCache ?? 0)),
    toolMetric("Turn output", comparePair(baselineTurn?.outputTokens ?? 0, platformTurn?.outputTokens ?? 0)),
    toolMetric("Tools after send", comparePair(baselineTurn?.toolActions?.length ?? 0, platformTurn?.toolActions?.length ?? 0)),
    toolMetric("Round input+cache", comparePair(mission.baseline.llmInputTokensWithCache, mission.platform.llmInputTokensWithCache)),
    toolMetric("Round tools", comparePair(mission.baseline.toolCalls, mission.platform.toolCalls)),
  );
  card.append(metrics);
  card.append(
    p("By the time you reach this layer, you should already know why the platform side is cheaper: it started from a tighter working set and triggered a shorter tool chain.", "muted"),
  );
  return card;
}

function buildPlaybackInteractionLayer(mission, activeTurn, onSelectTurn) {
  const layer = div("playback-layer");
  layer.append(
    badge("Layer 4 · Assistant And Tools"),
    h3("What the assistant said, what tools it called, and what came back"),
  );
  const compare = div("playback-current-grid");
  compare.append(
    buildPlaybackLane("Baseline · re-figure it out", mission.baseline, activeTurn, onSelectTurn),
    buildPlaybackLane("Platform · start from known context", mission.platform, activeTurn, onSelectTurn),
  );
  layer.append(compare);
  return layer;
}

function buildPlaybackLane(title, lane, activeTurn, onSelectTurn) {
  const currentTurn = lane.turns[activeTurn - 1] ?? null;
  const card = div("compare-card playback-lane");
  card.append(
    badge(title),
    h3(currentTurn ? `Turn ${currentTurn.turn}: ${currentTurn.goal}` : "No turn at this position"),
  );
  if (currentTurn) {
    card.append(
      p(describeTurnCostStory(currentTurn), "muted"),
    );
  }

  const metrics = div("compare-metrics");
  metrics.append(
    toolMetric("Round sends", formatNumber(lane.llmCalls)),
    toolMetric("Round tools", formatNumber(lane.toolCalls)),
    toolMetric("Turn input", formatNumber(currentTurn?.inputTokens ?? 0)),
    toolMetric("Turn input+cache", formatNumber(currentTurn?.inputTokensWithCache ?? 0)),
    toolMetric("Turn output", formatNumber(currentTurn?.outputTokens ?? 0)),
    toolMetric("Tools now", formatNumber(currentTurn?.toolActions?.length ?? 0)),
  );
  card.append(metrics);

  const narrative = div("playback-lane-body");
  narrative.append(
    buildPlaybackStack(
      "Assistant response for this send",
      currentTurn
        ? [currentTurn.assistantMessagePreview || "No assistant text preview for this turn."]
        : ["No turn at this index for this lane."],
    ),
  );

  const toolTrail = div("event-feed");
  toolTrail.append(divText("What the agent did next", "event-title"));
  for (const action of (currentTurn?.toolActions ?? []).slice(0, 6)) {
    const item = div("event-item");
    item.append(
      divText(action.label, "event-title"),
      divText(`Operation: ${describeActionOperation(action)}`, "event-detail"),
    );
    const why = describeActionWhy(action);
    if (why) {
      item.append(divText(`Why: ${why}`, "footnote"));
    }
    if (action.guidanceTag) {
      item.append(tagChip(action.guidanceTag));
    }
    item.append(divText(`Result: ${describeActionResult(action)}`, "footnote"));
    toolTrail.append(item);
  }
  if (!currentTurn?.toolActions?.length) {
    toolTrail.append(divText("No tool call followed this send.", "footnote"));
  }
  narrative.append(toolTrail);
  card.append(narrative);

  const turnRail = div("turn-rail");
  for (const turn of lane.turns) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "turn-chip";
    chip.classList.toggle("active", turn.turn === activeTurn);
    chip.textContent = `${turn.turn}`;
    chip.addEventListener("click", () => onSelectTurn?.(turn.turn));
    turnRail.append(chip);
  }
  card.append(turnRail);
  return card;
}

function buildPlaybackLoadLayer(mission) {
  const layer = div("playback-layer");
  layer.append(
    badge("Layer 3 · Session Graph Pruning"),
    h3("Where the platform actually saves tokens"),
  );
  const compare = div("playback-context-grid");
  compare.append(
    buildPlaybackContextPanel("Baseline · native continuation path", mission.baseline, "baseline"),
    buildPlaybackContextPanel("Platform · pruned working set", mission.platform, "platform"),
  );
  layer.append(compare);
  return layer;
}

function buildPlaybackContextPanel(title, lane, mode) {
  const panel = div("session-base");
  panel.append(
    divText(title, "event-title"),
    divText(
      mode === "platform"
        ? `The platform promotes a compact working set before the send: snapshot ${formatNumber(lane.snapshotTokenEstimate)} tokens · prompt length ${formatNumber(lane.promptTextLength)}`
        : "Baseline can continue too, but it reconstructs relevance by rereading files and tests during the next turns.",
      "event-detail",
    ),
  );

  if (mode === "platform") {
    panel.append(
      buildPlaybackStack(
        "What got promoted into context",
        lane.snapshotBlocks.slice(0, 5).map((block) => `${block.sourceType} · ${block.retentionAction} · ${block.title}`),
      ),
      buildPlaybackStack("What the compact prompt looked like", [lane.renderedPromptPreview || "No snapshot preview recorded."]),
    );
    return panel;
  }

  const reconstructionActions = lane.turns
    .slice(0, 3)
    .flatMap((turn) => turn.toolActions.slice(0, 4).map((action) => `${action.label}`));
  panel.append(
    buildPlaybackStack(
      "What baseline had to reread",
      reconstructionActions.length > 0 ? reconstructionActions : ["No reconstruction steps recorded."],
    ),
    buildPlaybackStack(
      "Why this grows token cost",
      [
        "More exploration turns means more native history carried into later sends.",
        "The agent re-derives relevance from the long session instead of starting from a compact working set.",
      ],
    ),
  );
  return panel;
}

function buildPlaybackRoundLayer(mission, activeTurn) {
  const layer = div("playback-layer");
  layer.append(
    badge("Layer 2 · User Task"),
    h3("What the user is asking the agent to do in this round"),
  );
  const strip = div("playback-round-strip");
  strip.append(
    toolMetric("Round", `${mission.round}`),
    toolMetric("Turn", `${activeTurn} / ${mission.maxTurns}`),
    toolMetric("Purpose", mission.purpose),
  );
  layer.append(strip, p(mission.prompt, "muted"));
  return layer;
}

function buildPlaybackSessionLayer(sessionBase) {
  const layer = div("playback-layer playback-layer-bottom");
  layer.append(
    badge("Layer 1 · Start Here"),
    h3("Saved session state from the previous run"),
    p("This is the same continuation substrate both lanes conceptually have. The platform difference is not 'can continue'; it is 'can compact what matters before the next send'.", "muted"),
  );
  layer.append(buildSessionBasePanel(sessionBase));
  return layer;
}

function buildPlaybackStack(title, lines) {
  const panel = div("event-feed");
  panel.append(divText(title, "event-title"));
  for (const line of (lines ?? []).filter(Boolean).slice(0, 5)) {
    const item = div("event-item");
    item.append(divText(line, "event-detail"));
    panel.append(item);
  }
  return panel;
}

function describeActionOperation(action) {
  if (action.toolName === "read") {
    return `Read ${action.targetPath ?? action.detail} so the model can inspect the current implementation or spec.`;
  }
  if (action.toolName === "glob") {
    return `Search files with pattern ${action.detail}.`;
  }
  if (action.toolName === "bash") {
    return `Run command: ${action.detail}.`;
  }
  if (["edit", "write", "write_file"].includes(action.toolName)) {
    return `Modify ${action.targetPath ?? action.detail}.`;
  }
  if (action.toolName === "todowrite") {
    return "Update the agent plan before continuing.";
  }
  return action.label;
}

function describeActionResult(action) {
  if (action.outputPreview) {
    return action.outputPreview;
  }
  if (action.toolName === "read") {
    return `Loaded ${action.targetPath ?? action.detail} into the model working set.`;
  }
  if (action.toolName === "glob") {
    return "Returned a file match list to narrow the next step.";
  }
  if (action.toolName === "bash") {
    return "Returned command output for the agent to interpret.";
  }
  if (["edit", "write", "write_file"].includes(action.toolName)) {
    return "Applied file changes to the workspace.";
  }
  if (action.toolName === "todowrite") {
    return "Saved the refreshed task plan.";
  }
  return "Returned tool output to the agent.";
}

function describeActionWhy(action) {
  if (action.guidanceTag === "failing test") {
    return "the previous run already told the platform which tests were failing";
  }
  if (action.guidanceTag === "from last run") {
    return "the platform surfaced a file that was edited in the previous run";
  }
  if (action.guidanceTag === "task brief") {
    return "the task brief was promoted into the working set";
  }
  if (action.guidanceTag === "seed command") {
    return "the last validation command was carried forward from the previous run";
  }
  return "";
}

function describeTurnCostStory(turn) {
  if (!turn) {
    return "";
  }
  if (turn.toolActions.some((action) => action.guidanceTag === "from last run" || action.guidanceTag === "failing test")) {
    return "This turn starts from carried-over signals, so the agent can go straight to high-value files and tests.";
  }
  if (turn.toolActions.some((action) => action.label === "Read /" || action.label === "Read /app")) {
    return "This turn is still reconstructing context from the project structure, which tends to make later sends more expensive.";
  }
  if (turn.toolActions.some((action) => action.toolName === "bash")) {
    return "This turn is validating the current state. When validation happens after a shorter search path, the total token footprint stays low.";
  }
  return "This turn continues the current task using the working set built so far.";
}

function buildWarmSummaryCard(title, text, stats) {
  const card = div("warm-card");
  card.append(h3(title), p(text, "muted"));
  const grid = div("tool-grid");
  for (const [labelText, value] of stats) {
    const stat = div("tool-stat");
    stat.append(label(labelText), valueText(value));
    grid.append(stat);
  }
  card.append(grid);
  return card;
}

function buildRaceCard(warmProcess) {
  const card = div("timeline-card race-card");
  card.append(
    badge("Before First Edit Race"),
    h3("Watch both lanes move until the first useful write"),
    p("This replay uses the real event order from representative warm benchmark runs. Each step shows what the agent actually did and how much cost it had accumulated so far.", "muted"),
  );

  const controls = div("race-controls");
  const playButton = makeButton("Pause");
  const replayButton = makeButton("Replay");
  const jumpStartButton = makeButton("Jump to Step 1");
  const jumpEditButton = makeButton(`Jump to Platform Edit (${warmProcess.race.platformFirstEditStep})`);
  controls.append(playButton, replayButton, jumpStartButton, jumpEditButton);
  card.append(controls);

  const spotlight = div("race-spotlight");
  card.append(spotlight);

  const compare = div("race-compare");
  card.append(compare);

  const lanes = div("race-lanes");
  const baselineLane = div("race-lane baseline");
  const platformLane = div("race-lane platform");
  lanes.append(baselineLane, platformLane);
  card.append(lanes);

  const state = {
    step: 0,
    playing: true,
    maxStep: warmProcess.race.maxStep,
    timer: null,
  };

  playButton.addEventListener("click", () => {
    state.playing = !state.playing;
    playButton.textContent = state.playing ? "Pause" : "Play";
    syncTimer();
  });

  replayButton.addEventListener("click", () => {
    state.step = 0;
    state.playing = true;
    playButton.textContent = "Pause";
    render();
    syncTimer();
  });

  jumpStartButton.addEventListener("click", () => {
    state.step = warmProcess.race.openingStep;
    state.playing = false;
    playButton.textContent = "Play";
    render();
    syncTimer();
  });

  jumpEditButton.addEventListener("click", () => {
    state.step = warmProcess.race.platformFirstEditStep;
    state.playing = false;
    playButton.textContent = "Play";
    render();
    syncTimer();
  });

  render();
  syncTimer();

  function syncTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (!state.playing) {
      return;
    }
    state.timer = setInterval(() => {
      if (state.step >= state.maxStep) {
        state.playing = false;
        playButton.textContent = "Play";
        syncTimer();
        return;
      }
      state.step += 1;
      render();
    }, 800);
  }

  function render() {
    spotlight.textContent = buildSpotlightMessage(warmProcess, state.step);
    renderStepCompare(compare, warmProcess, state.step);
    renderLane(baselineLane, warmProcess.baseline, state.step, warmProcess.race.maxStep);
    renderLane(platformLane, warmProcess.platform, state.step, warmProcess.race.maxStep);
  }

  return card;
}

function renderLane(container, section, step, maxStep) {
  container.innerHTML = "";

  const totalWithEdit = section.prelude.totalEventsBeforeFirstEdit + 1;
  const progressStep = Math.min(step, totalWithEdit);
  const progress = totalWithEdit === 0 ? 0 : (progressStep / totalWithEdit) * 100;
  const current = resolveRaceEvent(section, step);
  const cumulative = current?.cumulative ?? emptyCumulative();

  container.append(
    badge(section.label),
    h3(`${formatNumber(section.callsBeforeFirstEdit)} events before first edit`),
  );

  const progressWrap = div("race-progress");
  const fill = div("race-progress-fill");
  fill.style.width = `${progress}%`;
  progressWrap.append(fill);
  container.append(progressWrap);

  const meta = div("race-meta");
  meta.append(
    tinyStat("Step", `${Math.min(step, totalWithEdit)}/${totalWithEdit}`),
    tinyStat("LLM so far", formatNumber(cumulative.llmCalls)),
    tinyStat("Tools so far", formatNumber(cumulative.toolCalls)),
  );
  container.append(meta);

  const cumulativeGrid = div("race-metrics");
  cumulativeGrid.append(
    toolMetric("Input", formatNumber(cumulative.inputTokens)),
    toolMetric("Input+Cache", formatNumber(cumulative.inputTokensWithCache)),
    toolMetric("Reads", formatNumber(cumulative.readCalls)),
    toolMetric("Bash", formatNumber(cumulative.bashCalls)),
    toolMetric("Edits", formatNumber(cumulative.editCalls)),
    toolMetric("Output", formatNumber(cumulative.outputTokens)),
  );
  container.append(cumulativeGrid);

  const currentCard = div(`race-current ${current?.kind === "edit" ? "finish" : ""}`);
  currentCard.append(label(current ? current.label : "Waiting"));
  currentCard.append(valueText(current ? current.detail : "Replay not started"));
  if (current?.guidanceTag) {
    currentCard.append(tagChip(current.guidanceTag));
  }
  container.append(currentCard);

  const feed = div("event-feed");
  for (const event of raceFeed(section, step)) {
    const item = div(`event-item ${event.active ? "active" : ""} ${event.kind === "edit" ? "finish" : ""}`);
    const head = div("event-head");
    head.append(
      tagChip(event.kind.toUpperCase()),
      miniText(`R${event.round}`),
    );
    item.append(head);
    item.append(
      divText(event.label, "event-title"),
      divText(event.detail, "event-detail"),
    );
    if (event.guidanceTag) {
      item.append(tagChip(event.guidanceTag));
    }
    feed.append(item);
  }
  container.append(feed);
}

function resolveRaceEvent(section, step) {
  if (step <= 0) {
    return null;
  }
  if (step <= section.prelude.events.length) {
    return section.prelude.events[step - 1];
  }
  if (section.prelude.firstEdit && step >= section.prelude.firstEdit.step) {
    return section.prelude.firstEdit;
  }
  return {
    kind: "idle",
    round: section.prelude.firstEdit?.round ?? 1,
    label: "Holding position",
    detail: "This lane is still between the last probe and the first edit.",
  };
}

function raceFeed(section, step) {
  const visible = [];
  const all = [
    ...section.prelude.events,
    ...(section.prelude.firstEdit ? [section.prelude.firstEdit] : []),
  ];
  const cappedStep = Math.max(0, Math.min(step, all.length));
  const startIndex = Math.max(0, cappedStep - 5);
  for (let index = startIndex; index < cappedStep; index += 1) {
    const event = all[index];
    visible.push({
      ...event,
      active: index === cappedStep - 1,
    });
  }
  if (visible.length === 0) {
    return [];
  }
  return visible;
}

function buildSpotlightMessage(warmProcess, step) {
  const baselineOpen = resolveRaceEvent(warmProcess.baseline, warmProcess.race.openingStep);
  const platformOpen = resolveRaceEvent(warmProcess.platform, warmProcess.race.openingStep);
  if (step <= 0) {
    return "Replay ready. Press play and watch how quickly each lane reaches the first real edit.";
  }
  if (step === warmProcess.race.openingStep) {
    return `Opening frame: baseline starts with "${baselineOpen?.label ?? "N/A"}", while platform starts with "${platformOpen?.label ?? "N/A"}".`;
  }
  if (step === warmProcess.race.platformFirstEditStep) {
    return `Platform reaches its first edit at step ${warmProcess.race.platformFirstEditStep}. Baseline is still in discovery mode.`;
  }
  if (step === warmProcess.race.baselineFirstEditStep) {
    return `Baseline finally reaches its first edit at step ${warmProcess.race.baselineFirstEditStep}, after a much longer loop.`;
  }
  return "The gap is not just token savings. It is a shorter path to the first useful write.";
}

function renderStepCompare(container, warmProcess, step) {
  container.innerHTML = "";
  const baseline = resolveRaceEvent(warmProcess.baseline, step);
  const platform = resolveRaceEvent(warmProcess.platform, step);
  const baselineCumulative = baseline?.cumulative ?? emptyCumulative();
  const platformCumulative = platform?.cumulative ?? emptyCumulative();

  const baselineCard = div("compare-card baseline");
  baselineCard.append(
    badge("Baseline at this step"),
    h3(baseline ? baseline.label : "Waiting"),
    p(baseline ? baseline.detail : "Replay not started", "muted"),
  );
  if (baseline?.guidanceTag) {
    baselineCard.append(tagChip(baseline.guidanceTag));
  }

  const deltaCard = div("compare-card delta");
  deltaCard.append(
    badge(`Step ${step || 0}`),
    h3("Cumulative gap so far"),
  );
  const deltaMetrics = div("compare-metrics");
  deltaMetrics.append(
    toolMetric("LLM calls", comparePair(baselineCumulative.llmCalls, platformCumulative.llmCalls)),
    toolMetric("Input", comparePair(baselineCumulative.inputTokens, platformCumulative.inputTokens)),
    toolMetric("Tool calls", comparePair(baselineCumulative.toolCalls, platformCumulative.toolCalls)),
    toolMetric("Reads", comparePair(baselineCumulative.readCalls, platformCumulative.readCalls)),
    toolMetric("Bash", comparePair(baselineCumulative.bashCalls, platformCumulative.bashCalls)),
    toolMetric("Edits", comparePair(baselineCumulative.editCalls, platformCumulative.editCalls)),
  );
  deltaCard.append(deltaMetrics);

  const platformCard = div("compare-card platform");
  platformCard.append(
    badge("Platform at this step"),
    h3(platform ? platform.label : "Waiting"),
    p(platform ? platform.detail : "Replay not started", "muted"),
  );
  if (platform?.guidanceTag) {
    platformCard.append(tagChip(platform.guidanceTag));
  }

  container.append(baselineCard, deltaCard, platformCard);
}

function buildEvidenceCard(section) {
  const card = div("timeline-card");
  card.append(
    badge(section.label),
    h3("Evidence in the event stream"),
  );

  const stats = div("tool-grid");
  const visibleTools = Object.entries(section.countsByTool)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4);
  for (const [name, value] of visibleTools) {
    const stat = div("tool-stat");
    stat.append(label(name), valueText(formatNumber(value)));
    stats.append(stat);
  }
  card.append(stats);

  const list = div("event-feed");
  const evidence = [
    ...section.prelude.events.slice(0, 4),
    ...(section.prelude.firstEdit ? [section.prelude.firstEdit] : []),
  ];
  for (const event of evidence) {
    const item = div(`event-item ${event.kind === "edit" ? "finish" : ""}`);
    item.append(
      divText(event.label, "event-title"),
      divText(event.detail, "event-detail"),
    );
    if (event.guidanceTag) {
      item.append(tagChip(event.guidanceTag));
    }
    list.append(item);
  }
  card.append(list);
  return card;
}

function emptyCumulative() {
  return {
    llmCalls: 0,
    inputTokens: 0,
    inputTokensWithCache: 0,
    outputTokens: 0,
    toolCalls: 0,
    readCalls: 0,
    bashCalls: 0,
    editCalls: 0,
  };
}

function comparePair(left, right) {
  return `${formatNumber(left)} vs ${formatNumber(right)}`;
}

function renderSources(sources) {
  const container = byId("source-list");
  container.innerHTML = "";
  for (const source of sources) {
    const card = div("source-card");
    card.append(
      badge(source.label),
      h3(source.path.split("/").pop()),
      p("This demo reads only local benchmark results and precomputed demo data.", "muted"),
      chipPath(source.path),
    );
    container.append(card);
  }
}

function animatePercent(element, targetValue) {
  const start = performance.now();
  const durationMs = 720;

  function tick(now) {
    const progress = Math.min(1, (now - start) / durationMs);
    const eased = 1 - (1 - progress) * (1 - progress);
    const value = targetValue * eased;
    element.textContent = `${value.toFixed(1)}%`;
    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      element.textContent = `${targetValue.toFixed(1)}%`;
    }
  }

  requestAnimationFrame(tick);
}

function byId(id) {
  return document.getElementById(id);
}

function div(className) {
  const element = document.createElement("div");
  if (className) {
    element.className = className;
  }
  return element;
}

function h3(text) {
  const element = document.createElement("h3");
  element.textContent = text;
  return element;
}

function p(text, className) {
  const element = document.createElement("p");
  if (className) {
    element.className = className;
  }
  element.textContent = text;
  return element;
}

function strong(text) {
  const element = document.createElement("strong");
  element.textContent = text;
  return element;
}

function label(text) {
  const element = document.createElement("span");
  element.className = "label";
  element.textContent = text;
  return element;
}

function valueText(text) {
  const element = div("value");
  element.textContent = text;
  return element;
}

function miniText(text) {
  const element = div("mini-text");
  element.textContent = text;
  return element;
}

function divText(text, className) {
  const element = div(className);
  element.textContent = text;
  return element;
}

function badge(text) {
  const element = div("status-badge");
  element.textContent = text;
  return element;
}

function chipPath(text) {
  const element = div("path-chip");
  element.textContent = text;
  return element;
}

function tagChip(text) {
  const element = div("tag-chip");
  element.textContent = text;
  return element;
}

function tinyStat(name, value) {
  const stat = div("tiny-stat");
  stat.append(label(name), valueText(value));
  return stat;
}

function toolMetric(name, value) {
  const stat = div("tool-stat");
  stat.append(label(name), valueText(value));
  return stat;
}

function snapshotItem(name, value) {
  const item = div("snapshot-item");
  item.append(label(name), valueText(value));
  return item;
}

function chipRow(title, counts) {
  const wrapper = div();
  wrapper.append(label(title));
  const row = div("chip-row");
  for (const [key, value] of Object.entries(counts)) {
    const chip = div("chip");
    chip.textContent = `${key} × ${value}`;
    row.append(chip);
  }
  wrapper.append(row);
  return wrapper;
}

function makeButton(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "round-button";
  button.textContent = text;
  return button;
}

function formatNumber(value) {
  return Number(value).toLocaleString("en-US");
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}
