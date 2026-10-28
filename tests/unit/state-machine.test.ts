import test from "node:test";
import assert from "node:assert/strict";
import { createTask } from "../../src/core/task.js";
import { applyReviewVerdict, invalidateStaleApprovals, transitionTask } from "../../src/core/state-machine.js";
import { canFallbackReviewer, assertActionAllowed } from "../../src/core/policy.js";

function toReview(task: ReturnType<typeof createTask>) {
  return transitionTask(transitionTask(transitionTask(task, "READY_FOR_DEV"), "IN_PROGRESS"), "READY_FOR_REVIEW");
}

test("NONE lifecycle completes without APPROVED", () => {
  let task = createTask("docs", "Docs", "NONE", "docs only");
  task = transitionTask(task, "READY_FOR_DEV");
  task = transitionTask(task, "IN_PROGRESS");
  task = transitionTask(task, "COMPLETED");
  assert.equal(task.status, "COMPLETED");
  assert.equal(task.finalReview.verdict, "PENDING");
});

test("developer cannot approve", () => {
  const task = toReview(createTask("x", "X", "LIGHT", "small"));
  assert.throws(() => applyReviewVerdict(task, "developer", "APPROVED", undefined, "fp"), /P001/);
});

test("NONE cannot emit APPROVED", () => {
  const base = createTask("x", "X", "NONE", "docs");
  const task = { ...base, status: "READY_FOR_REVIEW" as const };
  assert.throws(() => applyReviewVerdict(task, "reviewer", "APPROVED", undefined, "fp"), /P010/);
});

test("LIGHT cannot complete without whole-task approval", () => {
  const task = toReview(createTask("x", "X", "LIGHT", "small"));
  assert.throws(() => transitionTask(task, "COMPLETED"), /P011/);
  const approved = applyReviewVerdict(task, "reviewer", "APPROVED", undefined, "fp1");
  assert.equal(transitionTask(approved, "COMPLETED").status, "COMPLETED");
});

test("FULL cannot complete without final approval", () => {
  const task = toReview(createTask("x", "X", "FULL", "security"));
  assert.throws(() => transitionTask(task, "COMPLETED"), /P012/);
  const approved = applyReviewVerdict(task, "reviewer", "APPROVED", undefined, "fp1");
  assert.equal(transitionTask(approved, "COMPLETED").status, "COMPLETED");
});

test("approval becomes stale when source fingerprint changes", () => {
  const task = applyReviewVerdict(toReview(createTask("x", "X", "FULL", "security")), "reviewer", "APPROVED", undefined, "fp1");
  const stale = invalidateStaleApprovals(task, "fp2");
  assert.equal(stale.finalReview.verdict, "PENDING");
});

test("reviewer fallback only accepts qualifying provider failures", () => {
  assert.equal(canFallbackReviewer("QUOTA_EXHAUSTED"), true);
  assert.equal(canFallbackReviewer("SERVICE_UNAVAILABLE"), true);
  assert.equal(canFallbackReviewer("MODEL_UNAVAILABLE"), true);
  assert.equal(canFallbackReviewer("REVISE"), false);
  assert.equal(canFallbackReviewer("MISSING_EVIDENCE"), false);
});

test("dangerous git actions require explicit authorization", () => {
  assert.throws(() => assertActionAllowed("git_push", { actor: "developer" }), /P030/);
  assert.doesNotThrow(() => assertActionAllowed("git_push", { actor: "developer", userAuthorized: true }));
  assert.throws(() => assertActionAllowed("modify_application_source", { actor: "reviewer" }), /P002/);
});
