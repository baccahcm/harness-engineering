import type { AgentAdapter, SessionRecord } from "../agents/types.js";
import { HarnessError, PolicyViolation } from "../core/errors.js";
import { effectiveReviewPolicy, loadConfig } from "../core/config.js";
import { loadActiveTask, saveActiveTask } from "../core/store.js";
import { applyReviewVerdict, transitionTask } from "../core/state-machine.js";
import type { ReviewerApproval, ReviewerRecheckRequirement, TaskState } from "../core/types.js";
import { inspectGit } from "../git/git.js";
import { dispatchReview, type ReviewDispatchResult } from "./dispatcher.js";
import { reviewerId, type ReviewerCandidate } from "./router.js";
import { loadReviewIndex, recordReview, type RecordedReview, type ReviewTarget } from "./artifacts.js";
import { compileReviewerPrompt } from "../prompts/plans.js";
import { parseStructuredReviewResult, type StructuredReviewResult } from "./result.js";
import { refreshStaleApprovals } from "./staleness.js";

export interface ApprovalProgress {
  approvalsRequired: number;
  maxReviewers: number;
  approvals: string[];
  completedReviews: number;
}

export interface OrchestratedReviewResult {
  dispatch: ReviewDispatchResult;
  review: RecordedReview;
  dispatches?: ReviewDispatchResult[];
  reviews?: RecordedReview[];
  approvalProgress?: ApprovalProgress;
  taskStatus: string;
  nextAction: "FIX" | "NEXT_CHECKPOINT" | "FINAL_REVIEW" | "COMPLETED";
}

function assertTarget(task: NonNullable<ReturnType<typeof loadActiveTask>>, target: ReviewTarget): void {
  if (task.review.level === "NONE") throw new HarnessError("REVIEW_NOT_REQUIRED", "NONE tasks do not have review targets.");
  if (task.review.level === "LIGHT" && target.kind !== "final") throw new PolicyViolation("P011", "LIGHT uses one whole-task final review gate, not checkpoint approval.");
  if (target.kind === "checkpoint") {
    if (task.review.level !== "FULL") throw new PolicyViolation("P012", "Checkpoint review targets are only valid for FULL tasks.");
    if (!task.checkpoints.some((c) => c.id === target.checkpointId)) throw new HarnessError("CHECKPOINT_UNKNOWN", `Unknown checkpoint: ${target.checkpointId}`);
  }
  if (target.kind === "final" && task.review.level === "FULL") {
    const pending = task.checkpoints.filter((c) => c.verdict !== "APPROVED");
    if (pending.length) throw new PolicyViolation("P012", `FULL final review cannot run before all checkpoints are approved: ${pending.map((c) => c.id).join(", ")}`);
  }
}

function targetApprovals(task: TaskState, target: ReviewTarget): ReviewerApproval[] {
  if (target.kind === "final") return task.finalReview.approvals ?? [];
  return task.checkpoints.find((c) => c.id === target.checkpointId)?.approvals ?? [];
}

function setTargetApprovals(task: TaskState, target: ReviewTarget, approvals: ReviewerApproval[]): TaskState {
  if (target.kind === "final") return { ...task, finalReview: { ...task.finalReview, approvals } };
  return {
    ...task,
    checkpoints: task.checkpoints.map((checkpoint) => checkpoint.id === target.checkpointId ? { ...checkpoint, approvals } : checkpoint),
  };
}

function targetRecheck(task: TaskState, target: ReviewTarget): ReviewerRecheckRequirement | undefined {
  if (target.kind === "final") return task.finalReview.requiredRecheck;
  return task.checkpoints.find((c) => c.id === target.checkpointId)?.requiredRecheck;
}

function setTargetRecheck(task: TaskState, target: ReviewTarget, requiredRecheck?: ReviewerRecheckRequirement): TaskState {
  if (target.kind === "final") return { ...task, finalReview: { ...task.finalReview, ...(requiredRecheck ? { requiredRecheck } : { requiredRecheck: undefined }) } };
  return {
    ...task,
    checkpoints: task.checkpoints.map((checkpoint) => checkpoint.id === target.checkpointId
      ? { ...checkpoint, ...(requiredRecheck ? { requiredRecheck } : { requiredRecheck: undefined }) }
      : checkpoint),
  };
}

function setRequiredRecheck(task: TaskState, target: ReviewTarget, dispatchResult: ReviewDispatchResult, parsed: StructuredReviewResult, now = new Date().toISOString()): TaskState {
  const sessionId = dispatchResult.result.sessionId;
  if (!sessionId) throw new HarnessError("SESSION_ID_MISSING", "Reviewer completed without a resumable session ID.");
  const requiredRecheck: ReviewerRecheckRequirement = {
    reviewerId: reviewerId(dispatchResult.reviewer),
    provider: dispatchResult.reviewer.provider,
    model: dispatchResult.reviewer.model,
    sessionId,
    findingIds: parsed.findings.map((finding) => finding.id),
    requestedAt: now,
  };
  const approvals = targetApprovals(task, target).filter((approval) => approval.reviewerId !== requiredRecheck.reviewerId);
  return setTargetRecheck(setTargetApprovals(task, target, approvals), target, requiredRecheck);
}

function clearRequiredRecheck(task: TaskState, target: ReviewTarget): TaskState {
  return setTargetRecheck(task, target, undefined);
}

function canonicalizeDispatchReviewer(dispatchResult: ReviewDispatchResult, candidates: ReviewerCandidate[]): ReviewDispatchResult {
  const exact = candidates.find((candidate) => reviewerId(candidate) === reviewerId(dispatchResult.reviewer));
  if (exact) return { ...dispatchResult, reviewer: exact };
  const sameProviderModel = candidates.filter((candidate) => candidate.provider === dispatchResult.reviewer.provider && candidate.model === dispatchResult.reviewer.model);
  if (sameProviderModel.length === 1) return { ...dispatchResult, reviewer: sameProviderModel[0] };
  return dispatchResult;
}

function requiredRecheckCandidate(task: TaskState, target: ReviewTarget, candidates: ReviewerCandidate[]): ReviewerCandidate | undefined {
  const required = targetRecheck(task, target);
  if (!required) return undefined;
  const candidate = candidates.find((item) => reviewerId(item) === required.reviewerId && item.provider === required.provider && item.model === required.model);
  if (!candidate) throw new HarnessError("RECHECK_REVIEWER_REQUIRED", `Reviewer ${required.reviewerId} must recheck findings ${required.findingIds.join(", ")} before this gate can complete.`);
  return candidate;
}

function addApproval(task: TaskState, target: ReviewTarget, candidate: ReviewerCandidate, sessionId: string, sourceFingerprint: string, now = new Date().toISOString()): TaskState {
  const id = reviewerId(candidate);
  const approvals = targetApprovals(task, target).filter((approval) => approval.reviewerId !== id);
  approvals.push({ reviewerId: id, provider: candidate.provider, model: candidate.model, sessionId, sourceFingerprint, approvedAt: now });
  return setTargetApprovals(task, target, approvals);
}

function finishApprovedTarget(task: TaskState, target: ReviewTarget, sourceFingerprint: string): { task: TaskState; nextAction: OrchestratedReviewResult["nextAction"] } {
  task = applyReviewVerdict(task, "reviewer", "APPROVED", target.kind === "checkpoint" ? target.checkpointId : undefined, sourceFingerprint);
  if (task.review.level === "LIGHT") return { task: transitionTask(task, "COMPLETED"), nextAction: "COMPLETED" };
  if (target.kind === "checkpoint") {
    const remaining = task.checkpoints.filter((c) => c.verdict !== "APPROVED");
    task = transitionTask(task, "IN_PROGRESS");
    task = { ...task, activeCheckpointId: remaining[0]?.id };
    return { task, nextAction: remaining.length ? "NEXT_CHECKPOINT" : "FINAL_REVIEW" };
  }
  task = transitionTask(task, "COMPLETED");
  task = { ...task, activeCheckpointId: undefined };
  return { task, nextAction: "COMPLETED" };
}

function finishRevisedTarget(task: TaskState, target: ReviewTarget, dispatchResult: ReviewDispatchResult, parsed: StructuredReviewResult): TaskState {
  task = applyReviewVerdict(task, "reviewer", "REVISE", target.kind === "checkpoint" ? target.checkpointId : undefined);
  task = setRequiredRecheck(task, target, dispatchResult, parsed);
  task = transitionTask(task, "IN_PROGRESS");
  return target.kind === "checkpoint" ? { ...task, activeCheckpointId: target.checkpointId } : task;
}

function approvalPolicy(root: string, task: TaskState, candidates: ReviewerCandidate[]): { approvalsRequired: number; maxReviewers: number } {
  let effective: { approvalsRequired: number; maxReviewers?: number };
  try {
    effective = effectiveReviewPolicy(loadConfig(root), task);
  } catch (error) {
    if (!(error instanceof HarnessError) || error.code !== "CONFIG_VALIDATION_ERROR") throw error;
    const fallbackBase = task.review.level === "NONE" ? 0 : 1;
    effective = {
      approvalsRequired: task.review.policyOverride?.approvalsRequired ?? fallbackBase,
      maxReviewers: task.review.policyOverride?.maxReviewers ?? candidates.length,
    };
  }
  const maxReviewers = Math.min(effective.maxReviewers ?? candidates.length, candidates.length);
  if (effective.approvalsRequired > candidates.length) throw new HarnessError("APPROVAL_POLICY_UNSATISFIABLE", `Task requires ${effective.approvalsRequired} approvals but only ${candidates.length} reviewer candidates are available.`);
  if (effective.approvalsRequired > maxReviewers) throw new HarnessError("APPROVAL_POLICY_UNSATISFIABLE", `Task requires ${effective.approvalsRequired} approvals but maxReviewers is ${maxReviewers}.`);
  return { approvalsRequired: effective.approvalsRequired, maxReviewers };
}


function recoveredApprovedResult(root: string, task: TaskState, target: ReviewTarget, approvals: ReviewerApproval[], policy: { approvalsRequired: number; maxReviewers: number }, sourceFingerprint: string): OrchestratedReviewResult {
  const records = loadReviewIndex(root, task.id).reviews.filter((review) => review.result.verdict === "APPROVED" && review.sourceFingerprint === sourceFingerprint && review.target.kind === target.kind && (target.kind === "final" || (review.target.kind === "checkpoint" && review.target.checkpointId === target.checkpointId)));
  const review = records.at(-1);
  if (!review) throw new HarnessError("APPROVAL_STATE_INCONSISTENT", "Task contains valid reviewer approvals but no matching recorded review artifact.");
  const candidate: ReviewerCandidate = { ...(review.reviewer.name ? { name: review.reviewer.name } : {}), provider: review.reviewer.provider, model: review.reviewer.model };
  const dispatch: ReviewDispatchResult = { reviewer: candidate, result: { provider: review.reviewer.provider, success: true, sessionId: review.reviewer.sessionId, response: review.rawResponse, rawStdout: "", rawStderr: "", exitCode: 0 }, attempts: [] };
  if (targetRecheck(task, target)) throw new HarnessError("RECHECK_REQUIRED", "A reviewer that requested changes must approve the fix before this gate can complete.");
  const completed = finishApprovedTarget(task, target, sourceFingerprint);
  saveActiveTask(root, completed.task);
  return { dispatch, review, dispatches: [], reviews: [], approvalProgress: { approvalsRequired: policy.approvalsRequired, maxReviewers: policy.maxReviewers, approvals: approvals.map((approval) => approval.reviewerId), completedReviews: approvals.length }, taskStatus: completed.task.status, nextAction: completed.nextAction };
}
function promptFor(root: string, task: TaskState, target: ReviewTarget, source: ReturnType<typeof inspectGit>, extraRequest: string, approvals: ReviewerApproval[]) {
  return (candidate: ReviewerCandidate, session?: SessionRecord) => compileReviewerPrompt(
    root,
    task,
    target,
    source,
    [extraRequest, `Approval progress before this review: ${approvals.length} approval(s). Independently verify the source; prior approvals are not authority.`].filter(Boolean).join("\n"),
    candidate.provider,
    candidate.model,
    session,
  );
}

function recordDecision(root: string, task: TaskState, target: ReviewTarget, sourceFingerprint: string, dispatchResult: ReviewDispatchResult, parsed: StructuredReviewResult): RecordedReview {
  const sessionId = dispatchResult.result.sessionId;
  if (!sessionId) throw new HarnessError("SESSION_ID_MISSING", "Reviewer completed without a resumable session ID.");
  return recordReview(root, {
    taskId: task.id,
    target,
    reviewer: { ...(dispatchResult.reviewer.name ? { name: dispatchResult.reviewer.name } : {}), provider: dispatchResult.reviewer.provider, model: dispatchResult.reviewer.model, sessionId },
    sourceFingerprint,
    result: parsed,
    rawResponse: dispatchResult.result.response,
  });
}

function prepare(root: string, target: ReviewTarget, candidates: ReviewerCandidate[]) {
  let task = loadActiveTask(root);
  if (!task) throw new HarnessError("NO_ACTIVE_TASK", "No active task is available for review.");
  const refreshed = refreshStaleApprovals(root, task);
  task = refreshed.task;
  if (refreshed.invalidated.length) saveActiveTask(root, task);
  if (task.status !== "READY_FOR_REVIEW") throw new HarnessError("INVALID_REVIEW_STAGE", `Task must be READY_FOR_REVIEW, got ${task.status}.`);
  assertTarget(task, target);
  if (!candidates.length) throw new HarnessError("NO_REVIEWER", "No reviewer candidates are configured.");
  try {
    const configured = loadConfig(root).agents?.reviewers ?? [];
    if (configured.length) {
      const actual = candidates.map((candidate) => ({ name: candidate.name, provider: candidate.provider, model: candidate.model }));
      const expected = configured.map((profile) => ({ name: profile.name, provider: profile.provider, model: profile.model }));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new HarnessError("REVIEWER_POLICY_MISMATCH", "Review candidates must exactly match the configured project reviewer order. Change project profiles/order explicitly instead of overriding them for one gate.");
      }
    }
  } catch (error) {
    if (error instanceof HarnessError && error.code === "CONFIG_VALIDATION_ERROR") {
      // Legacy/direct tests without a complete config continue to use explicit candidates.
    } else throw error;
  }
  const checkpoint = target.kind === "checkpoint" ? task.checkpoints.find((c) => c.id === target.checkpointId) : undefined;
  const source = inspectGit(root, checkpoint?.scope);
  const policy = approvalPolicy(root, task, candidates);
  return { task, source, policy };
}

export function orchestrateReview(
  root: string,
  target: ReviewTarget,
  candidates: ReviewerCandidate[],
  adapters: Record<string, AgentAdapter>,
  extraRequest = "",
  requestId = `review-${Date.now()}`,
  dispatch = dispatchReview,
): OrchestratedReviewResult {
  let { task, source, policy } = prepare(root, target, candidates);
  let approvals = targetApprovals(task, target).filter((approval) => approval.sourceFingerprint === source.fingerprint);
  task = setTargetApprovals(task, target, approvals); saveActiveTask(root, task);
  const requiredRecheck = requiredRecheckCandidate(task, target, candidates);
  if (!requiredRecheck && approvals.length >= policy.approvalsRequired) return recoveredApprovedResult(root, task, target, approvals, policy, source.fingerprint);

  const dispatches: ReviewDispatchResult[] = [];
  const reviews: RecordedReview[] = [];
  let completedReviews = approvals.length;
  let cursor = 0;
  let lastDispatch: ReviewDispatchResult | undefined;
  let lastReview: RecordedReview | undefined;

  while ((approvals.length < policy.approvalsRequired || targetRecheck(task, target)) && completedReviews < policy.maxReviewers) {
    const recheckCandidate = requiredRecheckCandidate(task, target, candidates);
    const wasRecheck = Boolean(recheckCandidate);
    while (!recheckCandidate && cursor < candidates.length && approvals.some((approval) => approval.reviewerId === reviewerId(candidates[cursor]))) cursor += 1;
    if (!recheckCandidate && cursor >= candidates.length) break;
    const remaining = recheckCandidate
      ? [recheckCandidate]
      : candidates.slice(cursor).filter((candidate) => !approvals.some((approval) => approval.reviewerId === reviewerId(candidate)));
    if (!remaining.length) break;
    const fullSourceBefore = inspectGit(root);
    const rawDispatchResult = dispatch(root, promptFor(root, task, target, source, extraRequest, approvals), remaining, adapters, `${requestId}-${dispatches.length + 1}`);
    const dispatchResult = canonicalizeDispatchReviewer(rawDispatchResult, candidates);
    lastDispatch = dispatchResult; dispatches.push(dispatchResult);
    if (!dispatchResult.result.success) throw new HarnessError(dispatchResult.result.failureCode ?? "REVIEW_EXECUTION_FAILED", "Independent reviewer did not complete successfully.");
    const fullSourceAfter = inspectGit(root);
    if (fullSourceAfter.fingerprint !== fullSourceBefore.fingerprint) throw new HarnessError("SOURCE_CHANGED_DURING_REVIEW", "Source fingerprint changed while the read-only review was running; verdict was not recorded.");
    const parsed = parseStructuredReviewResult(dispatchResult.result.response);
    const review = recordDecision(root, task, target, source.fingerprint, dispatchResult, parsed);
    lastReview = review; reviews.push(review); completedReviews += 1;
    const usedId = reviewerId(dispatchResult.reviewer);
    const usedIndex = candidates.findIndex((candidate, index) => index >= cursor && reviewerId(candidate) === usedId);
    cursor = wasRecheck ? 0 : (usedIndex >= 0 ? usedIndex + 1 : cursor + 1);

    if (parsed.verdict === "REVISE") {
      task = finishRevisedTarget(task, target, dispatchResult, parsed); saveActiveTask(root, task);
      return { dispatch: dispatchResult, review, dispatches, reviews, approvalProgress: { approvalsRequired: policy.approvalsRequired, maxReviewers: policy.maxReviewers, approvals: approvals.map((a) => a.reviewerId), completedReviews }, taskStatus: task.status, nextAction: "FIX" };
    }

    const sessionId = dispatchResult.result.sessionId!;
    task = addApproval(task, target, dispatchResult.reviewer, sessionId, source.fingerprint);
    const required = targetRecheck(task, target);
    if (required && required.reviewerId === reviewerId(dispatchResult.reviewer)) task = clearRequiredRecheck(task, target);
    approvals = targetApprovals(task, target);
    saveActiveTask(root, task);
  }

  if (!lastDispatch || !lastReview) throw new HarnessError("APPROVAL_THRESHOLD_UNMET", `Approval threshold ${approvals.length}/${policy.approvalsRequired} could not be satisfied by configured reviewers.`);
  if (targetRecheck(task, target)) throw new HarnessError("RECHECK_REQUIRED", "A reviewer that requested changes must approve the fix before this gate can complete.");
  if (approvals.length < policy.approvalsRequired) throw new HarnessError("APPROVAL_THRESHOLD_UNMET", `Approval threshold ${approvals.length}/${policy.approvalsRequired} was not reached before maxReviewers=${policy.maxReviewers}.`);

  const completed = finishApprovedTarget(task, target, source.fingerprint); task = completed.task; saveActiveTask(root, task);
  return { dispatch: lastDispatch, review: lastReview, dispatches, reviews, approvalProgress: { approvalsRequired: policy.approvalsRequired, maxReviewers: policy.maxReviewers, approvals: approvals.map((a) => a.reviewerId), completedReviews }, taskStatus: task.status, nextAction: completed.nextAction };
}

export interface AsyncOrchestratedReviewOptions {
  timeoutMs?: number;
  terminateGraceMs?: number;
}

export async function orchestrateReviewAsync(
  root: string,
  target: ReviewTarget,
  candidates: ReviewerCandidate[],
  adapters: Record<string, AgentAdapter>,
  extraRequest = "",
  requestId = `review-${Date.now()}`,
  options: AsyncOrchestratedReviewOptions = {},
): Promise<OrchestratedReviewResult> {
  const { dispatchReviewAsync } = await import("./dispatcher.js");
  let { task, source, policy } = prepare(root, target, candidates);
  let approvals = targetApprovals(task, target).filter((approval) => approval.sourceFingerprint === source.fingerprint);
  task = setTargetApprovals(task, target, approvals); saveActiveTask(root, task);
  const requiredRecheck = requiredRecheckCandidate(task, target, candidates);
  if (!requiredRecheck && approvals.length >= policy.approvalsRequired) return recoveredApprovedResult(root, task, target, approvals, policy, source.fingerprint);

  const dispatches: ReviewDispatchResult[] = [];
  const reviews: RecordedReview[] = [];
  let completedReviews = approvals.length;
  let cursor = 0;
  let lastDispatch: ReviewDispatchResult | undefined;
  let lastReview: RecordedReview | undefined;

  while ((approvals.length < policy.approvalsRequired || targetRecheck(task, target)) && completedReviews < policy.maxReviewers) {
    const recheckCandidate = requiredRecheckCandidate(task, target, candidates);
    const wasRecheck = Boolean(recheckCandidate);
    while (!recheckCandidate && cursor < candidates.length && approvals.some((approval) => approval.reviewerId === reviewerId(candidates[cursor]))) cursor += 1;
    if (!recheckCandidate && cursor >= candidates.length) break;
    const remaining = recheckCandidate
      ? [recheckCandidate]
      : candidates.slice(cursor).filter((candidate) => !approvals.some((approval) => approval.reviewerId === reviewerId(candidate)));
    if (!remaining.length) break;
    const fullSourceBefore = inspectGit(root);
    const rawDispatchResult = await dispatchReviewAsync(root, promptFor(root, task, target, source, extraRequest, approvals), remaining, adapters, `${requestId}-${dispatches.length + 1}`, options);
    const dispatchResult = canonicalizeDispatchReviewer(rawDispatchResult, candidates);
    lastDispatch = dispatchResult; dispatches.push(dispatchResult);
    if (!dispatchResult.result.success) throw new HarnessError(dispatchResult.result.failureCode ?? "REVIEW_EXECUTION_FAILED", "Independent reviewer did not complete successfully.");
    const fullSourceAfter = inspectGit(root);
    if (fullSourceAfter.fingerprint !== fullSourceBefore.fingerprint) throw new HarnessError("SOURCE_CHANGED_DURING_REVIEW", "Source fingerprint changed while the read-only review was running; verdict was not recorded.");
    const parsed = parseStructuredReviewResult(dispatchResult.result.response);
    const review = recordDecision(root, task, target, source.fingerprint, dispatchResult, parsed);
    lastReview = review; reviews.push(review); completedReviews += 1;
    const usedId = reviewerId(dispatchResult.reviewer);
    const usedIndex = candidates.findIndex((candidate, index) => index >= cursor && reviewerId(candidate) === usedId);
    cursor = wasRecheck ? 0 : (usedIndex >= 0 ? usedIndex + 1 : cursor + 1);

    if (parsed.verdict === "REVISE") {
      task = finishRevisedTarget(task, target, dispatchResult, parsed); saveActiveTask(root, task);
      return { dispatch: dispatchResult, review, dispatches, reviews, approvalProgress: { approvalsRequired: policy.approvalsRequired, maxReviewers: policy.maxReviewers, approvals: approvals.map((a) => a.reviewerId), completedReviews }, taskStatus: task.status, nextAction: "FIX" };
    }

    task = addApproval(task, target, dispatchResult.reviewer, dispatchResult.result.sessionId!, source.fingerprint);
    const required = targetRecheck(task, target);
    if (required && required.reviewerId === reviewerId(dispatchResult.reviewer)) task = clearRequiredRecheck(task, target);
    approvals = targetApprovals(task, target); saveActiveTask(root, task);
  }

  if (targetRecheck(task, target)) throw new HarnessError("RECHECK_REQUIRED", "A reviewer that requested changes must approve the fix before this gate can complete.");
  if (!lastDispatch || !lastReview || approvals.length < policy.approvalsRequired) throw new HarnessError("APPROVAL_THRESHOLD_UNMET", `Approval threshold ${approvals.length}/${policy.approvalsRequired} was not reached before maxReviewers=${policy.maxReviewers}.`);
  const completed = finishApprovedTarget(task, target, source.fingerprint); task = completed.task; saveActiveTask(root, task);
  return { dispatch: lastDispatch, review: lastReview, dispatches, reviews, approvalProgress: { approvalsRequired: policy.approvalsRequired, maxReviewers: policy.maxReviewers, approvals: approvals.map((a) => a.reviewerId), completedReviews }, taskStatus: task.status, nextAction: completed.nextAction };
}
