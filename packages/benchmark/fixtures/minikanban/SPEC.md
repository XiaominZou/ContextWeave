# MiniKanban Benchmark Fixture

This fixture is the long-running coding task used by the benchmark runner.

The implementation in this repository is intentionally lightweight for V1:
- benchmark orchestration is implemented
- the fixture path is reserved for the real FastAPI project

The benchmark package currently uses a mock runner to validate the harness,
metrics, reporting, and fairness gates before wiring in the real adapter path.
