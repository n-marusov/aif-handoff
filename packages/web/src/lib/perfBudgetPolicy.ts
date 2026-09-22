export interface PerfBudgetPolicy {
  attempts: number;
  useMedian: boolean;
}

export function resolvePerfBudgetPolicy(
  env: Partial<Record<string, string | undefined>> = process.env,
): PerfBudgetPolicy {
  const isCi = env.CI === "1" || env.CI === "true";
  if (isCi) {
    return { attempts: 1, useMedian: false };
  }
  return { attempts: 3, useMedian: true };
}

export function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("median requires at least one value");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface PerfBudgetEvaluation {
  pass: boolean;
  representativeMs: number;
  samplesMs: number[];
  attempts: number;
  mode: "strict" | "median";
}

export function evaluateBudgetSamples(
  samplesMs: number[],
  budgetMs: number,
  policy: PerfBudgetPolicy,
): PerfBudgetEvaluation {
  if (samplesMs.length === 0) {
    throw new Error("evaluateBudgetSamples requires at least one sample");
  }
  const attempts = Math.max(1, Math.min(policy.attempts, samplesMs.length));
  const effective = samplesMs.slice(0, attempts);
  if (!policy.useMedian || attempts === 1) {
    const strict = effective[0];
    return {
      pass: strict <= budgetMs,
      representativeMs: strict,
      samplesMs: effective,
      attempts,
      mode: "strict",
    };
  }
  const med = median(effective);
  return {
    pass: med <= budgetMs,
    representativeMs: med,
    samplesMs: effective,
    attempts,
    mode: "median",
  };
}
