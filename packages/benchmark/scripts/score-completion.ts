import type { CompletionScore } from "../src/index.ts";

export interface ScoreCompletionInput {
  publicTestsPassed: number;
  publicTestsTotal: number;
  hiddenTestsPassed: number;
  hiddenTestsTotal: number;
  codeQualityPassed: boolean;
  deliveryPassed: boolean;
  processPassed: boolean;
}

export function scoreCompletion(input: ScoreCompletionInput): CompletionScore {
  const publicPoints = scaledPoints(input.publicTestsPassed, input.publicTestsTotal, 35);
  const hiddenPoints = scaledPoints(input.hiddenTestsPassed, input.hiddenTestsTotal, 25);
  const codeQualityPoints = input.codeQualityPassed ? 10 : 0;
  const deliveryPoints = input.deliveryPassed ? 15 : 0;
  const processPoints = input.processPassed ? 15 : 0;

  return {
    total: publicPoints + hiddenPoints + codeQualityPoints + deliveryPoints + processPoints,
    publicTestsPassed: input.publicTestsPassed,
    publicTestsTotal: input.publicTestsTotal,
    hiddenTestsPassed: input.hiddenTestsPassed,
    hiddenTestsTotal: input.hiddenTestsTotal,
    codeQualityPoints,
    deliveryPoints,
    processPoints,
  };
}

function scaledPoints(passed: number, total: number, maxPoints: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((passed / total) * maxPoints);
}
