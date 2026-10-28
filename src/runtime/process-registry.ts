import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { executionScopedPath } from "../plans/workspace.js";
import { HarnessError } from "../core/errors.js";
import type { AgentProvider, AgentPurpose } from "../agents/types.js";

export type RuntimeProcessStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled" | "uncertain";

export interface RuntimeProcessRecord {
  requestId: string;
  pid: number;
  executable: string;
  cwd: string;
  status: RuntimeProcessStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  exitCode?: number;
  signal?: string;
  cancelRequestedAt?: string;
  stdoutPath: string;
  stderrPath: string;
  taskId?: string;
  provider?: AgentProvider;
  purpose?: AgentPurpose;
  model?: string;
}

export interface RuntimeProcessRegistry {
  schemaVersion: 1;
  processes: RuntimeProcessRecord[];
}

export function runtimeRegistryPath(root: string): string {
  return executionScopedPath(root, ["runtime-processes.json"], ["state", "runtime-processes.json"]);
}

export function loadRuntimeRegistry(root: string): RuntimeProcessRegistry {
  const path = runtimeRegistryPath(root);
  if (!existsSync(path)) return { schemaVersion: 1, processes: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeProcessRegistry;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.processes)) {
    throw new HarnessError("RUNTIME_REGISTRY_INVALID", "Invalid runtime process registry schema.");
  }
  return parsed;
}

export function saveRuntimeRegistry(root: string, registry: RuntimeProcessRegistry): void {
  const path = runtimeRegistryPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

export function registerRuntimeProcess(
  root: string,
  record: Omit<RuntimeProcessRecord, "status" | "startedAt" | "updatedAt">,
  now = new Date().toISOString(),
): RuntimeProcessRecord {
  const registry = loadRuntimeRegistry(root);
  const existing = registry.processes.find((item) => item.requestId === record.requestId);
  if (existing && existing.status === "running") throw new HarnessError("REQUEST_ALREADY_RUNNING", `Request ${record.requestId} is already running with PID ${existing.pid}.`);
  const value: RuntimeProcessRecord = { ...record, status: "running", startedAt: now, updatedAt: now };
  if (existing) Object.assign(existing, value);
  else registry.processes.push(value);
  saveRuntimeRegistry(root, registry);
  return value;
}


export function findRuntimeProcess(root: string, requestId: string): RuntimeProcessRecord | undefined {
  return loadRuntimeRegistry(root).processes.find((item) => item.requestId === requestId);
}

export function updateRuntimeProcess(
  root: string,
  requestId: string,
  patch: Partial<Omit<RuntimeProcessRecord, "requestId">>,
  now = new Date().toISOString(),
): RuntimeProcessRecord {
  const registry = loadRuntimeRegistry(root);
  const record = registry.processes.find((item) => item.requestId === requestId);
  if (!record) throw new HarnessError("RUNTIME_PROCESS_UNKNOWN", `Unknown runtime request: ${requestId}`);
  Object.assign(record, patch, { updatedAt: now });
  saveRuntimeRegistry(root, registry);
  return record;
}

export function markRuntimeTerminal(
  root: string,
  requestId: string,
  status: Exclude<RuntimeProcessStatus, "running" | "uncertain">,
  input: { exitCode?: number; signal?: string } = {},
  now = new Date().toISOString(),
): RuntimeProcessRecord {
  return updateRuntimeProcess(root, requestId, { status, completedAt: now, ...input }, now);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function reconcileRuntimeProcesses(root: string, now = new Date().toISOString()): RuntimeProcessRecord[] {
  const registry = loadRuntimeRegistry(root);
  let changed = false;
  for (const record of registry.processes) {
    if (record.status !== "running") continue;
    if (!isProcessAlive(record.pid)) {
      record.status = "uncertain";
      record.updatedAt = now;
      changed = true;
    }
  }
  if (changed) saveRuntimeRegistry(root, registry);
  return registry.processes;
}


export function resolveRuntimeProcess(
  root: string,
  requestId: string,
  resolution: "completed" | "failed",
  now = new Date().toISOString(),
): RuntimeProcessRecord {
  const registry = loadRuntimeRegistry(root);
  const record = registry.processes.find((item) => item.requestId === requestId);
  if (!record) throw new HarnessError("RUNTIME_PROCESS_UNKNOWN", `Unknown runtime request: ${requestId}`);
  if (record.status !== "uncertain") throw new HarnessError("RUNTIME_PROCESS_NOT_UNCERTAIN", `Request ${requestId} is ${record.status}, not uncertain.`);
  record.status = resolution;
  record.completedAt = now;
  record.updatedAt = now;
  saveRuntimeRegistry(root, registry);
  return record;
}

export function requestRuntimeCancellation(root: string, requestId: string, now = new Date().toISOString()): RuntimeProcessRecord {
  const registry = loadRuntimeRegistry(root);
  const record = registry.processes.find((item) => item.requestId === requestId);
  if (!record) throw new HarnessError("RUNTIME_PROCESS_UNKNOWN", `Unknown runtime request: ${requestId}`);
  if (record.status !== "running") throw new HarnessError("RUNTIME_PROCESS_NOT_RUNNING", `Request ${requestId} is ${record.status}, not running.`);
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (!isProcessAlive(record.pid)) {
      record.status = "uncertain";
      record.updatedAt = now;
      saveRuntimeRegistry(root, registry);
      return record;
    }
    throw error;
  }
  record.cancelRequestedAt = now;
  record.updatedAt = now;
  saveRuntimeRegistry(root, registry);
  return record;
}
