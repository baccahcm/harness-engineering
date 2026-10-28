import test from "node:test";
import assert from "node:assert/strict";
import { summarizeMetricsByReviewer, type TurnMetricRecord } from "../../src/metrics/store.js";

function metric(reviewerName: string, provider: "claude" | "codex", input: number, cached: number, reusedSession: boolean): TurnMetricRecord {
  return {
    schemaVersion: 1,
    recordedAt: "2026-10-27T00:00:00Z",
    taskId: "t",
    requestId: `${reviewerName}-${input}`,
    provider,
    purpose: "reviewer",
    model: "review",
    reviewerName,
    success: true,
    prompt: { taskId: "t", purpose: "reviewer", provider, model: "review", mode: reusedSession ? "FOLLOW_UP" : "INITIAL", target: "final", reusedSession, stablePrefixHash: "a", promptHash: "b", estimatedInputTokens: input, sections: [] },
    usage: { inputTokens: input, cachedInputTokens: cached, outputTokens: 10, source: "provider" },
    responseChars: 100,
  };
}

test("reviewer metrics remain separated by configured reviewer identity", () => {
  const result = summarizeMetricsByReviewer([
    metric("claude-opus", "claude", 100, 60, false),
    metric("claude-opus", "claude", 40, 30, true),
    metric("codex", "codex", 80, 20, false),
  ]);
  assert.equal(result.length, 2);
  const claude = result.find((item) => item.reviewerName === "claude-opus")!;
  const codex = result.find((item) => item.reviewerName === "codex")!;
  assert.equal(claude.inputTokens, 140);
  assert.equal(claude.cachedInputTokens, 90);
  assert.equal(claude.sessionReuseTurns, 1);
  assert.equal(codex.inputTokens, 80);
});
