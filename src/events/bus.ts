import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { executionScopedPath } from "../plans/workspace.js";
import { createHash } from "node:crypto";

export type HarnessEventType =
  | "run.started"
  | "run.phase"
  | "agent.started"
  | "agent.completed"
  | "evidence.completed"
  | "review.completed"
  | "run.completed"
  | "run.failed"
  | "context.compacted"
  | "catalog.probed"
  | "migration.applied"
  | "release.generated"
  | "release.verified"
  | "release.keyless.signed"
  | "release.keyless.verified"
  | "ci.generated"
  | "workspace.registered"
  | "scheduler.started"
  | "scheduler.workspace.completed"
  | "scheduler.completed"
  | "plan.analysis.started"
  | "plan.imported"
  | "plan.approved"
  | "plan.task.materialized"
  | "plan.completed";

export type HarnessEventValue = string | number | boolean | null;
export type HarnessEventData = Record<string, HarnessEventValue>;

export interface HarnessEvent {
  schemaVersion: 1;
  id: string;
  at: string;
  type: HarnessEventType;
  taskId?: string;
  data: HarnessEventData;
}

export type HarnessEventSink = (event: HarnessEvent) => void;

export function eventsPath(root: string): string { return executionScopedPath(root, ["events.jsonl"], ["events", "events.jsonl"]); }
export function projectEventsPath(root: string): string { return join(root, ".harness", "events", "events.jsonl"); }

function sanitizeValue(value: HarnessEventValue): HarnessEventValue {
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 497)}...` : value;
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

export function sanitizeEventData(data: HarnessEventData): HarnessEventData {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, sanitizeValue(value)]));
}

export function emitHarnessEvent(
  root: string,
  type: HarnessEventType,
  data: HarnessEventData = {},
  options: { taskId?: string; sink?: HarnessEventSink; at?: string; retainEntries?: number } = {},
): HarnessEvent {
  const at = options.at ?? new Date().toISOString();
  const sanitized = sanitizeEventData(data);
  const id = createHash("sha256").update(`${at}\n${process.pid}\n${type}\n${JSON.stringify(sanitized)}`).digest("hex").slice(0, 20);
  const event: HarnessEvent = { schemaVersion: 1, id, at, type, ...(options.taskId ? { taskId: options.taskId } : {}), data: sanitized };
  const path = eventsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`);
  const projectPath = projectEventsPath(root);
  if (projectPath !== path) {
    mkdirSync(dirname(projectPath), { recursive: true });
    appendFileSync(projectPath, `${JSON.stringify(event)}\n`);
  }
  if (options.retainEntries && options.retainEntries > 0) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length > options.retainEntries) writeFileSync(path, `${lines.slice(-options.retainEntries).join("\n")}\n`);
    if (projectPath !== path && existsSync(projectPath)) { const projectLines = readFileSync(projectPath, "utf8").split(/\r?\n/).filter(Boolean); if (projectLines.length > options.retainEntries) writeFileSync(projectPath, `${projectLines.slice(-options.retainEntries).join("\n")}\n`); }
  }
  options.sink?.(event);
  return event;
}

export function loadHarnessEvents(root: string, limit = 100): HarnessEvent[] {
  const path = eventsPath(root);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(Math.max(0, lines.length - Math.max(0, limit))).map((line) => JSON.parse(line) as HarnessEvent);
}
