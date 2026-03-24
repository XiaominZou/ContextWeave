## 1. Project Setup

- [ ] 1.1 Create `packages/benchmark/` with `package.json` and `tsconfig.json`
- [ ] 1.2 Add benchmark package to workspace
- [ ] 1.3 Install required dependencies

## 2. MiniKanban Fixture

- [ ] 2.1 Create `fixtures/minikanban/` directory structure
- [ ] 2.2 Add incomplete FastAPI app skeleton
- [ ] 2.3 Add public tests and hidden tests
- [ ] 2.4 Add `SPEC.md` and empty `README.md`
- [ ] 2.5 Verify initial pytest state

## 3. Benchmark Harness

- [ ] 3.1 Implement LLM call recording
- [ ] 3.2 Implement tool-use recording
- [ ] 3.3 Implement event-stream tap
- [ ] 3.4 Implement wasted-call detection
- [ ] 3.5 Add harness unit tests

## 4. Benchmark Runner

- [ ] 4.1 Define the fixed 10 rounds
- [ ] 4.2 Implement Mode A runner
- [ ] 4.3 Implement Mode B runner
- [ ] 4.4 Implement Mode C-real runner
- [ ] 4.5 Keep Mode C-sim optional for internal validation only
- [ ] 4.6 Ensure the primary benchmark is serial across all modes
- [ ] 4.7 Support repeated runs with default count = 5
- [ ] 4.8 Write integration tests with `RawMockAdapter`

## 5. Metrics and Results

- [ ] 5.1 Implement result schema
- [ ] 5.2 Implement token aggregation and repeated-run summary
- [ ] 5.3 Implement fairness validation:
- [ ] 5.4 Hidden test pass difference <= 1
- [ ] 5.5 Completion score difference <= 5
- [ ] 5.6 Mark wasted-call ratio as auxiliary only
- [ ] 5.7 Add analyzer unit tests

## 6. Completion Scoring

- [ ] 6.1 Create `score-completion.ts`
- [ ] 6.2 Score public tests
- [ ] 6.3 Score hidden tests
- [ ] 6.4 Score code quality
- [ ] 6.5 Score README quality
- [ ] 6.6 Score process constraints

## 7. CLI Entry Point

- [ ] 7.1 Create `run-benchmark.ts`
- [ ] 7.2 Add scripts for single-mode and all-mode execution
- [ ] 7.3 Add smoke mode for single-run local debugging

## 8. Token Metering Support

- [ ] 8.1 Implement LLM API proxy interceptor as P0
- [ ] 8.2 Verify token capture reaches CallRecorder
- [ ] 8.3 Keep adapter-side `run.usage` parsing as backup only

## 9. Validation and Documentation

- [ ] 9.1 Verify fixture with manual pytest run
- [ ] 9.2 Verify harness/analyzer with RawMockAdapter
- [ ] 9.3 Produce an early simulated report
- [ ] 9.4 Document limitations:
- [ ] 9.5 Single fixture only
- [ ] 9.6 C-sim is auxiliary only
- [ ] 9.7 Main claim is based on A vs B and B vs C-real
