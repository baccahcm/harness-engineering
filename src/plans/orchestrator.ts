import { HarnessError } from "../core/errors.js";
import { addAcceptanceCriterion, addCheckpoint, createTask } from "../core/task.js";
import type { TaskState } from "../core/types.js";
import { archiveActiveTask, beginActiveTask, loadActiveTask, saveActiveTask } from "../core/store.js";
import { transitionTask } from "../core/state-machine.js";
import { emitHarnessEvent } from "../events/bus.js";
import { loadConfig } from "../core/config.js";
import { runWorkflowAsync, type WorkflowRunOptions, type WorkflowRunResult } from "../orchestration/run.js";
import { assertPlanSourceFresh, loadActivePlan, savePlanManifest } from "./store.js";
import type { PlanManifest, PlanTaskSpec } from "./types.js";
import { ensurePlanWorkspace, planArchiveRoot } from "./workspace.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function approvePlan(root: string, approvedBy: "user" | "team_leader" = "user"): PlanManifest {
  const manifest = loadActivePlan(root);
  if (!manifest) throw new HarnessError("NO_ACTIVE_PLAN", "No imported plan is active.");
  if (manifest.status === "COMPLETED") throw new HarnessError("PLAN_COMPLETED", "Plan is already completed.");
  assertPlanSourceFresh(root, manifest);
  manifest.status = "APPROVED";
  manifest.approvedAt = new Date().toISOString();
  manifest.approvedBy = approvedBy;
  delete manifest.lastError;
  savePlanManifest(root, manifest);
  const cfg = loadConfig(root);
  emitHarnessEvent(root, "plan.approved", { planId: manifest.id, tasks: manifest.tasks.length, approvedBy }, { retainEntries: cfg.events?.retainEntries ?? 5000 });
  return manifest;
}

export function materializePlanTask(root: string, manifest: PlanManifest, spec: PlanTaskSpec): TaskState {
  assertPlanSourceFresh(root, manifest);
  const existing = loadActiveTask(root);
  if (existing && existing.status !== "COMPLETED") {
    if (existing.plan?.manifestId === manifest.id && existing.plan.taskSpecId === spec.id) return existing;
    throw new HarnessError("ACTIVE_TASK_EXISTS", `Active task ${existing.id} is ${existing.status}; cannot materialize plan task ${spec.id}.`);
  }
  if (existing?.status === "COMPLETED") archiveActiveTask(root);
  let task = createTask(spec.id, spec.title, spec.reviewLevel, spec.reviewReason, manifest.approvedBy ?? "user");
  task = { ...task, objective: spec.objective, plan: { manifestId: manifest.id, sourcePath: manifest.source.path, sourceSha256: manifest.source.sha256, taskSpecId: spec.id, executionOrder: spec.executionOrder }, ...(spec.verificationKeys?.length ? { verificationKeys: spec.verificationKeys } : {}) };
  for (const acceptance of spec.acceptance) task = addAcceptanceCriterion(task, acceptance.id, acceptance.description);
  for (const checkpoint of spec.checkpoints) task = addCheckpoint(task, checkpoint.id, checkpoint.scope);
  beginActiveTask(root, task);
  spec.status = "ACTIVE"; manifest.currentTaskId = spec.id; manifest.status = "RUNNING"; savePlanManifest(root, manifest);
  const cfg = loadConfig(root);
  emitHarnessEvent(root, "plan.task.materialized", { planId: manifest.id, taskId: spec.id, executionOrder: spec.executionOrder, reviewLevel: spec.reviewLevel }, { taskId: spec.id, retainEntries: cfg.events?.retainEntries ?? 5000 });
  return task;
}

function nextRunnableTask(manifest: PlanManifest): PlanTaskSpec | undefined {
  const completed = new Set(manifest.tasks.filter((task) => task.status === "COMPLETED").map((task) => task.id));
  return manifest.tasks.filter((task) => task.status !== "COMPLETED").sort((a, b) => a.executionOrder - b.executionOrder).find((task) => task.dependsOn.every((dep) => completed.has(dep)));
}

export interface PlanRunResult { manifest: PlanManifest; taskRuns: WorkflowRunResult[]; }

export async function runPlan(root: string, options: WorkflowRunOptions = {}, runTask: typeof runWorkflowAsync = runWorkflowAsync): Promise<PlanRunResult> {
  let manifest = loadActivePlan(root);
  if (!manifest) throw new HarnessError("NO_ACTIVE_PLAN", "No imported plan is active. Run harness plan import <file> first.");
  if (manifest.status === "DRAFT") throw new HarnessError("PLAN_NOT_APPROVED", "Imported plan is DRAFT. Inspect it and run harness plan approve before execution.");
  if (manifest.status === "COMPLETED") return { manifest, taskRuns: [] };
  assertPlanSourceFresh(root, manifest);
  const runs: WorkflowRunResult[] = [];
  try {
    while (manifest.tasks.some((task) => task.status !== "COMPLETED")) {
      assertPlanSourceFresh(root, manifest);
      let active = loadActiveTask(root);
      if (active?.plan?.manifestId === manifest.id && active.status === "COMPLETED") {
        const spec = manifest.tasks.find((task) => task.id === active!.plan!.taskSpecId);
        if (spec) spec.status = "COMPLETED";
        archiveActiveTask(root); active = null; manifest.currentTaskId = undefined; savePlanManifest(root, manifest);
        if (manifest.tasks.every((task) => task.status === "COMPLETED")) continue;
      } else if (active && active.plan?.manifestId !== manifest.id) {
        throw new HarnessError("ACTIVE_TASK_CONFLICT", `Active task ${active.id} does not belong to active plan ${manifest.id}.`);
      }
      if (!active) {
        const next = nextRunnableTask(manifest);
        if (!next) throw new HarnessError("PLAN_DEPENDENCY_BLOCKED", "No runnable plan task remains; dependencies are incomplete or invalid.");
        active = materializePlanTask(root, manifest, next);
      }
      if (active.status === "DRAFT") { active = transitionTask(active, "READY_FOR_DEV"); saveActiveTask(root, active); }
      const spec = manifest.tasks.find((task) => task.id === active.plan?.taskSpecId);
      const mergedVerificationKeys = [...new Set([...(options.verificationKeys ?? []), ...(spec?.verificationKeys ?? [])])];
      const result = await runTask(root, { ...options, ...(mergedVerificationKeys.length ? { verificationKeys: mergedVerificationKeys } : {}) });
      runs.push(result);
      if (result.task.status !== "COMPLETED") throw new HarnessError("PLAN_TASK_INCOMPLETE", `Plan task ${result.task.id} did not complete.`);
      if (spec) spec.status = "COMPLETED";
      manifest.currentTaskId = undefined;
      savePlanManifest(root, manifest);
    }
    manifest.status = "COMPLETED"; manifest.completedAt = new Date().toISOString(); delete manifest.lastError; savePlanManifest(root, manifest);
    ensurePlanWorkspace(root, manifest.id);
    mkdirSync(planArchiveRoot(root, manifest.id), { recursive: true });
    writeFileSync(join(planArchiveRoot(root, manifest.id), "completed.json"), `${JSON.stringify({ schemaVersion: 1, planId: manifest.id, completedAt: manifest.completedAt, source: manifest.source, tasks: manifest.tasks.map(({ id, title, status, executionOrder, dependsOn }) => ({ id, title, status, executionOrder, dependsOn })) }, null, 2)}\n`);
    const cfg = loadConfig(root); emitHarnessEvent(root, "plan.completed", { planId: manifest.id, tasks: manifest.tasks.length }, { retainEntries: cfg.events?.retainEntries ?? 5000 });
    return { manifest, taskRuns: runs };
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "UNEXPECTED_ERROR"; const message = error instanceof Error ? error.message : String(error);
    manifest = loadActivePlan(root) ?? manifest; manifest.status = "BLOCKED"; manifest.lastError = { code, message, at: new Date().toISOString() }; savePlanManifest(root, manifest);
    throw error;
  }
}
