import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { emitHarnessEvent } from "../events/bus.js";
import { planWorkspaces, type WorkspacePlanEntry } from "./workspaces.js";

export interface SchedulerWorkspaceResult {
  id: string;
  root: string;
  status: "completed" | "failed" | "skipped";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
}
export interface SchedulerRunResult { schemaVersion: 1; id: string; startedAt: string; finishedAt: string; maxParallel: number; results: SchedulerWorkspaceResult[] }
export type WorkspaceRunner = (workspace: WorkspacePlanEntry) => Promise<SchedulerWorkspaceResult>;

function runId(now: string): string { return createHash("sha256").update(`${now}\n${process.pid}`).digest("hex").slice(0, 16); }

function defaultRunner(workspace: WorkspacePlanEntry): Promise<SchedulerWorkspaceResult> {
  return new Promise((resolve) => {
    const cli = fileURLToPath(new URL("../cli/index.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "run", "--root", workspace.root, "--json"], { cwd: workspace.root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error: Error) => resolve({ id: workspace.id, root: workspace.root, status: "failed", exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code: number | null) => resolve({ id: workspace.id, root: workspace.root, status: code === 0 ? "completed" : "failed", exitCode: code, stdout, stderr }));
  });
}

export async function runWorkspaceScheduler(root: string, maxParallel = 2, runner: WorkspaceRunner = defaultRunner): Promise<SchedulerRunResult> {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer.");
  const startedAt = new Date().toISOString(); const id = runId(startedAt);
  const plan = planWorkspaces(root);
  const runnable = plan.filter((item) => item.runnable);
  const skipped: SchedulerWorkspaceResult[] = plan.filter((item) => !item.runnable).map((item) => ({ id: item.id, root: item.root, status: "skipped", exitCode: null, stdout: "", stderr: "", reason: item.reason ?? "not runnable" }));
  emitHarnessEvent(root, "scheduler.started", { schedulerRunId: id, runnable: runnable.length, skipped: skipped.length, maxParallel });
  const results: SchedulerWorkspaceResult[] = [...skipped];
  let index = 0;
  const worker = async () => {
    while (true) {
      const current = index++; if (current >= runnable.length) return;
      const workspace = runnable[current];
      const result = await runner(workspace); results.push(result);
      emitHarnessEvent(root, "scheduler.workspace.completed", { schedulerRunId: id, workspaceId: workspace.id, status: result.status, exitCode: result.exitCode });
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxParallel, Math.max(1, runnable.length)) }, () => worker()));
  const value: SchedulerRunResult = { schemaVersion: 1, id, startedAt, finishedAt: new Date().toISOString(), maxParallel, results: results.sort((a, b) => a.id.localeCompare(b.id)) };
  mkdirSync(join(root, ".harness", "scheduler", "runs"), { recursive: true });
  writeFileSync(join(root, ".harness", "scheduler", "runs", `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
  emitHarnessEvent(root, "scheduler.completed", { schedulerRunId: id, completed: results.filter((item) => item.status === "completed").length, failed: results.filter((item) => item.status === "failed").length, skipped: results.filter((item) => item.status === "skipped").length });
  return value;
}
