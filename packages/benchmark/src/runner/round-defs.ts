export interface BenchmarkRoundDefinition {
  round: number;
  prompt: string;
  purpose: "plan" | "patch" | "debug" | "summarize";
}

export const BENCHMARK_ROUNDS: BenchmarkRoundDefinition[] = [
  { round: 1, prompt: "Read SPEC.md and summarize the implementation gaps without writing code.", purpose: "plan" },
  { round: 2, prompt: "Implement the core CRUD routes with minimal file changes.", purpose: "patch" },
  { round: 3, prompt: "Run tests and fix the first five failures.", purpose: "debug" },
  { round: 4, prompt: "Add the business rules around done titles and tag limits.", purpose: "patch" },
  { round: 5, prompt: "Implement cascade delete and the related tests.", purpose: "patch" },
  { round: 6, prompt: "Add task filtering by tag.", purpose: "patch" },
  { round: 7, prompt: "Add the board stats endpoint.", purpose: "patch" },
  { round: 8, prompt: "Unify error codes and update the README.", purpose: "patch" },
  { round: 9, prompt: "Run tests again and fix remaining issues without refactoring.", purpose: "debug" },
  { round: 10, prompt: "Produce the final delivery summary.", purpose: "summarize" },
];
