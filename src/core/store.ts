import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml, stringifyYaml } from "../util/yaml.js";
import type { TaskState } from "./types.js";
import { HarnessError } from "./errors.js";
import { activeTaskPointerPath, ensurePlanTaskWorkspace, planTaskRoot, planTaskStatePath, readActiveTaskPointer, relativeHarnessPath, writeActiveTaskPointer } from "../plans/workspace.js";

export function activeTaskPath(root: string): string { return join(root, ".harness", "state", "active-task.yaml"); }

export function loadActiveTask(root: string): TaskState | null {
  const pointer = readActiveTaskPointer(root);
  if (pointer) {
    const state = join(root, pointer.statePath);
    if (!existsSync(state)) throw new HarnessError("ACTIVE_TASK_STATE_MISSING", `Plan-scoped active task state is missing: ${pointer.statePath}`);
    return parseYaml(readFileSync(state, "utf8")) as unknown as TaskState;
  }
  const path = activeTaskPath(root);
  if (!existsSync(path)) return null;
  return parseYaml(readFileSync(path, "utf8")) as unknown as TaskState;
}

export function saveActiveTask(root: string, task: TaskState): void {
  if (task.plan?.manifestId) {
    ensurePlanTaskWorkspace(root, task.plan.manifestId, task.id);
    const state = planTaskStatePath(root, task.plan.manifestId, task.id);
    writeFileSync(state, stringifyYaml(task as unknown as never) + "\n");
    writeActiveTaskPointer(root, task.plan.manifestId, task.id);
    rmSync(activeTaskPath(root), { force: true });
    return;
  }
  const path = activeTaskPath(root);
  mkdirSync(join(root, ".harness", "state"), { recursive: true });
  writeFileSync(path, stringifyYaml(task as unknown as never) + "\n");
  rmSync(activeTaskPointerPath(root), { force: true });
}

export interface ArchivedTaskEntry {
  taskId: string;
  title: string;
  status: string;
  archivedAt: string;
  path: string;
  planId?: string;
}

export interface TaskHistoryIndex {
  schemaVersion: 1;
  tasks: ArchivedTaskEntry[];
}

export function taskHistoryIndexPath(root: string): string { return join(root, ".harness", "tasks", "index.json"); }

export function loadTaskHistory(root: string): TaskHistoryIndex {
  const path = taskHistoryIndexPath(root);
  if (!existsSync(path)) return { schemaVersion: 1, tasks: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as TaskHistoryIndex;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) throw new Error("Invalid task history index.");
  return parsed;
}

export function archiveActiveTask(root: string, now = new Date().toISOString()): ArchivedTaskEntry {
  const task = loadActiveTask(root);
  if (!task) throw new HarnessError("NO_ACTIVE_TASK", "No active task to archive.");
  if (task.status !== "COMPLETED") throw new HarnessError("TASK_NOT_ARCHIVABLE", `Only COMPLETED tasks can be archived safely; current status is ${task.status}.`);
  const safeTime = now.replace(/[:.]/g, "-");
  let relative: string;
  if (task.plan?.manifestId) {
    const base = ensurePlanTaskWorkspace(root, task.plan.manifestId, task.id);
    const archiveDir = join(base, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const absolute = join(archiveDir, `${safeTime}.yaml`);
    writeFileSync(absolute, stringifyYaml(task as unknown as never) + "\n");
    relative = relativeHarnessPath(root, absolute);
    // Keep state.yaml as the canonical final task snapshot for this plan workspace.
    rmSync(activeTaskPointerPath(root), { force: true });
  } else {
    relative = `.harness/tasks/${task.id}/${safeTime}.yaml`;
    const dir = join(root, ".harness", "tasks", task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, relative), stringifyYaml(task as unknown as never) + "\n");
    rmSync(activeTaskPath(root), { force: true });
  }
  const history = loadTaskHistory(root);
  const entry: ArchivedTaskEntry = { taskId: task.id, title: task.title, status: task.status, archivedAt: now, path: relative, ...(task.plan?.manifestId ? { planId: task.plan.manifestId } : {}) };
  history.tasks.push(entry);
  mkdirSync(join(root, ".harness", "tasks"), { recursive: true });
  writeFileSync(taskHistoryIndexPath(root), `${JSON.stringify(history, null, 2)}\n`);
  return entry;
}

export function beginActiveTask(root: string, task: TaskState): { task: TaskState; archived?: ArchivedTaskEntry } {
  const existing = loadActiveTask(root);
  if (existing && existing.status !== "COMPLETED") throw new HarnessError("ACTIVE_TASK_EXISTS", `Active task ${existing.id} is ${existing.status}. Complete/archive it before creating another task.`);
  const archived = existing?.status === "COMPLETED" ? archiveActiveTask(root) : undefined;
  saveActiveTask(root, task);
  return { task, ...(archived ? { archived } : {}) };
}
