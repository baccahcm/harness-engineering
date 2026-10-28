import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { initProject } from "../../src/installer/install.js";
import { setReviewLevelPolicy, upsertReviewerProfile, effectiveReviewPolicy, loadConfig, saveConfig, reorderReviewerProfiles } from "../../src/core/config.js";
import { createTask, setTaskReviewPolicyOverride } from "../../src/core/task.js";
import { beginActiveTask, loadActiveTask, saveActiveTask } from "../../src/core/store.js";
import { transitionTask } from "../../src/core/state-machine.js";
import { orchestrateReview } from "../../src/review/orchestrator.js";
import type { ReviewDispatchResult, ReviewPromptInput } from "../../src/review/dispatcher.js";
import { dispatchReview } from "../../src/review/dispatcher.js";
import type { ReviewerCandidate } from "../../src/review/router.js";
import type { AgentAdapter, AgentTurnResult } from "../../src/agents/types.js";
import { loadSessionRegistry } from "../../src/agents/session-registry.js";
import { refreshStaleApprovals } from "../../src/review/staleness.js";
import { loadTurnMetrics } from "../../src/metrics/store.js";

const approved = JSON.stringify({ schemaVersion: 1, verdict: "APPROVED", summary: "approved", findings: [], evidence: ["inspected diff/tests"], notChecked: [] });
const revise = JSON.stringify({ schemaVersion: 1, verdict: "REVISE", summary: "change required", findings: [{ id: "F1", severity: "high", location: "app.txt:1", description: "defect", requiredVerification: "regression" }], evidence: ["inspected source"], notChecked: [] });

function repo(prefix = "harness-adaptive-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Harness"], { cwd: root });
  writeFileSync(join(root, "app.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  initProject(root);
  upsertReviewerProfile(root, { name: "claude", provider: "claude", model: "opus" });
  upsertReviewerProfile(root, { name: "codex", provider: "codex", model: "review" });
  upsertReviewerProfile(root, { name: "ag", provider: "antigravity", model: "gemini-review" });
  return root;
}

function ready(root: string, id: string, level: "LIGHT" | "FULL" = "LIGHT") {
  let task = createTask(id, id, level, "test");
  task = transitionTask(transitionTask(transitionTask(task, "READY_FOR_DEV"), "IN_PROGRESS"), "READY_FOR_REVIEW");
  beginActiveTask(root, task);
}

function configuredCandidates(root: string): ReviewerCandidate[] {
  return loadConfig(root).agents!.reviewers!.map((profile) => ({ name: profile.name, provider: profile.provider, model: profile.model }));
}

function sequentialDispatch(responses: Record<string, string>, calls: string[]) {
  return (_root: string, _prompt: ReviewPromptInput, candidates: ReviewerCandidate[]): ReviewDispatchResult => {
    const reviewer = candidates[0];
    const id = reviewer.name ?? `${reviewer.provider}/${reviewer.model}`;
    calls.push(id);
    const response = responses[id] ?? approved;
    return {
      reviewer,
      attempts: [{ reviewer }],
      result: { provider: reviewer.provider, success: true, sessionId: `${id}-session`, response, rawStdout: response, rawStderr: "", exitCode: 0 },
    };
  };
}

for (const required of [1, 2, 3] as const) {
  test(`ordered threshold lazily stops after ${required} approval(s)`, () => {
    const root = repo();
    try {
      setReviewLevelPolicy(root, "LIGHT", { approvalsRequired: required, maxReviewers: 3 });
      ready(root, `threshold-${required}`);
      const calls: string[] = [];
      const result = orchestrateReview(root, { kind: "final" }, configuredCandidates(root), {}, "", `r-${required}`, sequentialDispatch({}, calls));
      assert.deepEqual(calls, ["claude", "codex", "ag"].slice(0, required));
      assert.equal(result.approvalProgress?.approvals.length, required);
      assert.equal(result.approvalProgress?.approvalsRequired, required);
      assert.equal(loadActiveTask(root)?.status, "COMPLETED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("REVISE stops immediately and later source change invalidates prior reviewer approval", () => {
  const root = repo();
  try {
    setReviewLevelPolicy(root, "LIGHT", { approvalsRequired: 2, maxReviewers: 3 });
    ready(root, "revise-stop");
    const firstCalls: string[] = [];
    const first = orchestrateReview(root, { kind: "final" }, configuredCandidates(root), {}, "", "r-revise", sequentialDispatch({ codex: revise }, firstCalls));
    assert.deepEqual(firstCalls, ["claude", "codex"]);
    assert.equal(first.nextAction, "FIX");
    assert.equal(loadActiveTask(root)?.status, "IN_PROGRESS");
    assert.deepEqual(loadActiveTask(root)?.finalReview.approvals?.map((a) => a.reviewerId), ["claude"]);

    writeFileSync(join(root, "app.txt"), "fixed\n");
    let task = loadActiveTask(root)!;
    const stale = refreshStaleApprovals(root, task);
    assert.ok(stale.invalidated.includes("final:reviewer:claude"));
    assert.equal(stale.task.finalReview.approvals?.length ?? 0, 0);
    task = transitionTask(stale.task, "READY_FOR_REVIEW"); saveActiveTask(root, task);

    const secondCalls: string[] = [];
    const second = orchestrateReview(root, { kind: "final" }, configuredCandidates(root), {}, "", "r-recheck", sequentialDispatch({}, secondCalls));
    assert.deepEqual(secondCalls, ["claude", "codex"]);
    assert.equal(second.nextAction, "COMPLETED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("qualifying unavailable reviewer does not count as an approval slot and order continues", () => {
  const root = repo();
  try {
    setReviewLevelPolicy(root, "LIGHT", { approvalsRequired: 2, maxReviewers: 2 });
    ready(root, "fallback-threshold");
    const invocations: string[] = [];
    const dispatch = (_root: string, _prompt: ReviewPromptInput, candidates: ReviewerCandidate[]): ReviewDispatchResult => {
      invocations.push(candidates.map((c) => c.name).join(">"));
      if (invocations.length === 1) {
        const reviewer = candidates[1];
        return { reviewer, attempts: [{ reviewer: candidates[0], failureCode: "QUOTA_EXHAUSTED" }, { reviewer }], result: { provider: reviewer.provider, success: true, sessionId: "codex-s", response: approved, rawStdout: approved, rawStderr: "", exitCode: 0 } };
      }
      const reviewer = candidates[0];
      return { reviewer, attempts: [{ reviewer }], result: { provider: reviewer.provider, success: true, sessionId: "ag-s", response: approved, rawStdout: approved, rawStderr: "", exitCode: 0 } };
    };
    const result = orchestrateReview(root, { kind: "final" }, configuredCandidates(root), {}, "", "fallback", dispatch);
    assert.deepEqual(result.approvalProgress?.approvals, ["codex", "ag"]);
    assert.equal(result.approvalProgress?.completedReviews, 2);
    assert.equal(result.nextAction, "COMPLETED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task override can require more approvals than project LIGHT default", () => {
  const root = repo();
  try {
    setReviewLevelPolicy(root, "LIGHT", { approvalsRequired: 1, maxReviewers: 3 });
    let task = createTask("override", "override", "LIGHT", "test");
    task = setTaskReviewPolicyOverride(task, { approvalsRequired: 2, maxReviewers: 3 }, "user");
    assert.equal(effectiveReviewPolicy(loadConfig(root), task).approvalsRequired, 2);
    task = transitionTask(transitionTask(transitionTask(task, "READY_FOR_DEV"), "IN_PROGRESS"), "READY_FOR_REVIEW"); beginActiveTask(root, task);
    const calls: string[] = [];
    orchestrateReview(root, { kind: "final" }, configuredCandidates(root), {}, "", "override", sequentialDispatch({}, calls));
    assert.deepEqual(calls, ["claude", "codex"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("same provider/model reviewer profiles keep independent exact sessions and metrics identity", () => {
  const root = repo();
  try {
    const cfg = loadConfig(root); cfg.agents!.reviewers = [{ name: "codex-a", provider: "codex", model: "same" }, { name: "codex-b", provider: "codex", model: "same" }]; cfg.reviewPolicy!.levels.LIGHT = { approvalsRequired: 2, maxReviewers: 2 }; saveConfig(root, cfg);
    ready(root, "profile-sessions");
    let seq = 0;
    const adapter: AgentAdapter = { provider: "codex", executable: "fake", detect: () => ({ provider: "codex", executable: "fake", available: true }), buildCommand: () => ({ executable: "fake", args: [], cwd: root }), parseResult: () => { throw new Error("unused"); } };
    const dispatch = (r: string, prompt: ReviewPromptInput, candidates: ReviewerCandidate[], adapters: Record<string, AgentAdapter>, requestId = `test-${Date.now()}`) => dispatchReview(r, prompt, candidates, adapters, requestId, (_adapter, request): AgentTurnResult => {
      seq += 1; return { provider: "codex", success: true, sessionId: request.sessionId ?? `session-${seq}`, response: approved, rawStdout: approved, rawStderr: "", exitCode: 0 };
    });
    orchestrateReview(root, { kind: "final" }, configuredCandidates(root), { codex: adapter }, "", "profiles", dispatch);
    const sessions = loadSessionRegistry(root).tasks.find((t) => t.taskId === "profile-sessions")!.sessions;
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((s) => s.profileName), ["codex-a", "codex-b"]);
    assert.ok(sessions[0].sessionId !== sessions[1].sessionId);
    assert.deepEqual(loadTurnMetrics(root).filter((m) => m.purpose === "reviewer").map((m) => m.reviewerName), ["codex-a", "codex-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("reviewer order is project-local and can be changed without affecting another project", () => {
  const a = repo("harness-policy-a-");
  const b = repo("harness-policy-b-");
  try {
    reorderReviewerProfiles(a, ["codex", "claude", "ag"]);
    setReviewLevelPolicy(a, "FULL", { approvalsRequired: 2, maxReviewers: 3 });
    setReviewLevelPolicy(b, "FULL", { approvalsRequired: 1, maxReviewers: 2 });
    assert.deepEqual(loadConfig(a).agents!.reviewers!.map((p) => p.name), ["codex", "claude", "ag"]);
    assert.deepEqual(loadConfig(b).agents!.reviewers!.map((p) => p.name), ["claude", "codex", "ag"]);
    assert.equal(loadConfig(a).reviewPolicy!.levels.FULL.approvalsRequired, 2);
    assert.equal(loadConfig(b).reviewPolicy!.levels.FULL.approvalsRequired, 1);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});


test("Claude reviewer profile resumes the exact saved session on follow-up dispatch", () => {
  const root = repo();
  try {
    ready(root, "claude-resume");
    const candidate: ReviewerCandidate = { name: "claude", provider: "claude", model: "opus" };
    const adapter: AgentAdapter = { provider: "claude", executable: "claude", detect: () => ({ provider: "claude", executable: "claude", available: true }), buildCommand: () => ({ executable: "claude", args: [], cwd: root }), parseResult: () => { throw new Error("unused"); } };
    const seen: Array<string | undefined> = [];
    let call = 0;
    const execute = (_adapter: AgentAdapter, request: any): AgentTurnResult => {
      seen.push(request.sessionId);
      call += 1;
      return { provider: "claude", success: true, sessionId: call === 1 ? "claude-session-1" : request.sessionId, response: approved, rawStdout: approved, rawStderr: "", exitCode: 0 };
    };
    dispatchReview(root, "first", [candidate], { claude: adapter }, "claude-1", execute);
    dispatchReview(root, "follow-up", [candidate], { claude: adapter }, "claude-2", execute);
    assert.deepEqual(seen, [undefined, "claude-session-1"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical review gate rejects a candidate order that bypasses project reviewer configuration", () => {
  const root = repo();
  try {
    setReviewLevelPolicy(root, "LIGHT", { approvalsRequired: 1, maxReviewers: 3 });
    ready(root, "order-enforced");
    const wrong = [...configuredCandidates(root)].reverse();
    assert.throws(
      () => orchestrateReview(root, { kind: "final" }, wrong, {}, "", "order-bypass", sequentialDispatch({}, [])),
      (error: any) => error?.code === "REVIEWER_POLICY_MISMATCH",
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
