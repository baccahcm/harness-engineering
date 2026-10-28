import { executeAgent } from "./executor.js";
import { findSession, loadSessionRegistry, markInFlight, markTerminal, registerSession, saveSessionRegistry, completeSessionRotation } from "./session-registry.js";
import type { AgentAdapter, AgentProvider, AgentTurnResult } from "./types.js";
import type { CompiledPrompt } from "../prompts/types.js";
import { recordTurnMetric } from "../metrics/store.js";
import { HarnessError } from "../core/errors.js";
import { loadActiveTask } from "../core/store.js";
import { captureFileManifest, diffFileManifests } from "../git/git.js";
import { outOfScopePaths } from "../core/scope.js";

export type DeveloperPromptInput = string | CompiledPrompt;

function resolvePrompt(prompt: DeveloperPromptInput): { text: string; meta?: CompiledPrompt["meta"] } {
  return typeof prompt === "string" ? { text: prompt } : { text: prompt.text, meta: prompt.meta };
}

export interface DeveloperDispatchOptions {
  enforceCheckpointScope?: boolean;
}

export function dispatchDeveloper(
  root: string,
  prompt: DeveloperPromptInput,
  provider: AgentProvider,
  model: string,
  adapter: AgentAdapter,
  requestId = `dev-${Date.now()}`,
  execute = executeAgent,
  options: DeveloperDispatchOptions = { enforceCheckpointScope: true },
): AgentTurnResult {
  const compiled = resolvePrompt(prompt);
  const task = loadActiveTask(root);
  if (!task) throw new HarnessError("NO_ACTIVE_TASK", "No active task is available for development.");
  if (adapter.supportsPurpose && !adapter.supportsPurpose("developer")) throw new HarnessError("DEVELOPER_PROVIDER_UNSUPPORTED", `${provider} adapter does not support developer execution.`);
  if (task.status !== "IN_PROGRESS") throw new HarnessError("INVALID_DEV_STAGE", `Task must be IN_PROGRESS, got ${task.status}.`);
  const activeCheckpoint = task.review.level === "FULL" && task.activeCheckpointId
    ? task.checkpoints.find((checkpoint) => checkpoint.id === task.activeCheckpointId)
    : undefined;
  if (task.activeCheckpointId && !activeCheckpoint) throw new HarnessError("CHECKPOINT_UNKNOWN", `Active checkpoint does not exist: ${task.activeCheckpointId}`);

  const beforeManifest = options.enforceCheckpointScope && activeCheckpoint?.scope ? captureFileManifest(root) : undefined;
  const registry = loadSessionRegistry(root);
  const existing = findSession(registry, task.id, provider, model, "developer");
  if (existing && existing.workspace !== root) throw new HarnessError("WORKSPACE_MISMATCH", `Saved developer session belongs to ${existing.workspace}, not ${root}.`);
  if (existing) { markInFlight(existing, requestId); saveSessionRegistry(root, registry); }
  const result = execute(adapter, { workspace: root, prompt: compiled.text, model, purpose: "developer", sessionId: existing?.rotation ? undefined : existing?.sessionId });

  let effective = result;
  if (result.success && beforeManifest && activeCheckpoint?.scope) {
    const afterManifest = captureFileManifest(root);
    const changedDuringTurn = diffFileManifests(beforeManifest, afterManifest);
    const violations = outOfScopePaths(changedDuringTurn, activeCheckpoint.scope);
    if (violations.length) {
      effective = {
        ...result,
        success: false,
        failureCode: "OUT_OF_SCOPE_CHANGE",
        response: `${result.response}\n\nHarness ownership violation: developer changed files outside checkpoint ${activeCheckpoint.id}: ${violations.join(", ")}`,
      };
    }
  }

  recordTurnMetric(root, { taskId: task.id, requestId, provider, purpose: "developer", model, ...(effective.sessionId ? { sessionId: effective.sessionId } : existing && !existing.rotation ? { sessionId: existing.sessionId } : {}), success: effective.success, ...(compiled.meta ? { prompt: compiled.meta } : {}), ...(effective.usage ? { usage: effective.usage } : {}), responseChars: effective.response.length });
  if (existing) markTerminal(existing, effective.success, effective.failureCode);
  if (effective.success) {
    const id = effective.sessionId ?? existing?.sessionId;
    if (!id) throw new HarnessError("SESSION_ID_MISSING", `${provider} completed without a resumable session ID.`);
    if (existing?.rotation) completeSessionRotation(existing, id);
    else if (!existing) registerSession(registry, task.id, { provider, purpose: "developer", model, sessionId: id, workspace: root });
  } else if (!existing && effective.sessionId) {
    // Keep a returned resumable session even when the harness rejects the turn for ownership/policy reasons.
    const record = registerSession(registry, task.id, { provider, purpose: "developer", model, sessionId: effective.sessionId, workspace: root });
    markTerminal(record, false, effective.failureCode);
  }
  saveSessionRegistry(root, registry);
  return effective;
}

export interface AsyncDeveloperDispatchOptions extends DeveloperDispatchOptions {
  timeoutMs?: number;
  terminateGraceMs?: number;
}

export async function dispatchDeveloperAsync(
  root: string,
  prompt: DeveloperPromptInput,
  provider: AgentProvider,
  model: string,
  adapter: AgentAdapter,
  requestId = `dev-${Date.now()}`,
  options: AsyncDeveloperDispatchOptions = { enforceCheckpointScope: true },
): Promise<AgentTurnResult> {
  const { executeAgentStreaming } = await import("./async-executor.js");
  const { assertAdapterReady } = await import("./capabilities.js");
  const { attachInFlightProcess } = await import("./session-registry.js");
  assertAdapterReady(adapter, "developer", model, root);
  const compiled = resolvePrompt(prompt);
  const task = loadActiveTask(root);
  if (!task) throw new HarnessError("NO_ACTIVE_TASK", "No active task is available for development.");
  if (task.status !== "IN_PROGRESS") throw new HarnessError("INVALID_DEV_STAGE", `Task must be IN_PROGRESS, got ${task.status}.`);
  const activeCheckpoint = task.review.level === "FULL" && task.activeCheckpointId
    ? task.checkpoints.find((checkpoint) => checkpoint.id === task.activeCheckpointId)
    : undefined;
  if (task.activeCheckpointId && !activeCheckpoint) throw new HarnessError("CHECKPOINT_UNKNOWN", `Active checkpoint does not exist: ${task.activeCheckpointId}`);

  const beforeManifest = options.enforceCheckpointScope && activeCheckpoint?.scope ? captureFileManifest(root) : undefined;
  const registry = loadSessionRegistry(root);
  const existing = findSession(registry, task.id, provider, model, "developer");
  if (existing && existing.workspace !== root) throw new HarnessError("WORKSPACE_MISMATCH", `Saved developer session belongs to ${existing.workspace}, not ${root}.`);
  if (existing) { markInFlight(existing, requestId); saveSessionRegistry(root, registry); }

  let result: AgentTurnResult;
  try {
    result = await executeAgentStreaming(root, adapter, { workspace: root, prompt: compiled.text, model, purpose: "developer", sessionId: existing?.rotation ? undefined : existing?.sessionId }, requestId, {
      taskId: task.id,
      timeoutMs: options.timeoutMs,
      terminateGraceMs: options.terminateGraceMs,
      onSpawn: (pid) => {
        if (existing) {
          attachInFlightProcess(existing, pid);
          saveSessionRegistry(root, registry);
        }
      },
    });
  } catch (error) {
    if (existing) { markTerminal(existing, false, "PROCESS_START_FAILED"); saveSessionRegistry(root, registry); }
    throw error;
  }

  let effective = result;
  if (result.success && beforeManifest && activeCheckpoint?.scope) {
    const afterManifest = captureFileManifest(root);
    const changedDuringTurn = diffFileManifests(beforeManifest, afterManifest);
    const violations = outOfScopePaths(changedDuringTurn, activeCheckpoint.scope);
    if (violations.length) {
      effective = { ...result, success: false, failureCode: "OUT_OF_SCOPE_CHANGE", response: `${result.response}\n\nHarness ownership violation: developer changed files outside checkpoint ${activeCheckpoint.id}: ${violations.join(", ")}` };
    }
  }

  recordTurnMetric(root, { taskId: task.id, requestId, provider, purpose: "developer", model, ...(effective.sessionId ? { sessionId: effective.sessionId } : existing && !existing.rotation ? { sessionId: existing.sessionId } : {}), success: effective.success, ...(compiled.meta ? { prompt: compiled.meta } : {}), ...(effective.usage ? { usage: effective.usage } : {}), responseChars: effective.response.length });
  if (existing) markTerminal(existing, effective.success, effective.failureCode);
  if (effective.success) {
    const id = effective.sessionId ?? existing?.sessionId;
    if (!id) throw new HarnessError("SESSION_ID_MISSING", `${provider} completed without a resumable session ID.`);
    if (existing?.rotation) completeSessionRotation(existing, id);
    else if (!existing) registerSession(registry, task.id, { provider, purpose: "developer", model, sessionId: id, workspace: root });
  } else if (!existing && effective.sessionId) {
    const record = registerSession(registry, task.id, { provider, purpose: "developer", model, sessionId: effective.sessionId, workspace: root });
    markTerminal(record, false, effective.failureCode);
  }
  saveSessionRegistry(root, registry);
  return effective;
}
