## ADDED Requirements

### Requirement: MiniKanban Project Structure
The fixture SHALL provide a Python FastAPI project with incomplete implementation.

#### Scenario: Verify initial project state
- **WHEN** the fixture is loaded
- **THEN** the project contains app/main.py, app/models.py, app/schemas.py, app/store.py, app/routes/boards.py, app/routes/tasks.py

#### Scenario: Verify initial test state
- **WHEN** pytest runs on initial fixture
- **THEN** approximately 10 of 23 public tests pass
- **AND** 13 tests fail as expected

### Requirement: Public Test Suite
The fixture SHALL include 23 public tests with known pass/fail distribution.

#### Scenario: Public tests cover all API endpoints
- **WHEN** examining test_boards.py, test_tasks.py, test_stats.py
- **THEN** all 8 API routes have corresponding test cases

#### Scenario: Deliberate failures
- **WHEN** examining failing tests
- **THEN** failures are due to missing implementation, not test bugs

### Requirement: Hidden Test Suite
The fixture SHALL include 12 hidden tests not visible to the agent.

#### Scenario: Hidden tests cover edge cases
- **WHEN** hidden tests run at final verification
- **THEN** they test boundary conditions, business rule violations, error handling

#### Scenario: Hidden tests are not in SPEC.md
- **WHEN** agent reads SPEC.md
- **THEN** hidden test cases are not mentioned

### Requirement: Four-Phase Task Structure
The fixture SHALL support incremental development across 4 phases.

#### Scenario: Phase 1 basic CRUD
- **WHEN** Phase 1 is complete
- **THEN** all basic CRUD operations work

#### Scenario: Phase 2 business constraints
- **WHEN** Phase 2 is complete
- **THEN** done status immutability, tag limits, cascade delete work

#### Scenario: Phase 3 feature additions
- **WHEN** Phase 3 is complete
- **THEN** tag filtering and statistics endpoints work

#### Scenario: Phase 4 finalization
- **WHEN** Phase 4 is complete
- **THEN** error codes are unified, README is complete, all bugs fixed
