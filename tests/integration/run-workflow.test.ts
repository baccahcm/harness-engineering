import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { initProject } from "../../src/installer/install.js";
import { loadConfig, saveConfig } from "../../src/core/config.js";
import { addCheckpoint, createTask, setCheckpointScope } from "../../src/core/task.js";
import { saveActiveTask, loadActiveTask } from "../../src/core/store.js";
import { transitionTask } from "../../src/core/state-machine.js";
import { runWorkflow } from "../../src/orchestration/run.js";
import { orchestrateReview } from "../../src/review/orchestrator.js";
import type { ReviewDispatchResult } from "../../src/review/dispatcher.js";
import type { AgentAdapter } from "../../src/agents/types.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-run-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "a0\n");
  writeFileSync(join(root, "src", "b.ts"), "b0\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  initProject(root);
  const cfg = loadConfig(root);
  cfg.verification = { unit: 'node -e "process.exit(0)"' };
  cfg.agents = {
    developer: { provider: "antigravity", model: "dev-model" },
    reviewers: [{ name: "primary", provider: "codex", model: "review-model" }],
  };
  cfg.orchestration = { maxReviewRounds: 3, verificationKeys: ["unit"] };
  saveConfig(root, cfg);
  return root;
}

const approved = JSON.stringify({ schemaVersion: 1, verdict: "APPROVED", summary: "approved", findings: [], evidence: ["source and verification inspected"], notChecked: [] });
const revise = JSON.stringify({ schemaVersion: 1, verdict: "REVISE", summary: "fix required", findings: [{ id: "F1", severity: "medium", location: "src/a.ts:1", description: "needs correction", requiredVerification: "unit" }], evidence: ["source inspected"], notChecked: [] });

function dispatch(response: string): ReviewDispatchResult {
  return {
    reviewer: { provider: "codex", model: "review-model" },
    attempts: [{ reviewer: { provider: "codex", model: "review-model" } }],
    result: { provider: "codex", success: true, sessionId: "review-session", response, rawStdout: response, rawStderr: "", exitCode: 0 },
  };
}

const adapters = {
  antigravity: { provider: "antigravity", executable: "agy" } as AgentAdapter,
  codex: { provider: "codex", executable: "codex" } as AgentAdapter,
};

test("harness run completes LIGHT developer -> verification -> review", () => {
  const root = repo();
  try {
    saveActiveTask(root, transitionTask(createTask("light-run", "Light run", "LIGHT", "small"), "READY_FOR_DEV"));
    let turns = 0;
    const result = runWorkflow(root, {}, {
      adapters,
      develop: ((workspace: string) => {
        turns += 1;
        writeFileSync(join(workspace, "src", "a.ts"), `a${turns}\n`);
        return { provider: "antigravity", success: true, sessionId: "dev-session", response: "implemented", rawStdout: "", rawStderr: "", exitCode: 0 };
      }) as any,
      review: ((...args: any[]) => orchestrateReview(args[0], args[1], args[2], args[3], args[4], `review-${Date.now()}`, () => dispatch(approved))) as any,
    });
    assert.equal(result.task.status, "COMPLETED");
    assert.equal(turns, 1);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.reviews.length, 1);
    assert.equal(result.runState.status, "completed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("harness run follows REVISE -> FIX -> RECHECK automatically", () => {
  const root = repo();
  try {
    saveActiveTask(root, transitionTask(createTask("fix-run", "Fix run", "LIGHT", "small"), "READY_FOR_DEV"));
    let turns = 0;
    let reviews = 0;
    const result = runWorkflow(root, {}, {
      adapters,
      develop: ((workspace: string) => {
        turns += 1;
        writeFileSync(join(workspace, "src", "a.ts"), `round-${turns}\n`);
        return { provider: "antigravity", success: true, sessionId: "dev-session", response: "implemented", rawStdout: "", rawStderr: "", exitCode: 0 };
      }) as any,
      review: ((...args: any[]) => {
        reviews += 1;
        return orchestrateReview(args[0], args[1], args[2], args[3], args[4], `review-${reviews}`, () => dispatch(reviews === 1 ? revise : approved));
      }) as any,
    });
    assert.equal(result.task.status, "COMPLETED");
    assert.equal(turns, 2);
    assert.equal(reviews, 2);
    assert.ok(readFileSync(join(root, ".harness", "state", "run-state.json"), "utf8").includes('"status": "completed"'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("FULL harness run preserves C1 approval while C2 changes unrelated scope and reaches final", () => {
  const root = repo();
  try {
    let task = addCheckpoint(createTask("full-run", "Full run", "FULL", "cross component"), "C1");
    task = setCheckpointScope(task, "C1", { include: ["src/a.ts"] });
    task = addCheckpoint(task, "C2");
    task = setCheckpointScope(task, "C2", { include: ["src/b.ts"] });
    task = transitionTask(task, "READY_FOR_DEV");
    saveActiveTask(root, task);
    let turns = 0;
    let reviewSeq = 0;
    const result = runWorkflow(root, {}, {
      adapters,
      develop: ((workspace: string) => {
        const current = loadActiveTask(workspace)!;
        turns += 1;
        if (current.activeCheckpointId === "C1") writeFileSync(join(workspace, "src", "a.ts"), `a${turns}\n`);
        else if (current.activeCheckpointId === "C2") writeFileSync(join(workspace, "src", "b.ts"), `b${turns}\n`);
        return { provider: "antigravity", success: true, sessionId: "dev-session", response: "implemented", rawStdout: "", rawStderr: "", exitCode: 0 };
      }) as any,
      review: ((...args: any[]) => { reviewSeq += 1; return orchestrateReview(args[0], args[1], args[2], args[3], args[4], `review-${reviewSeq}`, () => dispatch(approved)); }) as any,
    });
    assert.equal(result.task.status, "COMPLETED");
    assert.equal(turns, 2);
    assert.equal(result.reviews.length, 3);
    assert.equal(result.task.checkpoints[0].verdict, "APPROVED");
    assert.equal(result.task.checkpoints[1].verdict, "APPROVED");
    assert.equal(result.task.finalReview.verdict, "APPROVED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("automated FULL run refuses an unscoped pending checkpoint", () => {
  const root = repo();
  try {
    let task = addCheckpoint(createTask("missing-scope", "Missing scope", "FULL", "full"), "C1");
    task = transitionTask(task, "READY_FOR_DEV");
    saveActiveTask(root, task);
    assert.throws(() => runWorkflow(root, {}, {
      adapters,
      develop: (() => ({ provider: "antigravity", success: true, sessionId: "dev", response: "ok", rawStdout: "", rawStderr: "", exitCode: 0 })) as any,
    }), (err: any) => err?.code === "CHECKPOINT_SCOPE_MISSING");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
