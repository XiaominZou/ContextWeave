## ADDED Requirements

### Requirement: Primary Execution Modes
The runner SHALL support three primary execution modes for the main benchmark.

#### Scenario: Mode A Baseline
- **WHEN** running Mode A
- **THEN** capabilityPolicy is `{ context: "native", memory: "off", tasks: "observe-native", artifacts: "observe" }`

#### Scenario: Mode B Platform+Context
- **WHEN** running Mode B
- **THEN** capabilityPolicy is `{ context: "inject", memory: "off", tasks: "observe-native", artifacts: "observe" }`

#### Scenario: Mode C-real Platform+Context+Memory
- **WHEN** running Mode C-real
- **THEN** capabilityPolicy is `{ context: "inject", memory: "platform", tasks: "observe-native", artifacts: "observe" }`
- **AND** memory extraction uses LLM calls
- **AND** memoryExtractionTokens is recorded

### Requirement: Optional Auxiliary Mode
The runner MAY support Mode C-sim as an auxiliary mode for internal validation.

#### Scenario: C-sim used for internal upper-bound checks
- **WHEN** running Mode C-sim
- **THEN** memory extraction uses deterministic rules without LLM cost
- **AND** the result is marked as auxiliary, not primary

### Requirement: Fixed 10-Round User Instructions
The runner SHALL execute identical 10 user instructions across all primary modes.

#### Scenario: Same rounds across modes
- **WHEN** running Mode A, Mode B, and Mode C-real
- **THEN** all modes use the same ordered round definitions

### Requirement: Serial Execution for Main Benchmark
The runner SHALL execute the main benchmark in serial order for all primary modes.

#### Scenario: No parallel R5 in primary benchmark
- **WHEN** executing Round 5 in the main benchmark
- **THEN** all primary modes complete the round in a single serial run context

### Requirement: Repeated Runs
The runner SHALL support repeated runs for each primary mode.

#### Scenario: Default repeated execution
- **WHEN** the full benchmark is executed
- **THEN** each primary mode runs at least 5 times unless explicitly overridden for smoke testing

### Requirement: Run Isolation
The runner SHALL ensure each mode run is independent.

#### Scenario: Fresh fixture for each run
- **WHEN** a new mode run starts
- **THEN** the MiniKanban fixture is reset to initial state

#### Scenario: No cross-mode contamination
- **WHEN** one mode completes
- **THEN** the next mode starts with no knowledge of the previous mode's execution
