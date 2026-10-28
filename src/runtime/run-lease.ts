import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { executionScopedPath } from "../plans/workspace.js";
import { HarnessError } from "../core/errors.js";
import { isProcessAlive } from "./process-registry.js";

export interface RunLease {
  schemaVersion: 1;
  taskId: string;
  pid: number;
  acquiredAt: string;
}

function leaseDir(root: string): string { return executionScopedPath(root, ["run-lease"], ["state", "run-lease"]); }
function leasePath(root: string): string { return join(leaseDir(root), "lease.json"); }

export function loadRunLease(root: string): RunLease | null {
  const path = leasePath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RunLease;
    if (parsed.schemaVersion !== 1 || !parsed.taskId || !Number.isInteger(parsed.pid)) return null;
    return parsed;
  } catch { return null; }
}

export function acquireRunLease(root: string, taskId: string, now = new Date().toISOString()): RunLease {
  const dir = leaseDir(root);
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir);
  } catch (error) {
    const existing = loadRunLease(root);
    if (existing && isProcessAlive(existing.pid)) {
      throw new HarnessError("RUN_LEASE_HELD", `Another harness run is active for task ${existing.taskId} with PID ${existing.pid}.`);
    }
    // A dead harness process may leave the lease directory behind. Provider uncertainty is handled separately by runtime reconciliation.
    rmSync(dir, { recursive: true, force: true });
    try { mkdirSync(dir); }
    catch { throw new HarnessError("RUN_LEASE_RACE", "Could not acquire run lease because another harness process acquired it concurrently."); }
  }
  const lease: RunLease = { schemaVersion: 1, taskId, pid: process.pid, acquiredAt: now };
  writeFileSync(leasePath(root), `${JSON.stringify(lease, null, 2)}\n`);
  return lease;
}

export function releaseRunLease(root: string, lease: RunLease): void {
  const current = loadRunLease(root);
  if (!current) return;
  if (current.pid !== lease.pid || current.taskId !== lease.taskId) {
    throw new HarnessError("RUN_LEASE_OWNERSHIP", "Refusing to release a run lease owned by another process/task.");
  }
  rmSync(leaseDir(root), { recursive: true, force: true });
}
