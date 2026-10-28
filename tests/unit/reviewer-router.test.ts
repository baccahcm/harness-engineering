import test from "node:test";
import assert from "node:assert/strict";
import { selectFallbackReviewer, selectInitialReviewer } from "../../src/review/router.js";

const reviewers = [
  { provider: "codex" as const, model: "a" },
  { provider: "antigravity" as const, model: "b" },
  { provider: "antigravity" as const, model: "c" },
];

test("review router preserves configured priority", () => {
  assert.equal(selectInitialReviewer(reviewers).candidate.model, "a");
  assert.equal(selectFallbackReviewer(reviewers, 0, "QUOTA_EXHAUSTED").candidate.model, "b");
});

test("review router never falls back on REVISE-like failures", () => {
  assert.throws(() => selectFallbackReviewer(reviewers, 0, "REVISE"), (err: any) => err?.code === "FALLBACK_NOT_ALLOWED");
});
