// Pure scheduling decisions for the measurement loop. This module owns every
// decision about how many warmups and samples to take for one config; entry.js
// owns the clock and the loop and simply asks "what next?" after each operation.
//
// Keeping it pure (no timers, no performance.now, no I/O) is the agreed test
// seam: esbuild bundles it into the browser runner, and `node --test` imports it
// directly to verify the schedule without a browser run.

export const DEFAULT_BUDGET_MS = 1500;

// Decide the next step for one config given the durations observed so far.
//
//   policy   = { mode: "warm" | "cold", budgetMs, maxSamples }
//   observed = { warmups: number[], samples: number[] }   // elapsed ms each
//
// Returns "warmup", "sample", or "stop".
//
// Warm policy: run 1 warmup; run a 2nd only if the first finished under budget.
// Then sample until at least 3 samples AND (cumulative sample time ≥ budget OR
// the max-sample cap is hit). Exception — a "slow op" whose very first warmup
// already exceeded the budget takes exactly 2 samples and stops (no point
// spending minutes gathering a tight percentile on a multi-second operation).
//
// Cold ("once") policy: no warmups, exactly one sample per config — enough to
// keep first-visit network bytes honest (lazy per-search fetches included) and
// yield a first-interaction latency, without duplicating the warm matrix.
export function nextStep(policy, observed) {
  const { mode, budgetMs, maxSamples } = policy;
  const warmups = observed.warmups ?? [];
  const samples = observed.samples ?? [];

  if (mode === "cold") {
    return samples.length < 1 ? "sample" : "stop";
  }

  // Warmup phase.
  if (warmups.length === 0) return "warmup";
  const firstWarmupOverBudget = warmups[0] >= budgetMs;
  if (warmups.length === 1 && !firstWarmupOverBudget) return "warmup";

  // Sampling phase.
  if (firstWarmupOverBudget) {
    // Slow op: the first warmup alone blew the budget — take exactly 2 samples.
    return samples.length < 2 ? "sample" : "stop";
  }
  // Never demand more samples than the cap allows (handles maxSamples < 3).
  const minSamples = Math.min(3, maxSamples);
  if (samples.length < minSamples) return "sample";
  if (samples.length >= maxSamples) return "stop";
  const cumulative = samples.reduce((total, value) => total + value, 0);
  return cumulative >= budgetMs ? "stop" : "sample";
}

// Circuit breaker (ticket 07): after a run of consecutive config failures, stop
// measuring the remaining configs for this engine/site/page. Pure so it is
// unit-testable; entry.js tracks the streak and calls this before each config.
export const CONSECUTIVE_FAILURE_LIMIT = 3;

export function isTripped(consecutiveFailures, limit = CONSECUTIVE_FAILURE_LIMIT) {
  return consecutiveFailures >= limit;
}
