import assert from "node:assert/strict";
import test from "node:test";

import {
  CONSECUTIVE_FAILURE_LIMIT,
  DEFAULT_BUDGET_MS,
  isTripped,
  nextStep,
} from "../browser/sampling.js";

// Drive the pure planner the way entry.js would: keep asking nextStep and
// feeding back synthetic durations until it says stop. Returns the warmup and
// sample counts the schedule produced.
function runSchedule(policy, durationFor) {
  const warmups = [];
  const samples = [];
  for (let guard = 0; guard < 10_000; guard += 1) {
    const step = nextStep(policy, { warmups, samples });
    if (step === "stop") break;
    const elapsed = durationFor(step, { warmups, samples });
    if (step === "warmup") warmups.push(elapsed);
    else samples.push(elapsed);
  }
  return { warmups: warmups.length, samples: samples.length };
}

const WARM = { mode: "warm", budgetMs: DEFAULT_BUDGET_MS, maxSamples: 20 };

test("a fast op keeps all 20 samples (budget never reached)", () => {
  // Sub-millisecond op: 20 samples sum to ~4ms, far below the 1500ms budget.
  const result = runSchedule(WARM, () => 0.2);
  assert.equal(result.warmups, 2, "two warmups, both under budget");
  assert.equal(result.samples, 20, "capped at maxSamples");
});

test("slow-op exception: first warmup over budget → exactly 2 samples, one warmup", () => {
  const result = runSchedule(WARM, () => 2000); // every op exceeds the 1500ms budget
  assert.equal(result.warmups, 1, "second warmup skipped");
  assert.equal(result.samples, 2, "exactly two samples for a slow op");
});

test("budget stop respects the 3-sample minimum", () => {
  // A medium op: warmups are cheap (under budget so a 2nd warmup runs), but each
  // sample costs 700ms, so cumulative crosses 1500ms at sample 3.
  let call = 0;
  const result = runSchedule(WARM, (step) => {
    if (step === "warmup") return 10; // under budget → 2 warmups
    call += 1;
    return 700;
  });
  assert.equal(result.warmups, 2);
  // 700+700 = 1400 < 1500 after 2, so a 3rd is taken (min 3); then 2100 ≥ 1500 → stop.
  assert.equal(result.samples, 3);
});

test("second warmup is skipped only when the first exceeds budget", () => {
  // First warmup just over budget, but subsequent ops cheap: still slow-op path.
  const durations = [1600, 5, 5, 5, 5];
  let index = 0;
  const result = runSchedule(WARM, () => durations[index++] ?? 5);
  assert.equal(result.warmups, 1);
  assert.equal(result.samples, 2);
});

test("cold (once) mode: no warmups, exactly one sample", () => {
  const cold = { mode: "cold", budgetMs: DEFAULT_BUDGET_MS, maxSamples: 20 };
  const result = runSchedule(cold, () => 5);
  assert.equal(result.warmups, 0);
  assert.equal(result.samples, 1);
});

test("light-style small cap: fast op stops at the small max, still ≥ 3", () => {
  const light = { mode: "warm", budgetMs: DEFAULT_BUDGET_MS, maxSamples: 5 };
  const result = runSchedule(light, () => 0.2);
  assert.equal(result.samples, 5);
});

test("max below the 3-sample floor is honored (no infinite loop)", () => {
  const tiny = { mode: "warm", budgetMs: DEFAULT_BUDGET_MS, maxSamples: 2 };
  const result = runSchedule(tiny, () => 0.2);
  assert.equal(result.samples, 2);
});

test("circuit breaker trips after the consecutive-failure limit", () => {
  assert.equal(isTripped(CONSECUTIVE_FAILURE_LIMIT - 1), false);
  assert.equal(isTripped(CONSECUTIVE_FAILURE_LIMIT), true);
  assert.equal(isTripped(0), false);
  assert.equal(isTripped(2, 2), true);
});
