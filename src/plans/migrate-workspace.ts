import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseYaml, stringifyYaml } from "../util/yaml.js";
import type { TaskState } from "../core/types.js";
import type { SessionRegistry } from "../agents/types.js";
import { ensurePlanTaskWorkspace, ensurePlanWorkspace, planExecutionRoot, planSourceMetadataPath, planTaskRoot, planTaskStatePath, readActiveTaskPointer, relativeHarnessPath, writeActiveTaskPointer } from "./workspace.js";
import type { PlanManifest } from "./types.js";

export interface PlanWorkspaceMigrationResult { moved: string[]; preserved: string[]; notes: string[] }

function copyTree(src: string, dst: string): void {
  if (!existsSync(src)) return;
  if (statSync(src).isFile()) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); return; }
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) copyTree(join(src, name), join(dst, name));
}

function moveTree(src: string, dst: string): boolean {
  if (!existsSync(src)) return false;
  copyTree(src, dst);
  rmSync(src, { recursive: true, force: true });
  return true;
}

function planManifests(root: string): PlanManifest[] {
  const plans = join(root, ".harness", "plans");
  if (!existsSync(plans)) return [];
  const out: PlanManifest[] = [];
  for (const name of readdirSync(plans)) {
    const manifestPath = join(plans, name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try { out.push(JSON.parse(readFileSync(manifestPath, "utf8")) as PlanManifest); } catch { /* preserve invalid dirs untouched */ }
  }
  return out;
}

export function migratePlanLogicalWorkspaces(root: string): PlanWorkspaceMigrationResult {
  const moved: string[] = [], preserved: string[] = [], notes: string[] = [];
  const manifests = planManifests(root);
  const taskToPlan = new Map<string, string[]>();
  for (const manifest of manifests) {
    ensurePlanWorkspace(root, manifest.id);
    if (!existsSync(planSourceMetadataPath(root, manifest.id))) {
      writeFileSync(planSourceMetadataPath(root, manifest.id), `${JSON.stringify({ schemaVersion: 1, ...manifest.source }, null, 2)}\n`);
      moved.push(relativeHarnessPath(root, planSourceMetadataPath(root, manifest.id)));
    }
    for (const spec of manifest.tasks) {
      ensurePlanTaskWorkspace(root, manifest.id, spec.id);
      const ids = taskToPlan.get(spec.id) ?? []; ids.push(manifest.id); taskToPlan.set(spec.id, ids);
    }
  }

  // Move task-addressable legacy artifacts only when task identity maps to exactly one imported plan.
  for (const [taskId, planIds] of taskToPlan) {
    if (planIds.length !== 1) { notes.push(`Legacy artifacts for task '${taskId}' were not auto-moved because the id exists in multiple plans.`); continue; }
    const planId = planIds[0]; const base = planTaskRoot(root, planId, taskId);
    const legacyHandoff = join(root, ".harness", "handoff", taskId);
    if (existsSync(legacyHandoff)) {
      for (const child of ["reviews", "context"]) {
        const src = join(legacyHandoff, child), dst = join(base, child);
        if (moveTree(src, dst)) moved.push(relativeHarnessPath(root, dst));
      }
      try { if (existsSync(legacyHandoff) && readdirSync(legacyHandoff).length === 0) rmSync(legacyHandoff, { recursive: true, force: true }); } catch {}
    }
    const legacyTask = join(root, ".harness", "tasks", taskId);
    if (existsSync(legacyTask)) {
      const dst = join(base, "archive", "legacy");
      if (moveTree(legacyTask, dst)) moved.push(relativeHarnessPath(root, dst));
    }
  }

  // Split task-addressable sessions into task-local registries.
  const sessionsPath = join(root, ".harness", "state", "sessions.yaml");
  if (existsSync(sessionsPath)) {
    try {
      const registry = parseYaml(readFileSync(sessionsPath, "utf8")) as unknown as SessionRegistry;
      const remaining: SessionRegistry = { schemaVersion: 1, tasks: [] };
      for (const task of registry.tasks ?? []) {
        const planIds = taskToPlan.get(task.taskId) ?? [];
        if (planIds.length === 1) {
          const dst = join(planTaskRoot(root, planIds[0], task.taskId), "sessions.yaml");
          writeFileSync(dst, `${stringifyYaml({ schemaVersion: 1, tasks: [task] } as unknown as never)}\n`);
          moved.push(relativeHarnessPath(root, dst));
        } else remaining.tasks.push(task);
      }
      if (remaining.tasks.length) writeFileSync(sessionsPath, `${stringifyYaml(remaining as unknown as never)}\n`); else rmSync(sessionsPath, { force: true });
    } catch { preserved.push(relativeHarnessPath(root, sessionsPath)); notes.push("Legacy sessions.yaml could not be safely split and was preserved."); }
  }

  // Split metrics by task id.
  const metricsPath = join(root, ".harness", "metrics", "turns.jsonl");
  if (existsSync(metricsPath)) {
    const remaining: string[] = [];
    for (const line of readFileSync(metricsPath, "utf8").split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line) as { taskId?: string };
        const planIds = record.taskId ? taskToPlan.get(record.taskId) ?? [] : [];
        if (record.taskId && planIds.length === 1) {
          const dst = join(planTaskRoot(root, planIds[0], record.taskId), "metrics", "turns.jsonl");
          mkdirSync(dirname(dst), { recursive: true });
          const prev = existsSync(dst) ? readFileSync(dst, "utf8") : "";
          writeFileSync(dst, `${prev}${line}\n`);
        } else remaining.push(line);
      } catch { remaining.push(line); }
    }
    if (remaining.length) writeFileSync(metricsPath, `${remaining.join("\n")}\n`); else rmSync(metricsPath, { force: true });
    moved.push("plan-scoped metrics");
  }

  // Migrate a legacy active plan task into canonical plan state + pointer.
  const legacyActive = join(root, ".harness", "state", "active-task.yaml");
  if (existsSync(legacyActive)) {
    try {
      const task = parseYaml(readFileSync(legacyActive, "utf8")) as unknown as TaskState;
      if (task.plan?.manifestId) {
        ensurePlanTaskWorkspace(root, task.plan.manifestId, task.id);
        writeFileSync(planTaskStatePath(root, task.plan.manifestId, task.id), `${stringifyYaml(task as unknown as never)}\n`);
        writeActiveTaskPointer(root, task.plan.manifestId, task.id);
        rmSync(legacyActive, { force: true });
        moved.push(relativeHarnessPath(root, planTaskStatePath(root, task.plan.manifestId, task.id)));
      }
    } catch { preserved.push(relativeHarnessPath(root, legacyActive)); }
  }

  // Move execution artifacts only when task identity proves which plan owns them.
  let executionPlanId: string | undefined;
  const activeTaskPointer = readActiveTaskPointer(root);
  if (activeTaskPointer) executionPlanId = activeTaskPointer.planId;
  if (!executionPlanId) {
    const runStatePath = join(root, ".harness", "state", "run-state.json");
    if (existsSync(runStatePath)) {
      try {
        const runState = JSON.parse(readFileSync(runStatePath, "utf8")) as { taskId?: string };
        const ids = runState.taskId ? taskToPlan.get(runState.taskId) ?? [] : [];
        if (ids.length === 1) executionPlanId = ids[0];
      } catch {}
    }
  }
  if (executionPlanId) {
    const execution = planExecutionRoot(root, executionPlanId); mkdirSync(execution, { recursive: true });
    for (const [srcRel, dstName] of [["state/run-state.json", "run-state.json"], ["state/runtime-processes.json", "runtime-processes.json"], ["state/run-lease", "run-lease"], ["runtime", "runtime"]] as const) {
      const src = join(root, ".harness", srcRel), dst = join(execution, dstName);
      if (existsSync(src) && moveTree(src, dst)) moved.push(relativeHarnessPath(root, dst));
    }
  } else {
    for (const rel of ["state/run-state.json", "state/runtime-processes.json", "state/run-lease", "runtime"]) {
      const candidate = join(root, ".harness", rel);
      if (existsSync(candidate)) preserved.push(relativeHarnessPath(root, candidate));
    }
    if (preserved.some((item) => item.includes("run-state") || item.includes("runtime"))) notes.push("Legacy execution artifacts were preserved because their plan ownership could not be proven safely.");
  }

  // Historical global evidence cannot be assigned reliably in V0.8.2 because records lacked taskId.
  const legacyEvidence = join(root, ".harness", "evidence");
  if (existsSync(legacyEvidence) && readdirSync(legacyEvidence).length) {
    preserved.push(relativeHarnessPath(root, legacyEvidence));
    notes.push("Legacy global evidence was preserved because V0.8.2 evidence records did not encode taskId; all new plan evidence is plan/task scoped.");
  }
  return { moved, preserved, notes };
}
