import type { AgentAdapter, AgentProvider, AgentTurnResult } from "../agents/types.js";
import { createDefaultAdapters } from "../agents/registry.js";
import { dispatchDeveloper, type DeveloperPromptInput } from "../agents/developer-dispatcher.js";
import { HarnessError } from "../core/errors.js";
import { loadConfig, requireDeveloperProfile, requireReviewerProfiles } from "../core/config.js";
import { loadActiveTask, saveActiveTask } from "../core/store.js";
import { assertTaskPlanFresh } from "../plans/store.js";
import { activateCheckpoint } from "../core/task.js";
import { transitionTask } from "../core/state-machine.js";
import type { CheckpointState, ProjectConfig, TaskState } from "../core/types.js";
import { runEvidenceCommand, type EvidenceRun } from "../evidence/runner.js";
import { loadReviewIndex, type ReviewTarget } from "../review/artifacts.js";
import { orchestrateReview, type OrchestratedReviewResult } from "../review/orchestrator.js";
import type { ReviewerCandidate } from "../review/router.js";
import { refreshStaleApprovals } from "../review/staleness.js";
import { saveRunState, type WorkflowRunState } from "./run-state.js";
import { findSession, loadSessionRegistry } from "../agents/session-registry.js";
import { compileDeveloperPrompt } from "../prompts/plans.js";
import { acquireRunLease, releaseRunLease } from "../runtime/run-lease.js";
import { emitHarnessEvent, type HarnessEventSink } from "../events/bus.js";

export interface WorkflowRunOptions {
  maxReviewRounds?: number;
  verificationKeys?: string[];
}

export interface WorkflowRunResult {
  task: TaskState;
  developerTurns: AgentTurnResult[];
  evidence: EvidenceRun[];
  reviews: OrchestratedReviewResult[];
  runState: WorkflowRunState;
}

export interface WorkflowRunDependencies {
  adapters?: Record<string, AgentAdapter>;
  develop?: typeof dispatchDeveloper;
  review?: typeof orchestrateReview;
  evidence?: typeof runEvidenceCommand;
}

function targetKey(target: ReviewTarget): string { return target.kind === "final" ? "final" : `checkpoint:${target.checkpointId}`; }

function pendingCheckpoint(task: TaskState): CheckpointState | undefined {
  return task.checkpoints.find((checkpoint) => checkpoint.verdict !== "APPROVED");
}

function currentTarget(task: TaskState): ReviewTarget {
  if (task.review.level === "FULL") {
    const checkpoint = pendingCheckpoint(task);
    if (checkpoint) return { kind: "checkpoint", checkpointId: checkpoint.id };
  }
  return { kind: "final" };
}

function latestFindings(root: string, taskId: string, target: ReviewTarget): string[] {
  const reviews = loadReviewIndex(root, taskId).reviews.filter((record) => {
    if (record.result.verdict !== "REVISE") return false;
    if (target.kind !== record.target.kind) return false;
    return target.kind === "final" || (record.target.kind === "checkpoint" && record.target.checkpointId === target.checkpointId);
  });
  const latest = reviews.at(-1);
  return latest?.result.findings.map((finding) => `${finding.id} [${finding.severity}] ${finding.location ? `${finding.location} — ` : ""}${finding.description}${finding.requiredVerification ? `; verify: ${finding.requiredVerification}` : ""}`) ?? [];
}

function developerPrompt(task: TaskState, target: ReviewTarget, verificationKeys: string[], root: string): string {
  const checkpoint = target.kind === "checkpoint" ? task.checkpoints.find((item) => item.id === target.checkpointId) : undefined;
  const findings = latestFindings(root, task.id, target);
  return [
    "You are the authorized developer for this Engineering Harness task.",
    `Task: ${task.id} — ${task.title}`,
    `Review-Level: ${task.review.level}`,
    `Current target: ${targetKey(target)}`,
    checkpoint?.scope ? `Authorized file scope include: ${checkpoint.scope.include.join(", ")}` : "Authorized file scope: whole task/repository scope defined by project rules.",
    checkpoint?.scope?.exclude?.length ? `Excluded from checkpoint scope: ${checkpoint.scope.exclude.join(", ")}` : "",
    "Acceptance criteria:",
    ...(task.acceptance.length ? task.acceptance.map((item) => `- ${item.id}: ${item.description}`) : ["- none recorded"]),
    findings.length ? "Unresolved reviewer findings to fix:" : "No unresolved reviewer findings are recorded for this target.",
    ...findings.map((finding) => `- ${finding}`),
    `Harness will run verification keys after this turn: ${verificationKeys.join(", ")}`,
    "Inspect existing code first. Make the smallest complete change. Do not commit, push, merge, deploy, reset, stash, or modify files outside the authorized checkpoint scope. Do not self-approve. Return a concise implementation summary; the harness owns state transitions.",
  ].filter(Boolean).join("\n");
}

function verificationKeys(config: ProjectConfig, requested?: string[]): string[] {
  const available = Object.keys(config.verification ?? {});
  const keys = requested ?? config.orchestration?.verificationKeys ?? available;
  if (!keys.length) throw new HarnessError("VERIFICATION_NOT_CONFIGURED", "No verification commands are configured for automated harness run.");
  for (const key of keys) if (!config.verification?.[key]) throw new HarnessError("VERIFICATION_NOT_CONFIGURED", `Verification key is not configured: ${key}`);
  return keys;
}

function candidates(config: ProjectConfig): ReviewerCandidate[] {
  return requireReviewerProfiles(config).map((profile) => ({ name: profile.name, provider: profile.provider as AgentProvider, model: profile.model }));
}

export function runWorkflow(root: string, options: WorkflowRunOptions = {}, deps: WorkflowRunDependencies = {}): WorkflowRunResult {
  let task = loadActiveTask(root);
  if (!task) throw new HarnessError("NO_ACTIVE_TASK", "No active task is available.");
  assertTaskPlanFresh(root, task);
  const config = loadConfig(root);
  const developer = requireDeveloperProfile(config);
  const reviewerCandidates = config.agents?.reviewers?.length ? candidates(config) : [];
  const keys = verificationKeys(config, options.verificationKeys);
  const maxRounds = options.maxReviewRounds ?? config.orchestration?.maxReviewRounds ?? 3;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new HarnessError("ORCHESTRATION_CONFIG_INVALID", "maxReviewRounds must be a positive integer.");
  const adapters = deps.adapters ?? createDefaultAdapters();
  const develop = deps.develop ?? dispatchDeveloper;
  const review = deps.review ?? orchestrateReview;
  const runEvidence = deps.evidence ?? runEvidenceCommand;

  const stale = refreshStaleApprovals(root, task);
  task = stale.task;
  if (stale.invalidated.length) saveActiveTask(root, task);
  if (task.status === "DRAFT") throw new HarnessError("TASK_NOT_AUTHORIZED", "Task is DRAFT. A user/team leader must move it to READY_FOR_DEV before harness run.");
  if (task.status === "BLOCKED") throw new HarnessError("TASK_BLOCKED", "Task is BLOCKED and requires explicit resolution before harness run.");
  if (task.status === "COMPLETED") throw new HarnessError("TASK_COMPLETED", "Task is already COMPLETED.");
  if (task.review.level !== "NONE" && !reviewerCandidates.length) requireReviewerProfiles(config);
  if (task.status === "READY_FOR_DEV") { task = transitionTask(task, "IN_PROGRESS"); saveActiveTask(root, task); }

  const developerTurns: AgentTurnResult[] = [];
  const evidenceRuns: EvidenceRun[] = [];
  const reviews: OrchestratedReviewResult[] = [];
  const rounds = new Map<string, number>();

  const updateRun = (phase: WorkflowRunState["phase"], target: ReviewTarget, status: WorkflowRunState["status"] = "running") => saveRunState(root, {
    taskId: task!.id,
    status,
    phase,
    target: targetKey(target),
    round: rounds.get(targetKey(target)) ?? 0,
  });

  try {
    while (task.status !== "COMPLETED") {
      assertTaskPlanFresh(root, task);
      const target = currentTarget(task);
      const key = targetKey(target);

      if (task.status === "IN_PROGRESS") {
        if (task.review.level === "FULL" && target.kind === "checkpoint") {
          const checkpoint = task.checkpoints.find((item) => item.id === target.checkpointId)!;
          if (!checkpoint.scope) throw new HarnessError("CHECKPOINT_SCOPE_MISSING", `Automated FULL workflow requires ownership scope for checkpoint ${checkpoint.id}.`);
          task = activateCheckpoint(task, checkpoint.id);
          saveActiveTask(root, task);
        }

        // When every FULL checkpoint is approved, no new implementation turn is needed before the final whole-change review.
        if (task.review.level === "FULL" && target.kind === "final" && task.checkpoints.length > 0 && task.finalReview.verdict !== "REVISE") {
          task = transitionTask(task, "READY_FOR_REVIEW");
          saveActiveTask(root, task);
          continue;
        }

        updateRun(rounds.get(key) ? "FIX" : "DEVELOP", target);
        const adapter = adapters[developer.provider];
        if (!adapter) throw new HarnessError("ADAPTER_MISSING", `No adapter registered for developer provider ${developer.provider}.`);
        const devRegistry = loadSessionRegistry(root);
        const devSession = findSession(devRegistry, task.id, developer.provider as AgentProvider, developer.model, "developer");
        const devPrompt = compileDeveloperPrompt(root, task, target, keys, developer.provider as AgentProvider, developer.model, devSession);
        const turn = develop(root, devPrompt, developer.provider as AgentProvider, developer.model, adapter);
        developerTurns.push(turn);
        if (!turn.success) throw new HarnessError(turn.failureCode ?? "DEVELOPER_EXECUTION_FAILED", turn.response || "Developer agent did not complete successfully.");

        updateRun("VERIFY", target);
        for (const verificationKey of keys) {
          const command = config.verification?.[verificationKey]!;
          const evidence = runEvidence(root, command);
          evidenceRuns.push(evidence);
          if (evidence.exitCode !== 0) throw new HarnessError("VERIFICATION_FAILED", `${verificationKey} failed with exit ${evidence.exitCode}.`);
          if (!evidence.sourceStable) throw new HarnessError("SOURCE_CHANGED_DURING_VERIFICATION", `${verificationKey} changed application source while verification was running.`);
        }

        if (task.review.level === "NONE") {
          task = loadActiveTask(root) ?? task;
          task = transitionTask(task, "COMPLETED");
          saveActiveTask(root, task);
          break;
        }
        task = loadActiveTask(root) ?? task;
        task = transitionTask(task, "READY_FOR_REVIEW");
        saveActiveTask(root, task);
      }

      if (task.status === "READY_FOR_REVIEW") {
        const reviewTarget = currentTarget(task);
        const reviewKey = targetKey(reviewTarget);
        const nextRound = (rounds.get(reviewKey) ?? 0) + 1;
        if (nextRound > maxRounds) throw new HarnessError("MAX_REVIEW_ROUNDS", `Exceeded ${maxRounds} review rounds for ${reviewKey}.`);
        rounds.set(reviewKey, nextRound);
        updateRun(reviewTarget.kind === "final" ? "FINAL_REVIEW" : "REVIEW", reviewTarget);
        const outcome = review(root, reviewTarget, reviewerCandidates, adapters, "Automated harness review gate.");
        reviews.push(outcome);
        task = loadActiveTask(root)!;
        if (outcome.nextAction === "FIX") continue;
        if (outcome.nextAction === "NEXT_CHECKPOINT") continue;
        if (outcome.nextAction === "FINAL_REVIEW") {
          task = transitionTask(task, "READY_FOR_REVIEW");
          saveActiveTask(root, task);
          continue;
        }
        if (outcome.nextAction === "COMPLETED") break;
      }
    }

    task = loadActiveTask(root) ?? task;
    const finalTarget: ReviewTarget = { kind: "final" };
    const runState = saveRunState(root, { taskId: task.id, status: "completed", phase: "COMPLETED", target: targetKey(finalTarget), round: rounds.get("final") ?? 0 });
    return { task, developerTurns, evidence: evidenceRuns, reviews, runState };
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const current = loadActiveTask(root) ?? task;
    const target = currentTarget(current);
    saveRunState(root, { taskId: current.id, status: "failed", phase: "FAILED", target: targetKey(target), round: rounds.get(targetKey(target)) ?? 0, lastError: { code, message } });
    throw error;
  }
}

export interface AsyncWorkflowRunOptions extends WorkflowRunOptions {
  agentTimeoutMs?: number;
  terminateGraceMs?: number;
  eventSink?: HarnessEventSink;
}

export interface AsyncWorkflowRunDependencies {
  adapters?: Record<string, AgentAdapter>;
  develop?: (root: string, prompt: DeveloperPromptInput, provider: AgentProvider, model: string, adapter: AgentAdapter, requestId?: string, options?: { enforceCheckpointScope?: boolean; timeoutMs?: number; terminateGraceMs?: number }) => Promise<AgentTurnResult>;
  review?: (root: string, target: ReviewTarget, candidates: ReviewerCandidate[], adapters: Record<string, AgentAdapter>, extraRequest?: string, requestId?: string, options?: { timeoutMs?: number; terminateGraceMs?: number }) => Promise<OrchestratedReviewResult>;
  evidence?: typeof runEvidenceCommand;
}

export async function runWorkflowAsync(root: string, options: AsyncWorkflowRunOptions = {}, deps: AsyncWorkflowRunDependencies = {}): Promise<WorkflowRunResult> {
  const { dispatchDeveloperAsync } = await import("../agents/developer-dispatcher.js");
  const { orchestrateReviewAsync } = await import("../review/orchestrator.js");
  const { reconcileRuntimeAndSessions } = await import("../runtime/recovery.js");
  let task = loadActiveTask(root);
  if (!task) throw new HarnessError("NO_ACTIVE_TASK", "No active task is available.");
  assertTaskPlanFresh(root, task);
  const config = loadConfig(root);
  const developer = requireDeveloperProfile(config);
  const reviewerCandidates = config.agents?.reviewers?.length ? candidates(config) : [];
  const keys = verificationKeys(config, options.verificationKeys);
  const maxRounds = options.maxReviewRounds ?? config.orchestration?.maxReviewRounds ?? 3;
  const timeoutMs = options.agentTimeoutMs ?? config.runtime?.agentTimeoutMs ?? 900000;
  const terminateGraceMs = options.terminateGraceMs ?? config.runtime?.terminateGraceMs ?? 3000;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new HarnessError("ORCHESTRATION_CONFIG_INVALID", "maxReviewRounds must be a positive integer.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new HarnessError("RUNTIME_CONFIG_INVALID", "agentTimeoutMs must be a positive integer.");
  if (!Number.isInteger(terminateGraceMs) || terminateGraceMs < 0) throw new HarnessError("RUNTIME_CONFIG_INVALID", "terminateGraceMs must be a non-negative integer.");
  const adapters = deps.adapters ?? createDefaultAdapters();
  const develop = deps.develop ?? dispatchDeveloperAsync;
  const review = deps.review ?? orchestrateReviewAsync;
  const runEvidence = deps.evidence ?? runEvidenceCommand;

  const recovery = reconcileRuntimeAndSessions(root);
  const blockingRuntime = recovery.processes.filter((record) => record.taskId === task!.id && (record.status === "running" || record.status === "uncertain"));
  if (blockingRuntime.length) {
    const running = blockingRuntime.filter((record) => record.status === "running");
    if (running.length) throw new HarnessError("RUNTIME_PROCESS_ACTIVE", `Task ${task.id} already has active provider process(es): ${running.map((item) => `${item.requestId}/pid=${item.pid}`).join(", ")}`);
    throw new HarnessError("RUNTIME_RECOVERY_REQUIRED", `Task ${task.id} has uncertain provider runtime state: ${blockingRuntime.map((item) => item.requestId).join(", ")}. Inspect harness runtime status and resolve session state before continuing.`);
  }
  if (recovery.uncertainSessions.some((entry) => entry.startsWith(`${task!.id}:`))) throw new HarnessError("RUNTIME_RECOVERY_REQUIRED", `Task ${task.id} has uncertain agent sessions that require explicit resolution.`);

  const stale = refreshStaleApprovals(root, task);
  task = stale.task;
  if (stale.invalidated.length) saveActiveTask(root, task);
  if (task.status === "DRAFT") throw new HarnessError("TASK_NOT_AUTHORIZED", "Task is DRAFT. A user/team leader must move it to READY_FOR_DEV before harness run.");
  if (task.status === "BLOCKED") throw new HarnessError("TASK_BLOCKED", "Task is BLOCKED and requires explicit resolution before harness run.");
  if (task.status === "COMPLETED") throw new HarnessError("TASK_COMPLETED", "Task is already COMPLETED.");
  if (task.review.level !== "NONE" && !reviewerCandidates.length) requireReviewerProfiles(config);
  if (task.status === "READY_FOR_DEV") { task = transitionTask(task, "IN_PROGRESS"); saveActiveTask(root, task); }

  const developerTurns: AgentTurnResult[] = [];
  const evidenceRuns: EvidenceRun[] = [];
  const reviews: OrchestratedReviewResult[] = [];
  const rounds = new Map<string, number>();
  let requestSequence = 0;
  const nextRequestId = (prefix: string) => `${prefix}-${task!.id}-${Date.now()}-${++requestSequence}`;
  const emit = (type: Parameters<typeof emitHarnessEvent>[1], data: Parameters<typeof emitHarnessEvent>[2] = {}) => emitHarnessEvent(root, type, data, { taskId: task!.id, sink: options.eventSink, retainEntries: config.events?.retainEntries ?? 5000 });
  const updateRun = (phase: WorkflowRunState["phase"], target: ReviewTarget, status: WorkflowRunState["status"] = "running") => {
    const state = saveRunState(root, { taskId: task!.id, status, phase, target: targetKey(target), round: rounds.get(targetKey(target)) ?? 0 });
    emit("run.phase", { phase, target: targetKey(target), round: state.round, status });
    return state;
  };
  const lease = acquireRunLease(root, task.id);
  emit("run.started", { reviewLevel: task.review.level, developerProvider: developer.provider, developerModel: developer.model, maxReviewRounds: maxRounds });

  try {
    while (task.status !== "COMPLETED") {
      assertTaskPlanFresh(root, task);
      const target = currentTarget(task);
      const key = targetKey(target);
      if (task.status === "IN_PROGRESS") {
        if (task.review.level === "FULL" && target.kind === "checkpoint") {
          const checkpoint = task.checkpoints.find((item) => item.id === target.checkpointId)!;
          if (!checkpoint.scope) throw new HarnessError("CHECKPOINT_SCOPE_MISSING", `Automated FULL workflow requires ownership scope for checkpoint ${checkpoint.id}.`);
          task = activateCheckpoint(task, checkpoint.id); saveActiveTask(root, task);
        }
        if (task.review.level === "FULL" && target.kind === "final" && task.checkpoints.length > 0 && task.finalReview.verdict !== "REVISE") {
          task = transitionTask(task, "READY_FOR_REVIEW"); saveActiveTask(root, task); continue;
        }
        updateRun(rounds.get(key) ? "FIX" : "DEVELOP", target);
        const adapter = adapters[developer.provider];
        if (!adapter) throw new HarnessError("ADAPTER_MISSING", `No adapter registered for developer provider ${developer.provider}.`);
        const devRegistry = loadSessionRegistry(root);
        const devSession = findSession(devRegistry, task.id, developer.provider as AgentProvider, developer.model, "developer");
        const devPrompt = compileDeveloperPrompt(root, task, target, keys, developer.provider as AgentProvider, developer.model, devSession);
        const devRequestId = nextRequestId("dev");
        emit("agent.started", { purpose: "developer", provider: developer.provider, model: developer.model, requestId: devRequestId, target: key });
        const turn = await develop(root, devPrompt, developer.provider as AgentProvider, developer.model, adapter, devRequestId, { enforceCheckpointScope: true, timeoutMs, terminateGraceMs });
        developerTurns.push(turn);
        emit("agent.completed", { purpose: "developer", provider: developer.provider, model: developer.model, requestId: devRequestId, success: turn.success, failureCode: turn.failureCode ?? "" });
        if (!turn.success) throw new HarnessError(turn.failureCode ?? "DEVELOPER_EXECUTION_FAILED", turn.response || "Developer agent did not complete successfully.");

        updateRun("VERIFY", target);
        for (const verificationKey of keys) {
          const command = config.verification?.[verificationKey]!;
          const evidence = runEvidence(root, command); evidenceRuns.push(evidence);
          emit("evidence.completed", { key: verificationKey, evidenceId: evidence.id, exitCode: evidence.exitCode, sourceStable: evidence.sourceStable });
          if (evidence.exitCode !== 0) throw new HarnessError("VERIFICATION_FAILED", `${verificationKey} failed with exit ${evidence.exitCode}.`);
          if (!evidence.sourceStable) throw new HarnessError("SOURCE_CHANGED_DURING_VERIFICATION", `${verificationKey} changed application source while verification was running.`);
        }
        if (task.review.level === "NONE") {
          task = loadActiveTask(root) ?? task; task = transitionTask(task, "COMPLETED"); saveActiveTask(root, task); break;
        }
        task = loadActiveTask(root) ?? task; task = transitionTask(task, "READY_FOR_REVIEW"); saveActiveTask(root, task);
      }

      if (task.status === "READY_FOR_REVIEW") {
        const reviewTarget = currentTarget(task);
        const reviewKey = targetKey(reviewTarget);
        const nextRound = (rounds.get(reviewKey) ?? 0) + 1;
        if (nextRound > maxRounds) throw new HarnessError("MAX_REVIEW_ROUNDS", `Exceeded ${maxRounds} review rounds for ${reviewKey}.`);
        rounds.set(reviewKey, nextRound);
        updateRun(reviewTarget.kind === "final" ? "FINAL_REVIEW" : "REVIEW", reviewTarget);
        const reviewRequestId = nextRequestId("review");
        emit("agent.started", { purpose: "reviewer", provider: reviewerCandidates[0]?.provider ?? "unknown", model: reviewerCandidates[0]?.model ?? "unknown", requestId: reviewRequestId, target: reviewKey });
        const outcome = await review(root, reviewTarget, reviewerCandidates, adapters, "Automated harness review gate.", reviewRequestId, { timeoutMs, terminateGraceMs });
        reviews.push(outcome); task = loadActiveTask(root)!;
        const gateReviews = outcome.reviews?.length ? outcome.reviews : [outcome.review];
        const approvalsRequired = outcome.approvalProgress?.approvalsRequired ?? 1;
        const finalApprovalCount = outcome.approvalProgress?.approvals.length ?? gateReviews.filter((recorded) => recorded.result.verdict === "APPROVED").length;
        let approvalsCollected = Math.max(0, finalApprovalCount - gateReviews.filter((recorded) => recorded.result.verdict === "APPROVED").length);
        for (const recorded of gateReviews) {
          if (recorded.result.verdict === "APPROVED") approvalsCollected += 1;
          emit("review.completed", {
            target: reviewKey,
            verdict: recorded.result.verdict,
            reviewer: recorded.reviewer.name ?? `${recorded.reviewer.provider}/${recorded.reviewer.model}`,
            provider: recorded.reviewer.provider,
            model: recorded.reviewer.model,
            reviewRound: recorded.round,
            gateRound: nextRound,
            approvalsRequired,
            approvalsCollected,
            nextAction: outcome.nextAction,
          });
        }
        if (outcome.nextAction === "FIX" || outcome.nextAction === "NEXT_CHECKPOINT") continue;
        if (outcome.nextAction === "FINAL_REVIEW") { task = transitionTask(task, "READY_FOR_REVIEW"); saveActiveTask(root, task); continue; }
        if (outcome.nextAction === "COMPLETED") break;
      }
    }
    task = loadActiveTask(root) ?? task;
    const finalTarget: ReviewTarget = { kind: "final" };
    const runState = saveRunState(root, { taskId: task.id, status: "completed", phase: "COMPLETED", target: targetKey(finalTarget), round: rounds.get("final") ?? 0 });
    emit("run.completed", { status: task.status, developerTurns: developerTurns.length, evidenceRuns: evidenceRuns.length, reviews: reviews.length });
    return { task, developerTurns, evidence: evidenceRuns, reviews, runState };
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof Error ? error.message : String(error);
    const current = loadActiveTask(root) ?? task;
    const target = currentTarget(current);
    saveRunState(root, { taskId: current.id, status: "failed", phase: "FAILED", target: targetKey(target), round: rounds.get(targetKey(target)) ?? 0, lastError: { code, message } });
    emit("run.failed", { code, message, target: targetKey(target) });
    throw error;
  } finally {
    releaseRunLease(root, lease);
  }
}
