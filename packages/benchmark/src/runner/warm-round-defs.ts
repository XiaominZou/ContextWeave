import type { LlmCallRecord } from "../results/schema";

export interface WarmBenchmarkRoundDefinition {
  pass: "pass1" | "pass2";
  round: number;
  prompt: string;
  purpose: LlmCallRecord["purpose"];
}

export const WARM_BENCHMARK_ROUNDS: WarmBenchmarkRoundDefinition[] = [
  {
    pass: "pass2",
    round: 1,
    prompt: "Resume the partially completed MiniKanban implementation. Inspect the current code and identify the highest-value missing behaviors before making targeted fixes.",
    purpose: "patch",
  },
  {
    pass: "pass2",
    round: 2,
    prompt: "Continue implementing the missing behaviors in the existing codebase. Use focused edits and validate progress as needed.",
    purpose: "patch",
  },
  {
    pass: "pass2",
    round: 3,
    prompt: "Run the relevant checks, finish the remaining fixes, and stop when the MiniKanban fixture is complete.",
    purpose: "debug",
  },
];
