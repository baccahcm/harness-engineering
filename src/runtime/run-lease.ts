import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

let acquireSequence = 0;

export function loadRunLease(root: string): RunLease | null {
  const path = leasePath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RunLease;
    if (parsed.schemaVersion !== 1 || !parsed.taskId || !Number.isInteger(parsed.pid)) return null;
    return parsed;
  } catch { return null; }
}

function publishLeaseAtomically(root: string, lease: RunLease): boolean {
  const dir = leaseDir(root);
  mkdirSync(dir, { recursive: true });
  const temp = join(dirname(dir), `run-lease.acquire-${process.pid}-${++acquireSequence}.json`);
  writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`);
  try {
    // Hard-link creation is an atomic create-if-absent operation: it cannot replace an existing lease file.
    linkSync(temp, leasePath(root));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}

export function acquireRunLease(root: string, taskId: string, now = new Date().toISOString()): RunLease {
  const lease: RunLease = { schemaVersion: 1, taskId, pid: process.pid, acquiredAt: now };
  if (publishLeaseAtomically(root, lease)) return lease;

  const existing = loadRunLease(root);
  if (!existing) {
    throw new HarnessError("RUN_LEASE_RACE", "Run lease file exists without valid metadata. Refusing to delete a possibly in-progress or corrupted lock.");
  }
  if (isProcessAlive(existing.pid)) {
    throw new HarnessError("RUN_LEASE_HELD", `Another harness run is active for task ${existing.taskId} with PID ${existing.pid}.`);
  }

  // The canonical lease file is fully published and belongs to a dead process, so reclaim only that stale lock file.
  rmSync(leasePath(root), { force: true });
  if (publishLeaseAtomically(root, lease)) return lease;
  throw new HarnessError("RUN_LEASE_RACE", "Could not acquire run lease because another harness process acquired it concurrently.");
}

export function releaseRunLease(root: string, lease: RunLease): void {
  const current = loadRunLease(root);
  if (!current) return;
  if (current.pid !== lease.pid || current.taskId !== lease.taskId) {
    throw new HarnessError("RUN_LEASE_OWNERSHIP", "Refusing to release a run lease owned by another process/task.");
  }
  rmSync(leasePath(root), { force: true });
  try { rmSync(leaseDir(root)); } catch { /* keep non-empty diagnostic files if any */ }
}
