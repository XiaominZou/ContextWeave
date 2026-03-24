## ADDED Requirements

### Requirement: Token Aggregation
The metrics system SHALL aggregate token usage across all LLM calls.

#### Scenario: Calculate total input tokens
- **WHEN** all rounds complete
- **THEN** the system reports total input tokens per mode

#### Scenario: Calculate total output tokens
- **WHEN** all rounds complete
- **THEN** the system reports total output tokens per mode

#### Scenario: Calculate R6-R10 average input tokens
- **WHEN** analyzing context inflation impact
- **THEN** the system reports average input tokens for rounds 6-10

#### Scenario: Calculate memory extraction tokens
- **WHEN** Mode C-real completes
- **THEN** the system reports total memoryExtractionTokens separately

### Requirement: Repeated-Run Summary
The metrics system SHALL summarize repeated benchmark runs with lightweight distribution stats.

#### Scenario: Report median and spread
- **WHEN** a mode has multiple runs
- **THEN** the system reports median, p25, and p75 for primary token metrics and completion score

### Requirement: Completion Score Calculation
The metrics system SHALL calculate a 100-point completion score.

#### Scenario: Public test score
- **WHEN** 23 public tests run
- **THEN** pass rate contributes up to 35 points

#### Scenario: Hidden test score
- **WHEN** 12 hidden tests run
- **THEN** pass rate contributes up to 25 points

#### Scenario: Code quality score
- **WHEN** ruff/flake8 runs
- **THEN** no errors contributes 10 points

#### Scenario: Delivery quality score
- **WHEN** README is evaluated
- **THEN** startup method + error code documentation contributes 15 points

#### Scenario: Process constraint score
- **WHEN** process constraints are verified
- **THEN** not deleting tests contributes 10 points, runnable code contributes 5 points

### Requirement: Fair Comparison Validation
The metrics system SHALL validate fair comparison conditions before token comparison.

#### Scenario: Reject unfair comparison by hidden tests
- **WHEN** two modes differ by more than 1 hidden test pass
- **THEN** the system flags the comparison as invalid

#### Scenario: Reject unfair comparison by completion score
- **WHEN** two modes have completion score difference > 5
- **THEN** the system flags the comparison as invalid

#### Scenario: Accept fair comparison
- **WHEN** hidden test pass difference <= 1
- **AND** completion score difference <= 5
- **THEN** the system allows token comparison

### Requirement: Wasted Call Ratio
The metrics system SHALL calculate wasted tool call ratio as an auxiliary metric.

#### Scenario: Calculate ratio
- **WHEN** all tool calls are analyzed
- **THEN** the system reports wastedCalls / totalToolCalls per mode
- **AND** the report marks it as auxiliary, not a primary success metric

### Requirement: Report Generation
The metrics system SHALL generate human-readable and machine-readable reports.

#### Scenario: Console report
- **WHEN** benchmark completes
- **THEN** a formatted table shows primary mode comparison

#### Scenario: JSON report
- **WHEN** benchmark completes
- **THEN** a JSON file contains all raw metrics and repeated-run summaries
