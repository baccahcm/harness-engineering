import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "../core/errors.js";
import { parseYaml, stringifyYaml } from "../util/yaml.js";
import type { AgentProvider, AgentPurpose, SessionRecord, SessionRegistry, TaskSessionRegistry } from "./types.js";
import { activeTaskScopedPath } from "../plans/workspace.js";

export function sessionRegistryPath(root: string): string { return activeTaskScopedPath(root, ["sessions.yaml"], ["state", "sessions.yaml"]); }

export function loadSessionRegistry(root: string): SessionRegistry {
  const path = sessionRegistryPath(root);
  if (!existsSync(path)) return { schemaVersion: 1, tasks: [] };
  const value = parseYaml(readFileSync(path, "utf8")) as unknown as SessionRegistry;
  if (value.schemaVersion !== 1 || !Array.isArray(value.tasks)) throw new HarnessError("SESSION_REGISTRY_INVALID", "Invalid session registry schema.");
  return value;
}

export function saveSessionRegistry(root: string, registry: SessionRegistry): void {
  const path = sessionRegistryPath(root);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${stringifyYaml(registry as unknown as never)}\n`);
}

function taskEntry(registry: SessionRegistry, taskId: string): TaskSessionRegistry {
  let task = registry.tasks.find((entry) => entry.taskId === taskId);
  if (!task) {
    task = { taskId, sessions: [] };
    registry.tasks.push(task);
  }
  return task;
}

export function sessionKey(provider: AgentProvider, model: string, purpose: AgentPurpose, profileName?: string): string {
  return `${purpose}/${provider}/${model}${profileName ? `/profile:${profileName}` : ""}`;
}

export function registerSession(
  registry: SessionRegistry,
  taskId: string,
  input: { provider: AgentProvider; purpose: AgentPurpose; model: string; profileName?: string; sessionId: string; workspace: string },
  now = new Date().toISOString(),
): SessionRecord {
  const task = taskEntry(registry, taskId);
  const existing = task.sessions.find((session) => session.provider === input.provider && session.purpose === input.purpose && session.model === input.model && (session.profileName ?? "") === (input.profileName ?? ""));
  if (existing && existing.sessionId !== input.sessionId) {
    throw new HarnessError("SESSION_ID_CONFLICT", `A ${input.purpose} session already exists for ${input.provider}/${input.model}. Refusing silent replacement.`);
  }
  if (existing) {
    existing.workspace = input.workspace;
    existing.updatedAt = now;
    existing.status = "idle";
    return existing;
  }
  const record: SessionRecord = { ...input, status: "idle", createdAt: now, updatedAt: now };
  task.sessions.push(record);
  return record;
}

export function findSession(registry: SessionRegistry, taskId: string, provider: AgentProvider, model: string, purpose: AgentPurpose, profileName?: string): SessionRecord | undefined {
  return registry.tasks.find((entry) => entry.taskId === taskId)?.sessions.find((s) => s.provider === provider && s.model === model && s.purpose === purpose && (profileName === undefined || (s.profileName ?? "") === profileName));
}

export function setActiveReviewer(registry: SessionRegistry, taskId: string, provider: AgentProvider, model: string, profileName?: string): void {
  const task = taskEntry(registry, taskId);
  task.activeReviewer = sessionKey(provider, model, "reviewer", profileName);
}

export function markInFlight(session: SessionRecord, requestId: string, now = new Date().toISOString()): void {
  if (session.status === "in_flight") throw new HarnessError("SESSION_BUSY", `Session ${session.sessionId} already has an in-flight request.`);
  if (session.status === "uncertain") throw new HarnessError("SESSION_UNCERTAIN", `Session ${session.sessionId} has unresolved crash/recovery state. Reconcile and explicitly resolve it before reuse.`);
  session.status = "in_flight";
  session.inFlight = { requestId, startedAt: now };
  session.updatedAt = now;
}

export function attachInFlightProcess(session: SessionRecord, pid: number, now = new Date().toISOString()): void {
  if (session.status !== "in_flight" || !session.inFlight) throw new HarnessError("SESSION_NOT_IN_FLIGHT", `Session ${session.sessionId} has no in-flight request.`);
  session.inFlight.pid = pid;
  session.updatedAt = now;
}

export function markUncertain(session: SessionRecord, failureCode = "RUNTIME_STATE_UNCERTAIN", now = new Date().toISOString()): void {
  session.status = "uncertain";
  session.updatedAt = now;
  session.lastFailureCode = failureCode;
}

export function resolveSessionState(session: SessionRecord, resolution: "idle" | "failed", now = new Date().toISOString()): void {
  if (session.status !== "uncertain") throw new HarnessError("SESSION_NOT_UNCERTAIN", `Session ${session.sessionId} is ${session.status}, not uncertain.`);
  session.status = resolution;
  delete session.inFlight;
  session.updatedAt = now;
  session.lastFailureCode = resolution === "failed" ? "RECOVERY_CONFIRMED_FAILED" : undefined;
}

export function markTerminal(session: SessionRecord, success: boolean, failureCode?: string, now = new Date().toISOString()): void {
  session.status = success ? "idle" : "failed";
  delete session.inFlight;
  session.updatedAt = now;
  if (failureCode) session.lastFailureCode = failureCode;
  else delete session.lastFailureCode;
}

export function recordFallback(
  registry: SessionRegistry,
  taskId: string,
  input: { from: string; to: string; reasonCode: string; requestId: string },
  now = new Date().toISOString(),
): void {
  const task = taskEntry(registry, taskId);
  if (!task.fallbackHistory) task.fallbackHistory = [];
  task.fallbackHistory.push({ at: now, ...input });
}

export function requestSessionRotation(session: SessionRecord, summaryPath: string, now = new Date().toISOString()): void {
  if (session.status === "in_flight") throw new HarnessError("SESSION_BUSY", `Session ${session.sessionId} already has an in-flight request.`);
  if (session.status === "uncertain") throw new HarnessError("SESSION_UNCERTAIN", `Session ${session.sessionId} has unresolved crash/recovery state.`);
  session.rotation = { requestedAt: now, summaryPath };
  session.updatedAt = now;
}

export function completeSessionRotation(session: SessionRecord, newSessionId: string, now = new Date().toISOString()): void {
  if (!session.rotation) throw new HarnessError("SESSION_ROTATION_NOT_REQUESTED", `Session ${session.sessionId} has no pending rotation.`);
  if (!newSessionId) throw new HarnessError("SESSION_ID_MISSING", "Rotated session must have a new session ID.");
  if (newSessionId === session.sessionId) throw new HarnessError("SESSION_ROTATION_REUSED_ID", "Provider returned the old session ID during explicit rotation.");
  if (!session.previousSessionIds) session.previousSessionIds = [];
  session.previousSessionIds.push({ sessionId: session.sessionId, retiredAt: now });
  session.sessionId = newSessionId;
  delete session.rotation;
  session.status = "idle";
  delete session.inFlight;
  session.updatedAt = now;
}
