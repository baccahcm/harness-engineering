import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { executionScopedPath } from "../plans/workspace.js";

export type RunPhase = "DEVELOP" | "VERIFY" | "REVIEW" | "FIX" | "FINAL_REVIEW" | "COMPLETED" | "FAILED";

export interface WorkflowRunState {
  schemaVersion: 1;
  taskId: string;
  status: "running" | "failed" | "completed";
  phase: RunPhase;
  target?: string;
  round: number;
  updatedAt: string;
  lastError?: { code: string; message: string };
}

function path(root: string): string { return executionScopedPath(root, ["run-state.json"], ["state", "run-state.json"]); }

export function loadRunState(root: string): WorkflowRunState | null {
  const file = path(root);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as WorkflowRunState;
}

export function saveRunState(root: string, state: Omit<WorkflowRunState, "schemaVersion" | "updatedAt">): WorkflowRunState {
  const value: WorkflowRunState = { schemaVersion: 1, updatedAt: new Date().toISOString(), ...state };
  const file = path(root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
