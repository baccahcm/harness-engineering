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

interface ReclaimGuard {
  schemaVersion: 1;
  pid: number;
  token: string;
  acquiredAt: string;
}

function leaseDir(root: string): string { return executionScopedPath(root, ["run-lease"], ["state", "run-lease"]); }
function leasePath(root: string): string { return join(leaseDir(root), "lease.json"); }
function reclaimGuardPath(root: string): string { return join(leaseDir(root), "reclaim.json"); }

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

function publishExclusiveJson(root: string, targetPath: string, value: unknown, prefix: string): boolean {
  const dir = leaseDir(root);
  mkdirSync(dir, { recursive: true });
  const temp = join(dirname(dir), `${prefix}-${process.pid}-${++acquireSequence}.json`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    // Hard-link creation is an atomic create-if-absent operation: it cannot replace an existing target file.
    linkSync(temp, targetPath);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}

function publishLeaseAtomically(root: string, lease: RunLease): boolean {
  return publishExclusiveJson(root, leasePath(root), lease, "run-lease.acquire");
}

function acquireReclaimGuard(root: string, now = new Date().toISOString()): ReclaimGuard {
  const guard: ReclaimGuard = {
    schemaVersion: 1,
    pid: process.pid,
    token: `${process.pid}-${now}-${++acquireSequence}`,
    acquiredAt: now,
  };
  if (!publishExclusiveJson(root, reclaimGuardPath(root), guard, "run-lease.reclaim")) {
    throw new HarnessError("RUN_LEASE_RACE", "Stale run-lease reclamation is already in progress or requires explicit recovery.");
  }
  return guard;
}

function releaseReclaimGuard(root: string, guard: ReclaimGuard): void {
  const path = reclaimGuardPath(root);
  if (!existsSync(path)) return;
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as ReclaimGuard;
    if (current.schemaVersion !== 1 || current.token !== guard.token || current.pid !== guard.pid) {
      throw new HarnessError("RUN_LEASE_RACE", "Refusing to remove a reclaim guard that is not owned by this process.");
    }
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("RUN_LEASE_RACE", "Refusing to remove a malformed reclaim guard; explicit recovery is required.");
  }
  rmSync(path, { force: true });
}

function heldByLiveOwner(existing: RunLease): HarnessError {
  return new HarnessError("RUN_LEASE_HELD", `Another harness run is active for task ${existing.taskId} with PID ${existing.pid}.`);
}

export function acquireRunLease(root: string, taskId: string, now = new Date().toISOString()): RunLease {
  const lease: RunLease = { schemaVersion: 1, taskId, pid: process.pid, acquiredAt: now };
  if (publishLeaseAtomically(root, lease)) return lease;

  const existing = loadRunLease(root);
  if (!existing) {
    throw new HarnessError("RUN_LEASE_RACE", "Run lease file exists without valid metadata. Refusing to delete a possibly in-progress or corrupted lock.");
  }
  if (isProcessAlive(existing.pid)) throw heldByLiveOwner(existing);

  // Serialize stale-owner reclamation. The guard is deliberately fail-safe: it is never
  // auto-reclaimed because doing so would recreate the same stale-reclaimer race one level down.
  const guard = acquireReclaimGuard(root, now);
  try {
    const current = loadRunLease(root);
    if (!current) {
      // Another actor may have released/reclaimed the stale lease before this guard was acquired.
      if (publishLeaseAtomically(root, lease)) return lease;
      const winner = loadRunLease(root);
      if (winner && isProcessAlive(winner.pid)) throw heldByLiveOwner(winner);
      throw new HarnessError("RUN_LEASE_RACE", "Run lease changed during stale-owner reclamation.");
    }
    if (isProcessAlive(current.pid)) throw heldByLiveOwner(current);

    // Only the guard owner may remove a confirmed dead lease. After this unlink, another normal
    // acquirer may win the empty slot; if so we observe that winner and never delete it.
    rmSync(leasePath(root), { force: true });
    if (publishLeaseAtomically(root, lease)) return lease;

    const winner = loadRunLease(root);
    if (winner && isProcessAlive(winner.pid)) throw heldByLiveOwner(winner);
    throw new HarnessError("RUN_LEASE_RACE", "Could not acquire run lease because another process won the reclaimed lease slot.");
  } finally {
    releaseReclaimGuard(root, guard);
  }
}

export function releaseRunLease(root: string, lease: RunLease): void {
  const current = loadRunLease(root);
  if (!current) return;
  if (current.pid !== lease.pid || current.taskId !== lease.taskId) {
    throw new HarnessError("RUN_LEASE_OWNERSHIP", "Refusing to release a run lease owned by another process/task.");
  }
  rmSync(leasePath(root), { force: true });
  try { rmSync(leaseDir(root)); } catch { /* keep reclaim/diagnostic files if any */ }
}