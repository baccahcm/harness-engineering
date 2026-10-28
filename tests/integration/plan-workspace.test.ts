import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject, upgradeProject } from "../../src/installer/install.js";
import { importPlan } from "../../src/plans/analyzer.js";
import { approvePlan, materializePlanTask, runPlan } from "../../src/plans/orchestrator.js";
import { loadActivePlan, savePlanManifest } from "../../src/plans/store.js";
import { archiveActiveTask, loadActiveTask, saveActiveTask } from "../../src/core/store.js";
import { runEvidenceCommand } from "../../src/evidence/runner.js";
import { loadSessionRegistry, registerSession, saveSessionRegistry, sessionRegistryPath } from "../../src/agents/session-registry.js";
import { recordReview, loadReviewIndex } from "../../src/review/artifacts.js";
import { saveRunState } from "../../src/orchestration/run-state.js";
import { emitHarnessEvent, eventsPath } from "../../src/events/bus.js";
import { metricsPath, recordTurnMetric } from "../../src/metrics/store.js";
import { planTaskRoot, planExecutionRoot, planWorkspaceRoot } from "../../src/plans/workspace.js";
import { loadConfig, saveConfig } from "../../src/core/config.js";
import { stringifyYaml } from "../../src/util/yaml.js";

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "harness-plan-workspace-"));
  initProject(r);
  writeFileSync(join(r, "PLAN.md"), "# Plan\nImplement shared task.\n");
  const cfg = loadConfig(r); cfg.verification = { unit: 'node -e "process.exit(0)"' }; saveConfig(r, cfg);
  return r;
}

function response(title = "Logical workspace", taskId = "shared-task"): string {
  return JSON.stringify({ title, summary: "One task", tasks: [{ id: taskId, title: "Shared", objective: "Implement shared task", reviewLevel: "LIGHT", reviewReason: "isolated behavior", acceptance: [{ id: "A1", description: "Behavior is implemented" }], checkpoints: [], dependsOn: [], verificationKeys: ["unit"] }] });
}

test("plan task artifacts are canonical inside a self-contained logical workspace", async () => {
  const r = root();
  try {
    const manifest = await importPlan(r, "PLAN.md", { id: "plan-a", planner: { provider: "codex", model: "planner" }, responseOverride: response() });
    const approved = approvePlan(r); const task = materializePlanTask(r, approved, approved.tasks[0]);
    const base = planTaskRoot(r, manifest.id, task.id);
    assert.ok(existsSync(join(base, "state.yaml")));
    assert.equal(sessionRegistryPath(r), join(base, "sessions.yaml"));
    const registry = loadSessionRegistry(r); registerSession(registry, task.id, { provider: "claude", purpose: "reviewer", model: "review", profileName: "claude", sessionId: "s1", workspace: r }); saveSessionRegistry(r, registry);
    runEvidenceCommand(r, 'node -e "process.exit(0)"');
    recordTurnMetric(r, { taskId: task.id, requestId: "m1", provider: "claude", purpose: "reviewer", model: "review", reviewerName: "claude", success: true, responseChars: 2 });
    recordReview(r, { taskId: task.id, target: { kind: "final" }, reviewer: { name: "claude", provider: "claude", model: "review", sessionId: "s1" }, sourceFingerprint: "fp", result: { schemaVersion: 1, verdict: "APPROVED", summary: "ok", findings: [], evidence: ["unit"], notChecked: [] }, rawResponse: "{}" });
    saveRunState(r, { taskId: task.id, status: "running", phase: "REVIEW", round: 1 });
    emitHarnessEvent(r, "run.phase", { phase: "REVIEW" }, { taskId: task.id });
    assert.ok(existsSync(join(base, "sessions.yaml")));
    assert.ok(existsSync(join(base, "evidence", "index.json")));
    assert.ok(existsSync(join(base, "metrics", "turns.jsonl")));
    assert.ok(existsSync(join(base, "reviews", "index.json")));
    assert.ok(existsSync(join(planExecutionRoot(r, manifest.id), "run-state.json")));
    assert.equal(eventsPath(r), join(planExecutionRoot(r, manifest.id), "events.jsonl"));
    assert.ok(existsSync(join(planWorkspaceRoot(r, manifest.id), "source.json")));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("same task id in separate plans keeps review/session/evidence namespaces independent", async () => {
  const r = root();
  try {
    let first = await importPlan(r, "PLAN.md", { id: "plan-one", planner: { provider: "codex", model: "planner" }, responseOverride: response("One") }); first = approvePlan(r); let task = materializePlanTask(r, first, first.tasks[0]);
    recordReview(r, { taskId: task.id, target: { kind: "final" }, reviewer: { provider: "claude", model: "review", sessionId: "p1" }, sourceFingerprint: "one", result: { schemaVersion: 1, verdict: "APPROVED", summary: "one", findings: [], evidence: ["e1"], notChecked: [] }, rawResponse: "{}" });
    saveActiveTask(r, { ...task, status: "COMPLETED" }); archiveActiveTask(r); first.status = "COMPLETED"; first.tasks[0].status = "COMPLETED"; savePlanManifest(r, first);
    writeFileSync(join(r, "PLAN.md"), "# Plan two\nImplement same task id differently.\n");
    let second = await importPlan(r, "PLAN.md", { id: "plan-two", planner: { provider: "codex", model: "planner" }, responseOverride: response("Two") }); second = approvePlan(r); task = materializePlanTask(r, second, second.tasks[0]);
    assert.equal(loadReviewIndex(r, task.id).reviews.length, 0);
    recordReview(r, { taskId: task.id, target: { kind: "final" }, reviewer: { provider: "codex", model: "review", sessionId: "p2" }, sourceFingerprint: "two", result: { schemaVersion: 1, verdict: "APPROVED", summary: "two", findings: [], evidence: ["e2"], notChecked: [] }, rawResponse: "{}" });
    assert.equal(JSON.parse(readFileSync(join(planTaskRoot(r, "plan-one", task.id), "reviews", "index.json"), "utf8")).reviews[0].reviewer.sessionId, "p1");
    assert.equal(JSON.parse(readFileSync(join(planTaskRoot(r, "plan-two", task.id), "reviews", "index.json"), "utf8")).reviews[0].reviewer.sessionId, "p2");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("V0.8.2 upgrade migrates task-addressable legacy artifacts without deleting ambiguous evidence", async () => {
  const r = root();
  try {
    const manifest = await importPlan(r, "PLAN.md", { id: "legacy-plan", planner: { provider: "codex", model: "planner" }, responseOverride: response("Legacy", "legacy-task") });
    const cfg = loadConfig(r); cfg.harness.version = "0.8.2"; saveConfig(r, cfg);
    const task = { id: "legacy-task", title: "Legacy", status: "IN_PROGRESS", review: { level: "LIGHT", reason: "legacy", selectedBy: "user" }, acceptance: [], checkpoints: [], finalReview: { verdict: "PENDING" }, plan: { manifestId: manifest.id, sourcePath: manifest.source.path, sourceSha256: manifest.source.sha256, taskSpecId: "legacy-task", executionOrder: 1 } } as any;
    mkdirSync(join(r, ".harness", "state"), { recursive: true }); writeFileSync(join(r, ".harness", "state", "active-task.yaml"), `${stringifyYaml(task)}\n`);
    mkdirSync(join(r, ".harness", "handoff", "legacy-task", "reviews"), { recursive: true }); writeFileSync(join(r, ".harness", "handoff", "legacy-task", "reviews", "index.json"), '{"schemaVersion":1,"reviews":[]}\n');
    mkdirSync(join(r, ".harness", "evidence"), { recursive: true }); writeFileSync(join(r, ".harness", "evidence", "index.json"), '{"schemaVersion":1,"runs":[]}\n');
    const result = upgradeProject(r, "0.8.3");
    assert.equal(result.toVersion, "0.8.3");
    assert.ok(existsSync(join(planTaskRoot(r, manifest.id, "legacy-task"), "state.yaml")));
    assert.ok(existsSync(join(planTaskRoot(r, manifest.id, "legacy-task"), "reviews", "index.json")));
    assert.ok(existsSync(join(r, ".harness", "evidence", "index.json")));
    assert.ok(result.notes.some((note) => note.includes("Legacy global evidence")));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("completed plan writes a plan-level archive summary", async () => {
  const r = root();
  try {
    await importPlan(r, "PLAN.md", { id: "complete-plan", planner: { provider: "codex", model: "planner" }, responseOverride: response("Complete", "done") }); approvePlan(r);
    const fakeRun = async (workspace: string): Promise<any> => { const task = loadActiveTask(workspace)!; const done = { ...task, status: "COMPLETED" as const }; saveActiveTask(workspace, done); return { task: done, developerTurns: [], evidence: [], reviews: [], runState: { taskId: task.id, status: "completed", phase: "COMPLETED", round: 0, updatedAt: new Date().toISOString() } }; };
    const result = await runPlan(r, {}, fakeRun as any);
    assert.equal(result.manifest.status, "COMPLETED");
    assert.ok(existsSync(join(planWorkspaceRoot(r, "complete-plan"), "archive", "completed.json")));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("manual non-plan task after a completed plan returns to project-global runtime storage", async () => {
  const r = root();
  try {
    await importPlan(r, "PLAN.md", { id: "finished-plan", planner: { provider: "codex", model: "planner" }, responseOverride: response("Finished", "done") }); approvePlan(r);
    const fakeRun = async (workspace: string): Promise<any> => { const task = loadActiveTask(workspace)!; const done = { ...task, status: "COMPLETED" as const }; saveActiveTask(workspace, done); return { task: done, developerTurns: [], evidence: [], reviews: [], runState: { taskId: task.id, status: "completed", phase: "COMPLETED", round: 0, updatedAt: new Date().toISOString() } }; };
    await runPlan(r, {}, fakeRun as any);
    archiveActiveTask(r);
    assert.equal(loadActivePlan(r)?.id, "finished-plan");
    assert.equal(eventsPath(r), join(r, ".harness", "events", "events.jsonl"));
    assert.equal(metricsPath(r), join(r, ".harness", "metrics", "turns.jsonl"));
    const manual = { id: "manual", title: "Manual", status: "IN_PROGRESS", review: { level: "NONE", reason: "manual", selectedBy: "user" }, acceptance: [], checkpoints: [], finalReview: { verdict: "PENDING" } } as any;
    saveActiveTask(r, manual);
    const state = saveRunState(r, { taskId: manual.id, status: "running", phase: "DEVELOP", round: 0 });
    assert.equal(state.taskId, "manual");
    assert.ok(existsSync(join(r, ".harness", "state", "run-state.json")));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
