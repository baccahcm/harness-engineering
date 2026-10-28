import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HarnessError } from "../core/errors.js";
import { loadActiveTask } from "../core/store.js";
import { isProcessAlive } from "../runtime/process-registry.js";
import { loadRunLease } from "../runtime/run-lease.js";
import { reconcileRuntimeAndSessions } from "../runtime/recovery.js";

export interface WorkspaceEntry { id: string; root: string; enabled: boolean; addedAt: string }
export interface WorkspaceRegistry { schemaVersion: 1; workspaces: WorkspaceEntry[] }
export interface WorkspacePlanEntry { id: string; root: string; enabled: boolean; initialized: boolean; taskId?: string; taskStatus?: string; runnable: boolean; reason?: string }

export function workspaceRegistryPath(root: string): string { return join(root, ".harness", "state", "workspaces.json"); }
export function loadWorkspaceRegistry(root: string): WorkspaceRegistry {
  const path = workspaceRegistryPath(root);
  if (!existsSync(path)) return { schemaVersion: 1, workspaces: [] };
  try { const value = JSON.parse(readFileSync(path, "utf8")) as WorkspaceRegistry; return value.schemaVersion === 1 && Array.isArray(value.workspaces) ? value : { schemaVersion: 1, workspaces: [] }; }
  catch { return { schemaVersion: 1, workspaces: [] }; }
}
function save(root: string, registry: WorkspaceRegistry): WorkspaceRegistry { mkdirSync(join(root, ".harness", "state"), { recursive: true }); writeFileSync(workspaceRegistryPath(root), `${JSON.stringify(registry, null, 2)}\n`); return registry; }

export function addWorkspace(root: string, id: string, workspaceRoot: string, now = new Date().toISOString()): WorkspaceRegistry {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new HarnessError("WORKSPACE_ID_INVALID", "Workspace id may contain letters, numbers, dot, underscore and dash only.");
  const registry = loadWorkspaceRegistry(root); const absolute = resolve(workspaceRoot);
  if (registry.workspaces.some((item) => item.id === id && item.root !== absolute)) throw new HarnessError("WORKSPACE_ID_EXISTS", `Workspace id already exists: ${id}`);
  if (registry.workspaces.some((item) => item.root === absolute && item.id !== id)) throw new HarnessError("WORKSPACE_ROOT_EXISTS", `Workspace root is already registered: ${absolute}`);
  const existing = registry.workspaces.find((item) => item.id === id);
  if (existing) existing.enabled = true; else registry.workspaces.push({ id, root: absolute, enabled: true, addedAt: now });
  return save(root, registry);
}
export function removeWorkspace(root: string, id: string): WorkspaceRegistry { const registry = loadWorkspaceRegistry(root); registry.workspaces = registry.workspaces.filter((item) => item.id !== id); return save(root, registry); }
export function setWorkspaceEnabled(root: string, id: string, enabled: boolean): WorkspaceRegistry { const registry = loadWorkspaceRegistry(root); const item = registry.workspaces.find((entry) => entry.id === id); if (!item) throw new HarnessError("WORKSPACE_NOT_FOUND", `Workspace not found: ${id}`); item.enabled = enabled; return save(root, registry); }

export function planWorkspaces(root: string): WorkspacePlanEntry[] {
  return loadWorkspaceRegistry(root).workspaces.map((workspace) => {
    const initialized = existsSync(join(workspace.root, ".harness", "config.yaml"));
    if (!workspace.enabled) return { id: workspace.id, root: workspace.root, enabled: false, initialized, runnable: false, reason: "disabled" };
    if (!initialized) return { id: workspace.id, root: workspace.root, enabled: true, initialized: false, runnable: false, reason: "harness not initialized" };
    let task;
    try { task = loadActiveTask(workspace.root); } catch { return { id: workspace.id, root: workspace.root, enabled: true, initialized: true, runnable: false, reason: "task state unreadable" }; }
    if (!task) return { id: workspace.id, root: workspace.root, enabled: true, initialized: true, runnable: false, reason: "no active task" };
    if (task.status === "DRAFT" || task.status === "BLOCKED" || task.status === "COMPLETED") return { id: workspace.id, root: workspace.root, enabled: true, initialized: true, taskId: task.id, taskStatus: task.status, runnable: false, reason: `task ${task.status}` };
    const lease = loadRunLease(workspace.root);
    if (lease && isProcessAlive(lease.pid)) return { id: workspace.id, root: workspace.root, enabled: true, initialized: true, taskId: task.id, taskStatus: task.status, runnable: false, reason: `run lease held pid=${lease.pid}` };
    const recovery = reconcileRuntimeAndSessions(workspace.root);
    const unresolved = recovery.processes.filter((item) => item.status === "running" || item.status === "uncertain");
    if (unresolved.length) return { id: workspace.id, root: workspace.root, enabled: true, initialized: true, taskId: task.id, taskStatus: task.status, runnable: false, reason: `${unresolved.length} unresolved runtime process(es)` };
    if (recovery.uncertainSessions.length) return { id: workspace.id, root: workspace.root, enabled: true, initialized: true, taskId: task.id, taskStatus: task.status, runnable: false, reason: `${recovery.uncertainSessions.length} uncertain session(s)` };
    return { id: workspace.id, root: workspace.root, enabled: true, initialized: true, taskId: task.id, taskStatus: task.status, runnable: true };
  });
}
