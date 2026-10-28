import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { inspectGit } from "../../src/git/git.js";
import { addCheckpoint, activateCheckpoint, createTask, setCheckpointScope } from "../../src/core/task.js";
import { applyReviewVerdict, transitionTask } from "../../src/core/state-machine.js";
import { refreshStaleApprovals } from "../../src/review/staleness.js";
import { saveActiveTask } from "../../src/core/store.js";
import { dispatchDeveloper } from "../../src/agents/developer-dispatcher.js";
import type { AgentAdapter } from "../../src/agents/types.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-scope-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "a0\n");
  writeFileSync(join(root, "src", "b.ts"), "b0\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  mkdirSync(join(root, ".harness", "state"), { recursive: true });
  return root;
}

test("scoped fingerprint ignores unrelated changes and changes for owned files", () => {
  const root = repo();
  try {
    const scope = { include: ["src/a.ts"] };
    const initial = inspectGit(root, scope).fingerprint;
    writeFileSync(join(root, "src", "b.ts"), "b1\n");
    assert.equal(inspectGit(root, scope).fingerprint, initial);
    writeFileSync(join(root, "src", "a.ts"), "a1\n");
    assert.ok(inspectGit(root, scope).fingerprint !== initial);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only affected checkpoint approval becomes stale", () => {
  const root = repo();
  try {
    let task = addCheckpoint(createTask("scoped", "Scoped", "FULL", "multi area"), "C1");
    task = setCheckpointScope(task, "C1", { include: ["src/a.ts"] });
    task = transitionTask(transitionTask(transitionTask(task, "READY_FOR_DEV"), "IN_PROGRESS"), "READY_FOR_REVIEW");
    task = applyReviewVerdict(task, "reviewer", "APPROVED", "C1", inspectGit(root, { include: ["src/a.ts"] }).fingerprint);
    writeFileSync(join(root, "src", "b.ts"), "b1\n");
    let refreshed = refreshStaleApprovals(root, task);
    assert.deepEqual(refreshed.invalidated, []);
    assert.equal(refreshed.task.checkpoints[0].verdict, "APPROVED");
    writeFileSync(join(root, "src", "a.ts"), "a1\n");
    refreshed = refreshStaleApprovals(root, task);
    assert.deepEqual(refreshed.invalidated, ["checkpoint:C1"]);
    assert.equal(refreshed.task.checkpoints[0].verdict, "PENDING");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("developer turn is rejected when it changes files outside active checkpoint scope", () => {
  const root = repo();
  try {
    let task = addCheckpoint(createTask("ownership", "Ownership", "FULL", "scoped"), "C1");
    task = setCheckpointScope(task, "C1", { include: ["src/a.ts"] });
    task = activateCheckpoint(task, "C1");
    task = transitionTask(transitionTask(task, "READY_FOR_DEV"), "IN_PROGRESS");
    saveActiveTask(root, task);
    const adapter = { provider: "antigravity", executable: "agy" } as AgentAdapter;
    const result = dispatchDeveloper(root, "implement", "antigravity", "dev-model", adapter, "r1", () => {
      writeFileSync(join(root, "src", "b.ts"), "out of scope\n");
      return { provider: "antigravity", success: true, sessionId: "dev-1", response: "done", rawStdout: "", rawStderr: "", exitCode: 0 };
    });
    assert.equal(result.success, false);
    assert.equal(result.failureCode, "OUT_OF_SCOPE_CHANGE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unscoped fingerprint distinguishes large (>1 MB) tracked file modifications and non-ASCII filenames", () => {
  const root = repo();
  try {
    const bigA = `${"a".repeat(1_250_000)}\n`;
    const bigB = `${"b".repeat(1_250_000)}\n`;
    writeFileSync(join(root, "src", "a.ts"), bigA);
    const fpA = inspectGit(root).fingerprint;
    writeFileSync(join(root, "src", "a.ts"), bigB);
    const fpB = inspectGit(root).fingerprint;
    assert.ok(fpA !== fpB);

    const unicodeFile = "caf\u00e9.txt";
    writeFileSync(join(root, unicodeFile), " roast-1\n");
    execFileSync("git", ["add", unicodeFile], { cwd: root });
    execFileSync("git", ["commit", "-m", "add cafe"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, unicodeFile), "roast-2\n");
    const snap1 = inspectGit(root);
    assert.ok(snap1.changedFiles.includes(unicodeFile));
    writeFileSync(join(root, unicodeFile), "roast-3\n");
    const snap2 = inspectGit(root);
    assert.ok(snap1.fingerprint !== snap2.fingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("manual checkpoint REVISE sets activeCheckpointId and scope update preserves requiredRecheck", async () => {
  const { orchestrateReview } = await import("../../src/review/orchestrator.js");
  const { loadActiveTask } = await import("../../src/core/store.js");
  const root = repo();
  try {
    let task = addCheckpoint(createTask("manual-revise", "Manual Revise", "FULL", "scoped"), "C1");
    task = setCheckpointScope(task, "C1", { include: ["src/a.ts"] });
    task = transitionTask(transitionTask(transitionTask(task, "READY_FOR_DEV"), "IN_PROGRESS"), "READY_FOR_REVIEW");
    saveActiveTask(root, task);
    const reviseJson = JSON.stringify({
      schemaVersion: 1,
      verdict: "REVISE",
      summary: "fix C1",
      findings: [{ id: "F1", severity: "high", location: "src/a.ts:1", description: "bad", requiredVerification: "test" }],
      evidence: ["checked src/a.ts"],
      notChecked: [],
    });
    orchestrateReview(root, { kind: "checkpoint", checkpointId: "C1" }, [{ provider: "codex", model: "review-model" }], {}, "", "rev-c1", () => ({
      reviewer: { provider: "codex", model: "review-model" },
      attempts: [{ reviewer: { provider: "codex", model: "review-model" } }],
      result: { provider: "codex", success: true, sessionId: "rev-s1", response: reviseJson, rawStdout: reviseJson, rawStderr: "", exitCode: 0 },
    }));
    const afterRevise = loadActiveTask(root)!;
    assert.equal(afterRevise.activeCheckpointId, "C1");
    assert.equal(afterRevise.checkpoints[0].requiredRecheck?.sessionId, "rev-s1");

    const rescoped = setCheckpointScope(afterRevise, "C1", { include: ["src/a.ts", "src/extra.ts"] });
    assert.equal(rescoped.checkpoints[0].requiredRecheck?.sessionId, "rev-s1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
