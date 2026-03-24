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

#### Scenario: Calculate net savings for C-real
- **WHEN** comparing Mode C-real to Mode B
- **THEN** the system reports netSavings = grossSavings - memoryExtractionTokens

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
The metrics system SHALL validate fair comparison conditions.

#### Scenario: Reject unfair comparison
- **WHEN** two modes have completion score difference > 5 points
- **THEN** the system flags the comparison as invalid

#### Scenario: Accept fair comparison
- **WHEN** two modes have completion score difference <= 5 points
- **THEN** the system allows token comparison

### Requirement: Wasted Call Ratio
The metrics system SHALL calculate wasted tool call ratio.

#### Scenario: Calculate ratio
- **WHEN** all tool calls are analyzed
- **THEN** the system reports wastedCalls / totalToolCalls per mode

### Requirement: Report Generation
The metrics system SHALL generate human-readable and machine-readable reports.

#### Scenario: Console report
- **WHEN** benchmark completes
- **THEN** a formatted table shows mode comparison

#### Scenario: JSON report
- **WHEN** benchmark completes
- **THEN** a JSON file contains all raw metrics for further analysis
