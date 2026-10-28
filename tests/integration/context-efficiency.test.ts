import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../../src/installer/install.js";
import { createTask } from "../../src/core/task.js";
import { saveActiveTask } from "../../src/core/store.js";
import { transitionTask } from "../../src/core/state-machine.js";
import { registerSession, loadSessionRegistry, saveSessionRegistry, findSession } from "../../src/agents/session-registry.js";
import { compileDeveloperPrompt, compileReviewerPrompt } from "../../src/prompts/plans.js";
import { compactSessionContext, contextStatus } from "../../src/prompts/context.js";
import { dispatchDeveloper } from "../../src/agents/developer-dispatcher.js";
import type { AgentAdapter, AgentRequest } from "../../src/agents/types.js";
import { inspectGit } from "../../src/git/git.js";
import { acquireRunLease, loadRunLease, releaseRunLease } from "../../src/runtime/run-lease.js";
import { CodexAdapter } from "../../src/agents/codex.js";
import { AntigravityAdapter } from "../../src/agents/antigravity.js";
import { loadTurnMetrics, recordTurnMetric, summarizeMetrics } from "../../src/metrics/store.js";

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "harness-v06-"));
  initProject(r);
  return r;
}

function inProgressTask(id = "ctx") {
  return transitionTask(transitionTask(createTask(id, "Context task", "LIGHT", "small"), "READY_FOR_DEV"), "IN_PROGRESS");
}

test("prompt compiler keeps stable prefix while follow-up omits repeated task context", () => {
  const r = root();
  try {
    const task = inProgressTask();
    task.acceptance.push({ id: "A1", description: "observable behavior" });
    saveActiveTask(r, task);
    const initial = compileDeveloperPrompt(r, task, { kind: "final" }, ["test"], "antigravity", "m");
    const registry = loadSessionRegistry(r);
    const session = registerSession(registry, task.id, { provider: "antigravity", purpose: "developer", model: "m", sessionId: "s1", workspace: r });
    saveSessionRegistry(r, registry);
    const follow = compileDeveloperPrompt(r, task, { kind: "final" }, ["test"], "antigravity", "m", session);
    assert.equal(initial.meta.stablePrefixHash, follow.meta.stablePrefixHash);
    assert.equal(initial.meta.mode, "INITIAL");
    assert.equal(follow.meta.reusedSession, true);
    assert.ok(follow.meta.estimatedInputTokens < initial.meta.estimatedInputTokens);
    assert.ok(!follow.text.includes("Acceptance criteria:"));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("review prompt is full for a new fallback reviewer and delta-oriented for a resumed reviewer", () => {
  const r = root();
  try {
    let task = inProgressTask("review-context");
    task = transitionTask(task, "READY_FOR_REVIEW");
    task.acceptance.push({ id: "A1", description: "must hold" });
    saveActiveTask(r, task);
    const snap = inspectGit(r);
    const full = compileReviewerPrompt(r, task, { kind: "final" }, snap, "", "codex", "m");
    const registry = loadSessionRegistry(r);
    const session = registerSession(registry, task.id, { provider: "codex", purpose: "reviewer", model: "m", sessionId: "cx1", workspace: r });
    const delta = compileReviewerPrompt(r, task, { kind: "final" }, snap, "", "codex", "m", session);
    assert.equal(full.meta.stablePrefixHash, delta.meta.stablePrefixHash);
    assert.ok(full.text.includes("Acceptance criteria:"));
    assert.ok(!delta.text.includes("Acceptance criteria:"));
    assert.equal(delta.meta.reusedSession, true);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("explicit context compaction rotates session on the next turn without silent replacement", () => {
  const r = root();
  try {
    const task = inProgressTask("rotate"); saveActiveTask(r, task);
    const registry = loadSessionRegistry(r);
    registerSession(registry, task.id, { provider: "antigravity", purpose: "developer", model: "m", sessionId: "old-session", workspace: r });
    saveSessionRegistry(r, registry);
    const compacted = compactSessionContext(r, "developer", "antigravity", "m");
    assert.ok(compacted.summaryPath.includes(".harness/handoff/rotate/context/"));
    const sessionBefore = findSession(loadSessionRegistry(r), task.id, "antigravity", "m", "developer")!;
    assert.equal(Boolean(sessionBefore.rotation), true);
    const prompt = compileDeveloperPrompt(r, task, { kind: "final" }, ["test"], "antigravity", "m", sessionBefore);
    assert.equal(prompt.meta.mode, "COMPACTION_RESUME");
    assert.ok(prompt.text.includes("compact session handoff"));

    const seen: AgentRequest[] = [];
    const adapter = { provider: "antigravity", executable: "agy", detect: () => ({ provider: "antigravity", executable: "agy", available: true }), buildCommand: () => ({ executable: "agy", args: [], cwd: r }), parseResult: () => { throw new Error("unused"); }, supportsPurpose: () => true } as AgentAdapter;
    const result = dispatchDeveloper(r, prompt, "antigravity", "m", adapter, "rotate-turn", (_adapter, request) => {
      seen.push(request);
      return { provider: "antigravity", success: true, sessionId: "new-session", response: "done", rawStdout: "", rawStderr: "", exitCode: 0 };
    });
    assert.equal(result.success, true);
    assert.equal(seen[0].sessionId, undefined);
    const sessionAfter = findSession(loadSessionRegistry(r), task.id, "antigravity", "m", "developer")!;
    assert.equal(sessionAfter.sessionId, "new-session");
    assert.equal(sessionAfter.previousSessionIds?.[0]?.sessionId, "old-session");
    assert.equal(Boolean(sessionAfter.rotation), false);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("run lease rejects concurrent orchestrators and reclaims a dead stale lease", () => {
  const r = root();
  try {
    const lease = acquireRunLease(r, "t1");
    assert.throws(() => acquireRunLease(r, "t1"), (err: any) => err?.code === "RUN_LEASE_HELD");
    releaseRunLease(r, lease);
    const dir = join(r, ".harness", "state", "run-lease");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lease.json"), JSON.stringify({ schemaVersion: 1, taskId: "old", pid: 99999999, acquiredAt: "2026-01-01T00:00:00Z" }));
    const reclaimed = acquireRunLease(r, "t2");
    assert.equal(reclaimed.taskId, "t2");
    assert.equal(loadRunLease(r)?.pid, process.pid);
    releaseRunLease(r, reclaimed);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("provider usage telemetry is recorded only when provider output exposes usage", () => {
  const codex = new CodexAdapter("codex");
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "cx" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60, total_tokens: 120 } }),
  ].join("\n");
  const parsed = codex.parseResult(stdout, "", 0);
  assert.equal(parsed.usage?.inputTokens, 100);
  assert.equal(parsed.usage?.cachedInputTokens, 60);
  const ag = new AntigravityAdapter("agy").parseResult(JSON.stringify({ status: "SUCCESS", conversation_id: "ag", response: "ok", usage: { prompt_tokens: 50, completion_tokens: 10 } }), "", 0);
  assert.equal(ag.usage?.inputTokens, 50);
  assert.equal(ag.usage?.outputTokens, 10);
});

test("metrics distinguish provider-reported usage from local prompt estimates", () => {
  const r = root();
  try {
    recordTurnMetric(r, { taskId: "t", requestId: "r1", provider: "codex", purpose: "reviewer", model: "m", success: true, prompt: { taskId: "t", purpose: "reviewer", provider: "codex", model: "m", mode: "INITIAL", target: "final", reusedSession: false, stablePrefixHash: "a", promptHash: "b", estimatedInputTokens: 80, sections: ["stable-prefix"] }, usage: { source: "provider", inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 }, responseChars: 20 });
    recordTurnMetric(r, { taskId: "t", requestId: "r2", provider: "codex", purpose: "reviewer", model: "m", success: true, prompt: { taskId: "t", purpose: "reviewer", provider: "codex", model: "m", mode: "FOLLOW_UP", target: "final", reusedSession: true, stablePrefixHash: "a", promptHash: "c", estimatedInputTokens: 20, sections: ["stable-prefix", "round-delta"] }, responseChars: 10 });
    const summary = summarizeMetrics(loadTurnMetrics(r));
    assert.equal(summary.turns, 2);
    assert.equal(summary.providerReportedTurns, 1);
    assert.equal(summary.inputTokens, 100);
    assert.equal(summary.cachedInputTokens, 60);
    assert.equal(summary.estimatedPromptTokens, 100);
    assert.equal(summary.sessionReuseTurns, 1);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("context status recommends explicit compaction at configured estimate", () => {
  const r = root();
  try {
    const task = inProgressTask("budget"); saveActiveTask(r, task);
    const registry = loadSessionRegistry(r); registerSession(registry, task.id, { provider: "antigravity", purpose: "developer", model: "m", sessionId: "s", workspace: r }); saveSessionRegistry(r, registry);
    recordTurnMetric(r, { taskId: task.id, requestId: "r", provider: "antigravity", purpose: "developer", model: "m", sessionId: "s", success: true, prompt: { taskId: task.id, purpose: "developer", provider: "antigravity", model: "m", mode: "INITIAL", target: "final", reusedSession: false, stablePrefixHash: "a", promptHash: "b", estimatedInputTokens: 101, sections: ["stable-prefix"] }, responseChars: 1 });
    const status = contextStatus(r, 100);
    assert.equal(status[0].compactionRecommended, true);

    compactSessionContext(r, "developer", "antigravity", "m");
    const adapter = { provider: "antigravity", executable: "agy", detect: () => ({ provider: "antigravity", executable: "agy", available: true }), buildCommand: () => ({ executable: "agy", args: [], cwd: r }), parseResult: () => { throw new Error("unused"); }, supportsPurpose: () => true } as AgentAdapter;
    const sessionBefore = findSession(loadSessionRegistry(r), task.id, "antigravity", "m", "developer")!;
    const prompt = compileDeveloperPrompt(r, task, { kind: "final" }, ["test"], "antigravity", "m", sessionBefore);
    dispatchDeveloper(r, prompt, "antigravity", "m", adapter, "post-rotate", () => ({
      provider: "antigravity",
      success: true,
      sessionId: "s-rotated",
      response: "done",
      rawStdout: "",
      rawStderr: "",
      exitCode: 0,
    }));
    const afterRotation = contextStatus(r, 1000);
    assert.equal(afterRotation[0].sessionId, "s-rotated");
    assert.equal(afterRotation[0].turns, 1);
    assert.equal(afterRotation[0].compactionRecommended, false);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("run lease never deletes an existing malformed canonical lock", () => {
  const r = root();
  try {
    const dir = join(r, ".harness", "state", "run-lease");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "lease.json");
    writeFileSync(path, "{partial");
    assert.throws(() => acquireRunLease(r, "contender"), (err: any) => err?.code === "RUN_LEASE_RACE");
    assert.equal(existsSync(path), true);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
