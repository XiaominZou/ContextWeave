## 1. Project Setup

- [ ] 1.1 Create packages/benchmark/ directory with package.json and tsconfig.json
- [ ] 1.2 Add benchmark package to root workspace configuration
- [ ] 1.3 Install required dependencies (vitest, typescript)

## 2. MiniKanban Fixture

- [ ] 2.1 Create fixtures/minikanban/ directory structure
- [ ] 2.2 Implement app/main.py with FastAPI app skeleton
- [ ] 2.3 Implement app/models.py with Board and Task models (missing tags field)
- [ ] 2.4 Implement app/schemas.py with partial Pydantic schemas (missing StatsResponse)
- [ ] 2.5 Implement app/store.py with InMemoryStore (missing delete_board, filter_by_tag)
- [ ] 2.6 Implement app/routes/boards.py with GET/POST (missing DELETE)
- [ ] 2.7 Implement app/routes/tasks.py with POST only (missing PUT/DELETE/GET)
- [ ] 2.8 Create tests/conftest.py with pytest fixtures
- [ ] 2.9 Create tests/test_boards.py with 8 tests (4 pass, 4 fail by design)
- [ ] 2.10 Create tests/test_tasks.py with 10 tests (6 pass, 4 fail by design)
- [ ] 2.11 Create tests/test_stats.py with 5 tests (all fail, endpoint not implemented)
- [ ] 2.12 Create tests/test_hidden.py with 12 hidden tests
- [ ] 2.13 Create SPEC.md with complete requirements specification
- [ ] 2.14 Create empty README.md for agent to fill
- [ ] 2.15 Verify initial pytest results: ~10 pass, 13 fail

## 3. Benchmark Harness

- [ ] 3.1 Create src/harness/call-recorder.ts with LlmCallRecord and ToolUseRecord interfaces
- [ ] 3.2 Implement CallRecorder class to collect records per run
- [ ] 3.3 Create src/harness/event-stream-tap.ts to tap RunHandle.streamEvents()
- [ ] 3.4 Create src/harness/dedup-detector.ts with detectWastedCalls function
- [ ] 3.5 Write unit tests for harness components

## 4. Benchmark Runner

- [ ] 4.1 Create src/runner/round-defs.ts with 10 fixed user instructions
- [ ] 4.2 Create src/runner/memory-extractor.ts with deterministic rule-based extraction
- [ ] 4.3 Create src/runner/modes/baseline.ts for Mode A execution
- [ ] 4.4 Create src/runner/modes/platform-context.ts for Mode B execution
- [ ] 4.5 Create src/runner/modes/platform-memory.ts for Mode C execution
- [ ] 4.6 Create src/runner/benchmark-runner.ts with runAll function
- [ ] 4.7 Write integration tests using RawMockAdapter

## 5. Metrics and Results

- [ ] 5.1 Create src/results/schema.ts with result type definitions
- [ ] 5.2 Create src/results/analyzer.ts with computeTokenSavingsAnalysis function
- [ ] 5.3 Create src/results/reporter.ts for console table and JSON output
- [ ] 5.4 Write unit tests for analyzer functions

## 6. Completion Scoring

- [ ] 6.1 Create scripts/score-completion.ts to run pytest and calculate score
- [ ] 6.2 Implement public test scoring (35 points max)
- [ ] 6.3 Implement hidden test scoring (25 points max)
- [ ] 6.4 Implement code quality scoring with ruff/flake8 (10 points max)
- [ ] 6.5 Implement README quality scoring (15 points max)
- [ ] 6.6 Implement process constraint scoring (15 points max)

## 7. CLI Entry Point

- [ ] 7.1 Create scripts/run-benchmark.ts as CLI entry point
- [ ] 7.2 Add npm scripts for running individual modes
- [ ] 7.3 Add npm script for running all modes with comparison

## 8. Token Metering Support

- [ ] 8.1 Implement LLM API proxy interceptor for token capture (P0, recommended)
- [ ] 8.2 Verify token counts are captured in CallRecorder
- [ ] 8.3 Add run.usage event parsing to OpenCode adapter normalizeEvent() (P1, backup approach)

## 9. Validation and Documentation

- [ ] 9.1 Verify fixture with manual pytest run
- [ ] 9.2 Run Mode A with RawMockAdapter to verify framework
- [ ] 9.3 Create early validation report with simulated results
- [ ] 9.4 Document limitations and assumptions in report
