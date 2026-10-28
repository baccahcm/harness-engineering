import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { HarnessError } from "../core/errors.js";
import { parseYaml } from "../util/yaml.js";

export interface ActiveTaskPointer {
  schemaVersion: 1;
  kind: "plan";
  planId: string;
  taskId: string;
  statePath: string;
}

export function harnessRoot(root: string): string { return join(root, ".harness"); }
export function planWorkspaceRoot(root: string, planId: string): string { return join(harnessRoot(root), "plans", planId); }
export function planTasksRoot(root: string, planId: string): string { return join(planWorkspaceRoot(root, planId), "tasks"); }
export function planTaskRoot(root: string, planId: string, taskId: string): string { return join(planTasksRoot(root, planId), taskId); }
export function planExecutionRoot(root: string, planId: string): string { return join(planWorkspaceRoot(root, planId), "execution"); }
export function planArchiveRoot(root: string, planId: string): string { return join(planWorkspaceRoot(root, planId), "archive"); }
export function planSourceMetadataPath(root: string, planId: string): string { return join(planWorkspaceRoot(root, planId), "source.json"); }
export function planTaskStatePath(root: string, planId: string, taskId: string): string { return join(planTaskRoot(root, planId, taskId), "state.yaml"); }
export function activeTaskPointerPath(root: string): string { return join(harnessRoot(root), "state", "active-task.json"); }
export function planContextPath(root: string): string { return join(harnessRoot(root), "state", "plan-context.json"); }


export function setPlanContext(root: string, planId: string): void {
  mkdirSync(join(harnessRoot(root), "state"), { recursive: true });
  writeFileSync(planContextPath(root), `${JSON.stringify({ schemaVersion: 1, planId }, null, 2)}\n`);
}

export function clearPlanContext(root: string): void { rmSync(planContextPath(root), { force: true }); }

function contextualPlanId(root: string): string | null {
  const path = planContextPath(root);
  if (!existsSync(path)) return null;
  try { const value = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: number; planId?: string }; return value.schemaVersion === 1 && value.planId ? value.planId : null; } catch { return null; }
}
export function relativeHarnessPath(root: string, absolute: string): string {
  return relative(root, absolute).replace(/\\/g, "/");
}

export function ensurePlanWorkspace(root: string, planId: string): string {
  const base = planWorkspaceRoot(root, planId);
  for (const dir of [base, planTasksRoot(root, planId), planExecutionRoot(root, planId), planArchiveRoot(root, planId)]) mkdirSync(dir, { recursive: true });
  return base;
}

export function ensurePlanTaskWorkspace(root: string, planId: string, taskId: string): string {
  ensurePlanWorkspace(root, planId);
  const base = planTaskRoot(root, planId, taskId);
  for (const dir of [base, join(base, "reviews"), join(base, "evidence"), join(base, "context"), join(base, "metrics"), join(base, "archive")]) mkdirSync(dir, { recursive: true });
  return base;
}

export function writeActiveTaskPointer(root: string, planId: string, taskId: string): ActiveTaskPointer {
  const state = planTaskStatePath(root, planId, taskId);
  const value: ActiveTaskPointer = { schemaVersion: 1, kind: "plan", planId, taskId, statePath: relativeHarnessPath(root, state) };
  mkdirSync(join(harnessRoot(root), "state"), { recursive: true });
  writeFileSync(activeTaskPointerPath(root), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

export function readActiveTaskPointer(root: string): ActiveTaskPointer | null {
  const path = activeTaskPointerPath(root);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ActiveTaskPointer;
    if (value.schemaVersion !== 1 || value.kind !== "plan" || !value.planId || !value.taskId || !value.statePath) throw new Error("invalid");
    return value;
  } catch {
    throw new HarnessError("ACTIVE_TASK_POINTER_INVALID", "Invalid plan-scoped active task pointer.");
  }
}

function legacyActiveTaskPlan(root: string): { planId: string; taskId: string } | null {
  const path = join(harnessRoot(root), "state", "active-task.yaml");
  if (!existsSync(path)) return null;
  try {
    const value = parseYaml(readFileSync(path, "utf8")) as any;
    if (value?.id && value?.plan?.manifestId) return { planId: String(value.plan.manifestId), taskId: String(value.id) };
  } catch { /* legacy corruption is handled by the task store */ }
  return null;
}


function legacyActiveTaskExists(root: string): boolean { return existsSync(join(harnessRoot(root), "state", "active-task.yaml")); }
export function activePlanId(root: string): string | null {
  const context = contextualPlanId(root);
  if (context) return context;
  const pointer = readActiveTaskPointer(root);
  if (pointer) return pointer.planId;
  const legacy = legacyActiveTaskPlan(root);
  if (legacy) return legacy.planId;
  if (legacyActiveTaskExists(root)) return null;
  const path = join(harnessRoot(root), "plans", "active.json");
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: number; planId?: string };
    if (value.schemaVersion !== 1 || !value.planId) return null;
    const manifestPath = join(planWorkspaceRoot(root, value.planId), "manifest.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { status?: string };
      if (manifest.status === "COMPLETED") return null;
    }
    return value.planId;
  } catch { return null; }
}

export function findPlanIdsForTask(root: string, taskId: string): string[] {
  const plans = join(harnessRoot(root), "plans");
  if (!existsSync(plans)) return [];
  const out: string[] = [];
  for (const name of readdirSync(plans)) {
    const candidate = join(plans, name);
    if (!statSync(candidate).isDirectory()) continue;
    const state = planTaskStatePath(root, name, taskId);
    if (existsSync(state)) out.push(name);
  }
  return out;
}

export function resolvePlanIdForTask(root: string, taskId: string): string | null {
  const pointer = readActiveTaskPointer(root);
  if (pointer?.taskId === taskId) return pointer.planId;
  const legacy = legacyActiveTaskPlan(root);
  if (legacy?.taskId === taskId) return legacy.planId;
  const active = activePlanId(root);
  if (active && existsSync(planTaskStatePath(root, active, taskId))) return active;
  const matches = findPlanIdsForTask(root, taskId);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new HarnessError("TASK_WORKSPACE_AMBIGUOUS", `Task id ${taskId} exists in multiple plan workspaces (${matches.join(", ")}). Use the active plan/task context.`);
  return null;
}

export function activeTaskId(root: string): string | null {
  const pointer = readActiveTaskPointer(root);
  if (pointer) return pointer.taskId;
  const legacyPath = join(harnessRoot(root), "state", "active-task.yaml");
  if (!existsSync(legacyPath)) return null;
  try { return String((parseYaml(readFileSync(legacyPath, "utf8")) as any)?.id ?? "") || null; }
  catch { return null; }
}

export function taskArtifactBase(root: string, taskId: string): string | null {
  const planId = resolvePlanIdForTask(root, taskId);
  return planId ? planTaskRoot(root, planId, taskId) : null;
}

export function activeTaskArtifactBase(root: string): string | null {
  const pointer = readActiveTaskPointer(root);
  if (pointer) return planTaskRoot(root, pointer.planId, pointer.taskId);
  const legacy = legacyActiveTaskPlan(root);
  return legacy ? planTaskRoot(root, legacy.planId, legacy.taskId) : null;
}

export function executionArtifactBase(root: string): string | null {
  const planId = activePlanId(root);
  return planId ? planExecutionRoot(root, planId) : null;
}

export function taskScopedPath(root: string, taskId: string, planRelative: string[], legacyRelative: string[]): string {
  const base = taskArtifactBase(root, taskId);
  return base ? join(base, ...planRelative) : join(harnessRoot(root), ...legacyRelative);
}

export function activeTaskScopedPath(root: string, planRelative: string[], legacyRelative: string[]): string {
  const base = activeTaskArtifactBase(root);
  return base ? join(base, ...planRelative) : join(harnessRoot(root), ...legacyRelative);
}

export function executionScopedPath(root: string, planRelative: string[], legacyRelative: string[]): string {
  const base = executionArtifactBase(root);
  return base ? join(base, ...planRelative) : join(harnessRoot(root), ...legacyRelative);
}

export interface PlanWorkspaceTaskSummary {
  taskId: string;
  path: string;
  hasState: boolean;
  hasReviews: boolean;
  hasEvidence: boolean;
  hasSessions: boolean;
  hasMetrics: boolean;
}

export interface PlanWorkspaceSummary {
  planId: string;
  path: string;
  manifestPath: string;
  sourcePath: string;
  executionPath: string;
  archivePath: string;
  status?: string;
  title?: string;
  tasks: PlanWorkspaceTaskSummary[];
}

export function describePlanWorkspace(root: string, planId: string): PlanWorkspaceSummary {
  const base = planWorkspaceRoot(root, planId);
  if (!existsSync(base)) throw new HarnessError("PLAN_WORKSPACE_NOT_FOUND", `Plan workspace not found: ${planId}`);
  let manifest: any = undefined;
  const manifestPath = join(base, "manifest.json");
  if (existsSync(manifestPath)) { try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch {} }
  const tasksDir = planTasksRoot(root, planId);
  const tasks: PlanWorkspaceTaskSummary[] = [];
  if (existsSync(tasksDir)) {
    for (const taskId of readdirSync(tasksDir)) {
      const task = join(tasksDir, taskId);
      if (!statSync(task).isDirectory()) continue;
      tasks.push({
        taskId,
        path: relativeHarnessPath(root, task),
        hasState: existsSync(join(task, "state.yaml")),
        hasReviews: existsSync(join(task, "reviews", "index.json")),
        hasEvidence: existsSync(join(task, "evidence", "index.json")),
        hasSessions: existsSync(join(task, "sessions.yaml")),
        hasMetrics: existsSync(join(task, "metrics", "turns.jsonl")),
      });
    }
  }
  return {
    planId,
    path: relativeHarnessPath(root, base),
    manifestPath: relativeHarnessPath(root, manifestPath),
    sourcePath: relativeHarnessPath(root, planSourceMetadataPath(root, planId)),
    executionPath: relativeHarnessPath(root, planExecutionRoot(root, planId)),
    archivePath: relativeHarnessPath(root, planArchiveRoot(root, planId)),
    ...(manifest?.status ? { status: String(manifest.status) } : {}),
    ...(manifest?.title ? { title: String(manifest.title) } : {}),
    tasks: tasks.sort((a, b) => a.taskId.localeCompare(b.taskId)),
  };
}

export function listPlanWorkspaces(root: string): PlanWorkspaceSummary[] {
  const plans = join(harnessRoot(root), "plans");
  if (!existsSync(plans)) return [];
  const out: PlanWorkspaceSummary[] = [];
  for (const name of readdirSync(plans)) {
    const candidate = join(plans, name);
    if (!statSync(candidate).isDirectory() || !existsSync(join(candidate, "manifest.json"))) continue;
    out.push(describePlanWorkspace(root, name));
  }
  return out.sort((a, b) => a.planId.localeCompare(b.planId));
}
