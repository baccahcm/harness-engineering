import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../../src/installer/install.js";
import { importPlan } from "../../src/plans/analyzer.js";
import { approvePlan, materializePlanTask, runPlan } from "../../src/plans/orchestrator.js";
import { assertPlanSourceFresh, loadActivePlan } from "../../src/plans/store.js";
import { loadActiveTask, saveActiveTask } from "../../src/core/store.js";
import { loadConfig, saveConfig, setPlannerProfile, requirePlannerProfile } from "../../src/core/config.js";
import { runWorkflow } from "../../src/orchestration/run.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-plan-"));
  initProject(root);
  writeFileSync(join(root, "PLAN.md"), "# Plan\nBuild schema then API.\n");
  const cfg = loadConfig(root); cfg.verification = { unit: 'node -e "process.exit(0)"' }; saveConfig(root, cfg);
  return root;
}

function plannerResponse(): string {
  return JSON.stringify({
    title: "Schema and API",
    summary: "Implement database first, then API.",
    tasks: [
      { id: "schema", title: "Schema", objective: "Create schema", reviewLevel: "FULL", reviewReason: "schema migration", acceptance: [{ id: "A1", description: "Schema change is implemented and verified" }], checkpoints: [{ id: "C1", scope: { include: ["db/**"] } }], dependsOn: [], verificationKeys: ["unit"] },
      { id: "api", title: "API", objective: "Expose API", reviewLevel: "LIGHT", reviewReason: "isolated API behavior", acceptance: [{ id: "A1", description: "API behavior is available" }], checkpoints: [], dependsOn: ["schema"], verificationKeys: ["unit"] },
    ],
  });
}

test("plan import creates a DRAFT canonical task queue and approval materializes exact plan metadata", async () => {
  const root = project();
  try {
    const manifest = await importPlan(root, "PLAN.md", { planner: { provider: "codex", model: "planner-model" }, responseOverride: plannerResponse() });
    assert.equal(manifest.status, "DRAFT"); assert.equal(manifest.tasks.length, 2); assert.equal(loadActiveTask(root), null);
    const approved = approvePlan(root);
    const task = materializePlanTask(root, approved, approved.tasks[0]);
    assert.equal(task.plan?.manifestId, manifest.id); assert.equal(task.plan?.sourceSha256, manifest.source.sha256); assert.equal(task.review.level, "FULL"); assert.equal(task.checkpoints[0].scope?.include[0], "db/**");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plan source mutation blocks freshness and plan-generated task execution", async () => {
  const root = project();
  try {
    const manifest = await importPlan(root, "PLAN.md", { planner: { provider: "codex", model: "planner-model" }, responseOverride: plannerResponse() }); approvePlan(root);
    writeFileSync(join(root, "PLAN.md"), "# Changed plan\nDifferent requirements.\n");
    assert.throws(() => assertPlanSourceFresh(root, manifest), (err: any) => err?.code === "PLAN_CHANGED");
    let code = ""; try { await runPlan(root); } catch (err: any) { code = err?.code ?? ""; } assert.equal(code, "PLAN_CHANGED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plan run materializes dependency-ordered tasks and completes the queue", async () => {
  const root = project();
  try {
    await importPlan(root, "PLAN.md", { planner: { provider: "codex", model: "planner-model" }, responseOverride: plannerResponse() }); approvePlan(root);
    const seen: string[] = [];
    const fakeRun = async (workspace: string): Promise<any> => {
      const task = loadActiveTask(workspace)!; seen.push(task.id); const completed = { ...task, status: "COMPLETED" as const }; saveActiveTask(workspace, completed);
      return { task: completed, developerTurns: [], evidence: [], reviews: [], runState: { taskId: task.id, status: "completed", phase: "COMPLETED", target: "final", round: 0, updatedAt: new Date().toISOString() } };
    };
    const result = await runPlan(root, {}, fakeRun as any);
    assert.deepEqual(seen, ["schema", "api"]); assert.equal(result.manifest.status, "COMPLETED"); assert.ok(result.manifest.tasks.every((task) => task.status === "COMPLETED"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("configured planner profile wins; otherwise primary reviewer is used", () => {
  const root = project();
  try {
    let cfg = loadConfig(root); cfg.agents = { reviewers: [{ name: "primary", provider: "claude", model: "review" }] }; saveConfig(root, cfg);
    assert.equal(requirePlannerProfile(loadConfig(root)).profile.provider, "claude");
    setPlannerProfile(root, { provider: "codex", model: "planner" });
    const resolved = requirePlannerProfile(loadConfig(root)); assert.equal(resolved.source, "configured"); assert.equal(resolved.profile.model, "planner");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("ordinary harness run refuses a materialized task after its source plan changes", async () => {
  const root = project();
  try {
    const manifest = await importPlan(root, "PLAN.md", { planner: { provider: "codex", model: "planner-model" }, responseOverride: plannerResponse() });
    const approved = approvePlan(root); materializePlanTask(root, approved, approved.tasks[0]);
    writeFileSync(join(root, "PLAN.md"), "# Changed\nChanged after materialization.\n");
    assert.throws(() => runWorkflow(root), (err: any) => err?.code === "PLAN_CHANGED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plan run refuses an imported plan until explicit approval", async () => {
  const root = project();
  try {
    await importPlan(root, "PLAN.md", { planner: { provider: "codex", model: "planner-model" }, responseOverride: plannerResponse() });
    let code = ""; try { await runPlan(root); } catch (err: any) { code = err?.code ?? ""; }
    assert.equal(code, "PLAN_NOT_APPROVED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("plan recovery completes when the recovered active task was the final plan task", async () => {
  const root = project();
  try {
    const single = JSON.stringify({
      title: "Single task plan",
      summary: "One task only.",
      tasks: [
        { id: "only", title: "Only", objective: "Complete it", reviewLevel: "LIGHT", reviewReason: "isolated", acceptance: [{ id: "A1", description: "Done" }], checkpoints: [], dependsOn: [], verificationKeys: ["unit"] },
      ],
    });
    const manifest = await importPlan(root, "PLAN.md", { planner: { provider: "codex", model: "planner-model" }, responseOverride: single });
    const approved = approvePlan(root);
    let task = materializePlanTask(root, approved, approved.tasks[0]);
    task = { ...task, status: "COMPLETED" as const };
    saveActiveTask(root, task);

    let called = false;
    const result = await runPlan(root, {}, (async () => { called = true; throw new Error("should not rerun completed task"); }) as any);
    assert.equal(called, false);
    assert.equal(result.manifest.status, "COMPLETED");
    assert.equal(result.manifest.tasks[0].status, "COMPLETED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
