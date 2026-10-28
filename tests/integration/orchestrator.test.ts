import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { addCheckpoint, createTask } from "../../src/core/task.js";
import { saveActiveTask, loadActiveTask } from "../../src/core/store.js";
import { transitionTask } from "../../src/core/state-machine.js";
import { orchestrateReview } from "../../src/review/orchestrator.js";
import type { ReviewDispatchResult } from "../../src/review/dispatcher.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-orch-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "app.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  mkdirSync(join(root, ".harness", "state"), { recursive: true });
  return root;
}

function ready(task: ReturnType<typeof createTask>) {
  return transitionTask(transitionTask(transitionTask(task, "READY_FOR_DEV"), "IN_PROGRESS"), "READY_FOR_REVIEW");
}

function fakeDispatch(response: string): ReviewDispatchResult {
  return {
    reviewer: { provider: "codex", model: "review-model" },
    attempts: [{ reviewer: { provider: "codex", model: "review-model" } }],
    result: { provider: "codex", success: true, sessionId: "thread-1", response, rawStdout: response, rawStderr: "", exitCode: 0 },
  };
}

const approved = JSON.stringify({ schemaVersion: 1, verdict: "APPROVED", summary: "meets criteria", findings: [], evidence: ["inspected diff and tests"], notChecked: ["production"] });
const revise = JSON.stringify({ schemaVersion: 1, verdict: "REVISE", summary: "bug found", findings: [{ id: "F1", severity: "high", location: "app.txt:1", description: "wrong behavior", requiredVerification: "regression test" }], evidence: ["inspected app.txt"], notChecked: [] });

test("LIGHT approval is bound, recorded and completes task", () => {
  const root = repo();
  try {
    saveActiveTask(root, ready(createTask("light", "Light", "LIGHT", "small")));
    const result = orchestrateReview(root, { kind: "final" }, [{ provider: "codex", model: "review-model" }], {}, "", "r1", () => fakeDispatch(approved));
    assert.equal(result.nextAction, "COMPLETED");
    assert.equal(loadActiveTask(root)?.status, "COMPLETED");
    assert.equal(loadActiveTask(root)?.finalReview.verdict, "APPROVED");
    assert.ok(existsSync(join(root, ".harness", "handoff", "light", "reviews", "review-01.json")));
    const saved = JSON.parse(readFileSync(join(root, ".harness", "handoff", "light", "reviews", "review-01.json"), "utf8"));
    assert.equal(saved.reviewer.sessionId, "thread-1");
    assert.ok(saved.sourceFingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("REVISE records finding and returns task to IN_PROGRESS", () => {
  const root = repo();
  try {
    saveActiveTask(root, ready(createTask("revise", "Revise", "LIGHT", "small")));
    const result = orchestrateReview(root, { kind: "final" }, [{ provider: "codex", model: "review-model" }], {}, "", "r2", () => fakeDispatch(revise));
    assert.equal(result.nextAction, "FIX");
    assert.equal(loadActiveTask(root)?.status, "IN_PROGRESS");
    assert.equal(loadActiveTask(root)?.finalReview.verdict, "REVISE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FULL checkpoint approval advances to final gate, then final approval completes", () => {
  const root = repo();
  try {
    let task = addCheckpoint(createTask("full", "Full", "FULL", "security"), "C1");
    saveActiveTask(root, ready(task));
    const checkpoint = orchestrateReview(root, { kind: "checkpoint", checkpointId: "C1" }, [{ provider: "codex", model: "review-model" }], {}, "", "r3", () => fakeDispatch(approved));
    assert.equal(checkpoint.nextAction, "FINAL_REVIEW");
    assert.equal(loadActiveTask(root)?.status, "IN_PROGRESS");
    task = transitionTask(loadActiveTask(root)!, "READY_FOR_REVIEW");
    saveActiveTask(root, task);
    const final = orchestrateReview(root, { kind: "final" }, [{ provider: "codex", model: "review-model" }], {}, "", "r4", () => fakeDispatch(approved));
    assert.equal(final.nextAction, "COMPLETED");
    assert.equal(loadActiveTask(root)?.status, "COMPLETED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FULL final gate is blocked while checkpoint remains pending", () => {
  const root = repo();
  try {
    const task = addCheckpoint(createTask("full2", "Full2", "FULL", "security"), "C1");
    saveActiveTask(root, ready(task));
    assert.throws(() => orchestrateReview(root, { kind: "final" }, [{ provider: "codex", model: "review-model" }], {}, "", "r5", () => fakeDispatch(approved)), /P012/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verdict is not recorded if source changes during read-only review", () => {
  const root = repo();
  try {
    saveActiveTask(root, ready(createTask("mutated", "Mutated", "LIGHT", "small")));
    assert.throws(() => orchestrateReview(root, { kind: "final" }, [{ provider: "codex", model: "review-model" }], {}, "", "r6", () => {
      writeFileSync(join(root, "app.txt"), "mutated by reviewer\n");
      return fakeDispatch(approved);
    }), (err: any) => err?.code === "SOURCE_CHANGED_DURING_REVIEW");
    assert.equal(loadActiveTask(root)?.finalReview.verdict, "PENDING");
    assert.equal(existsSync(join(root, ".harness", "handoff", "mutated", "reviews", "review-01.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
