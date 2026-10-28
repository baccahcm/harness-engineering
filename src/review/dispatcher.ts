import { executeAgent } from "../agents/executor.js";
import {
  findSession,
  loadSessionRegistry,
  markInFlight,
  markTerminal,
  registerSession,
  completeSessionRotation,
  recordFallback,
  saveSessionRegistry,
  setActiveReviewer,
} from "../agents/session-registry.js";
import type { AgentAdapter, AgentTurnResult, SessionRecord } from "../agents/types.js";
import type { CompiledPrompt, CompiledPromptMeta } from "../prompts/types.js";
import { recordTurnMetric } from "../metrics/store.js";
import { HarnessError } from "../core/errors.js";
import { loadActiveTask } from "../core/store.js";
import { selectFallbackReviewer, selectInitialReviewer, type ReviewerCandidate } from "./router.js";

export interface ReviewDispatchResult {
  reviewer: ReviewerCandidate;
  result: AgentTurnResult;
  attempts: { reviewer: ReviewerCandidate; failureCode?: string }[];
  promptMeta?: CompiledPromptMeta;
}

export type ReviewPromptInput = string | ((candidate: ReviewerCandidate, session?: SessionRecord) => string | CompiledPrompt);

function resolvePrompt(input: ReviewPromptInput, candidate: ReviewerCandidate, session?: SessionRecord): { text: string; meta?: CompiledPromptMeta } {
  const value = typeof input === "function" ? input(candidate, session) : input;
  if (typeof value === "string") return { text: value };
  return { text: value.text, meta: value.meta };
}

export function dispatchReview(
  root: string,
  prompt: ReviewPromptInput,
  candidates: ReviewerCandidate[],
  adapters: Record<string, AgentAdapter>,
  requestId = `review-${Date.now()}`,
  execute = executeAgent,
): ReviewDispatchResult {
  const task = loadActiveTask(root);
  if (!task) throw new HarnessError("NO_ACTIVE_TASK", "No active task is available for review.");
  if (task.review.level === "NONE") throw new HarnessError("REVIEW_NOT_REQUIRED", "NONE tasks must not launch an independent reviewer.");
  if (task.status !== "READY_FOR_REVIEW") throw new HarnessError("INVALID_REVIEW_STAGE", `Task must be READY_FOR_REVIEW, got ${task.status}.`);

  const registry = loadSessionRegistry(root);
  const attempts: { reviewer: ReviewerCandidate; failureCode?: string }[] = [];
  let selection = selectInitialReviewer(candidates);

  while (true) {
    const candidate = selection.candidate;
    const adapter = adapters[candidate.provider];
    if (!adapter) throw new HarnessError("ADAPTER_MISSING", `No adapter registered for ${candidate.provider}.`);
    const existing = findSession(registry, task.id, candidate.provider, candidate.model, "reviewer", candidate.name);
    if (existing && existing.workspace !== root) {
      throw new HarnessError("WORKSPACE_MISMATCH", `Saved reviewer session belongs to ${existing.workspace}, not ${root}.`);
    }
    if (existing) markInFlight(existing, requestId);
    const compiled = resolvePrompt(prompt, candidate, existing);
    setActiveReviewer(registry, task.id, candidate.provider, candidate.model, candidate.name);
    saveSessionRegistry(root, registry);

    const result = execute(adapter, {
      workspace: root,
      prompt: compiled.text,
      model: candidate.model,
      purpose: "reviewer",
      sessionId: existing?.rotation ? undefined : existing?.sessionId,
    });
    attempts.push({ reviewer: candidate, ...(result.failureCode ? { failureCode: result.failureCode } : {}) });
    recordTurnMetric(root, { taskId: task.id, requestId, provider: candidate.provider, purpose: "reviewer", model: candidate.model, ...(candidate.name ? { reviewerName: candidate.name } : {}), ...(result.sessionId ? { sessionId: result.sessionId } : existing && !existing.rotation ? { sessionId: existing.sessionId } : {}), success: result.success, ...(compiled.meta ? { prompt: compiled.meta } : {}), ...(result.usage ? { usage: result.usage } : {}), responseChars: result.response.length });

    if (existing) markTerminal(existing, result.success, result.failureCode);
    if (result.success) {
      const id = result.sessionId ?? existing?.sessionId;
      if (!id) throw new HarnessError("SESSION_ID_MISSING", `${candidate.provider} completed without a resumable session ID.`);
      if (existing?.rotation) completeSessionRotation(existing, id);
      else if (!existing) registerSession(registry, task.id, { provider: candidate.provider, purpose: "reviewer", model: candidate.model, ...(candidate.name ? { profileName: candidate.name } : {}), sessionId: id, workspace: root });
      saveSessionRegistry(root, registry);
      return { reviewer: candidate, result: { ...result, sessionId: id }, attempts, ...(compiled.meta ? { promptMeta: compiled.meta } : {}) };
    }

    saveSessionRegistry(root, registry);
    if (!result.failureCode) return { reviewer: candidate, result, attempts };
    try {
      const nextSelection = selectFallbackReviewer(candidates, selection.index, result.failureCode);
      recordFallback(registry, task.id, {
        from: `${candidate.provider}/${candidate.model}`,
        to: `${nextSelection.candidate.provider}/${nextSelection.candidate.model}`,
        reasonCode: result.failureCode,
        requestId,
      });
      saveSessionRegistry(root, registry);
      selection = nextSelection;
    } catch (err) {
      if (err instanceof HarnessError && err.code === "FALLBACK_NOT_ALLOWED") return { reviewer: candidate, result, attempts };
      throw err;
    }
  }
}

export interface AsyncReviewDispatchOptions {
  timeoutMs?: number;
  terminateGraceMs?: number;
}

export async function dispatchReviewAsync(
  root: string,
  prompt: ReviewPromptInput,
  candidates: ReviewerCandidate[],
  adapters: Record<string, AgentAdapter>,
  requestId = `review-${Date.now()}`,
  options: AsyncReviewDispatchOptions = {},
): Promise<ReviewDispatchResult> {
  const { executeAgentStreaming } = await import("../agents/async-executor.js");
  const { assertAdapterReady } = await import("../agents/capabilities.js");
  const { attachInFlightProcess } = await import("../agents/session-registry.js");
  const task = loadActiveTask(root);
  if (!task) throw new HarnessError("NO_ACTIVE_TASK", "No active task is available for review.");
  if (task.review.level === "NONE") throw new HarnessError("REVIEW_NOT_REQUIRED", "NONE tasks must not launch an independent reviewer.");
  if (task.status !== "READY_FOR_REVIEW") throw new HarnessError("INVALID_REVIEW_STAGE", `Task must be READY_FOR_REVIEW, got ${task.status}.`);

  const registry = loadSessionRegistry(root);
  const attempts: { reviewer: ReviewerCandidate; failureCode?: string }[] = [];
  let selection = selectInitialReviewer(candidates);

  while (true) {
    const candidate = selection.candidate;
    const adapter = adapters[candidate.provider];
    if (!adapter) throw new HarnessError("ADAPTER_MISSING", `No adapter registered for ${candidate.provider}.`);
    assertAdapterReady(adapter, "reviewer", candidate.model, root);
    const existing = findSession(registry, task.id, candidate.provider, candidate.model, "reviewer", candidate.name);
    if (existing && existing.workspace !== root) throw new HarnessError("WORKSPACE_MISMATCH", `Saved reviewer session belongs to ${existing.workspace}, not ${root}.`);
    if (existing) markInFlight(existing, requestId);
    const compiled = resolvePrompt(prompt, candidate, existing);
    setActiveReviewer(registry, task.id, candidate.provider, candidate.model, candidate.name);
    saveSessionRegistry(root, registry);

    let result: AgentTurnResult;
    try {
      result = await executeAgentStreaming(root, adapter, {
        workspace: root,
        prompt: compiled.text,
        model: candidate.model,
        purpose: "reviewer",
        sessionId: existing?.rotation ? undefined : existing?.sessionId,
      }, requestId, {
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

    attempts.push({ reviewer: candidate, ...(result.failureCode ? { failureCode: result.failureCode } : {}) });
    recordTurnMetric(root, { taskId: task.id, requestId, provider: candidate.provider, purpose: "reviewer", model: candidate.model, ...(candidate.name ? { reviewerName: candidate.name } : {}), ...(result.sessionId ? { sessionId: result.sessionId } : existing && !existing.rotation ? { sessionId: existing.sessionId } : {}), success: result.success, ...(compiled.meta ? { prompt: compiled.meta } : {}), ...(result.usage ? { usage: result.usage } : {}), responseChars: result.response.length });
    if (existing) markTerminal(existing, result.success, result.failureCode);
    if (result.success) {
      const id = result.sessionId ?? existing?.sessionId;
      if (!id) throw new HarnessError("SESSION_ID_MISSING", `${candidate.provider} completed without a resumable session ID.`);
      if (existing?.rotation) completeSessionRotation(existing, id);
      else if (!existing) registerSession(registry, task.id, { provider: candidate.provider, purpose: "reviewer", model: candidate.model, ...(candidate.name ? { profileName: candidate.name } : {}), sessionId: id, workspace: root });
      saveSessionRegistry(root, registry);
      return { reviewer: candidate, result: { ...result, sessionId: id }, attempts, ...(compiled.meta ? { promptMeta: compiled.meta } : {}) };
    }

    saveSessionRegistry(root, registry);
    if (!result.failureCode) return { reviewer: candidate, result, attempts };
    try {
      const nextSelection = selectFallbackReviewer(candidates, selection.index, result.failureCode);
      recordFallback(registry, task.id, {
        from: `${candidate.provider}/${candidate.model}`,
        to: `${nextSelection.candidate.provider}/${nextSelection.candidate.model}`,
        reasonCode: result.failureCode,
        requestId,
      });
      saveSessionRegistry(root, registry);
      selection = nextSelection;
    } catch (err) {
      if (err instanceof HarnessError && err.code === "FALLBACK_NOT_ALLOWED") return { reviewer: candidate, result, attempts };
      throw err;
    }
  }
}
