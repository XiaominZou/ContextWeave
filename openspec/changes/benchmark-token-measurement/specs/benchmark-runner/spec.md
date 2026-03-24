## ADDED Requirements

### Requirement: Four Execution Modes
The runner SHALL support four execution modes with distinct capability policies.

#### Scenario: Mode A Baseline
- **WHEN** running Mode A
- **THEN** capabilityPolicy is { context: "native", memory: "off", tasks: "observe-native", artifacts: "observe" }

#### Scenario: Mode B Platform+Context
- **WHEN** running Mode B
- **THEN** capabilityPolicy is { context: "inject", memory: "off", tasks: "observe-native", artifacts: "observe" }

#### Scenario: Mode C-sim Platform+Context+Memory-sim
- **WHEN** running Mode C-sim
- **THEN** capabilityPolicy is { context: "inject", memory: "platform", tasks: "observe-native", artifacts: "observe" }
- **AND** memory extraction uses deterministic rules (no LLM calls)

#### Scenario: Mode C-real Platform+Context+Memory-real
- **WHEN** running Mode C-real
- **THEN** capabilityPolicy is { context: "inject", memory: "platform", tasks: "observe-native", artifacts: "observe" }
- **AND** memory extraction uses LLM calls
- **AND** memoryExtractionTokens is recorded

### Requirement: Fixed 10-Round User Instructions
The runner SHALL execute identical 10 user instructions across all modes.

#### Scenario: Round 1 analysis only
- **WHEN** Round 1 executes
- **THEN** agent reads SPEC.md and code, summarizes gaps, provides plan without writing code

#### Scenario: Round progression
- **WHEN** all 10 rounds complete
- **THEN** agent has gone through analysis, implementation, bug fix, feature addition, and finalization phases

### Requirement: C-sim Deterministic Memory Extraction
The runner SHALL use rule-based memory extraction for Mode C-sim without LLM calls.

#### Scenario: Extract business rules deterministically
- **WHEN** a round successfully implements a business rule
- **THEN** a deterministic rule maps the success to a memory record content

#### Scenario: No extra LLM cost for C-sim
- **WHEN** memory extraction runs in Mode C-sim
- **THEN** no additional LLM API calls are made

### Requirement: C-real LLM Memory Extraction
The runner SHALL use LLM-based memory extraction for Mode C-real and record the cost.

#### Scenario: Extract memory with LLM
- **WHEN** a round completes in Mode C-real
- **THEN** an LLM call extracts memory candidates from the run

#### Scenario: Record memory extraction tokens
- **WHEN** LLM memory extraction completes
- **THEN** memoryExtractionTokens is added to the run's total token count

### Requirement: R5 Parallel Sub-task Execution
The runner SHALL support parallel sub-task execution for R5 to demonstrate task graph benefits.

#### Scenario: R5 splits into parallel sub-tasks
- **WHEN** R5 (Phase 2 finalization) executes
- **THEN** the runner creates two parallel sub-tasks: T3.1 (implement cascade delete) and T3.2 (add cascade delete tests)

#### Scenario: Platform modes execute sub-tasks in parallel
- **WHEN** running Mode B, C-sim, or C-real
- **THEN** T3.1 and T3.2 can be executed in parallel by different run contexts

#### Scenario: Baseline mode executes sub-tasks sequentially
- **WHEN** running Mode A
- **THEN** T3.1 and T3.2 are executed sequentially in a single run context

### Requirement: Run Isolation
The runner SHALL ensure each mode run is independent.

#### Scenario: Fresh fixture for each run
- **WHEN** a new mode run starts
- **THEN** the MiniKanban fixture is reset to initial state

#### Scenario: No cross-mode contamination
- **WHEN** Mode B completes
- **THEN** Mode C-sim starts with no knowledge of Mode B's execution
