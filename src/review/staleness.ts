import type { ReviewerApproval, TaskState } from "../core/types.js";
import { inspectGit } from "../git/git.js";
import { effectiveReviewPolicy, loadConfig } from "../core/config.js";
import { HarnessError } from "../core/errors.js";
import { loadReviewIndex } from "./artifacts.js";

export interface StalenessResult {
  task: TaskState;
  invalidated: string[];
}

function currentApprovals(approvals: ReviewerApproval[] | undefined, fingerprint: string, label: string, invalidated: string[]): ReviewerApproval[] | undefined {
  if (!approvals?.length) return approvals;
  const kept = approvals.filter((approval) => approval.sourceFingerprint === fingerprint);
  for (const approval of approvals) if (approval.sourceFingerprint !== fingerprint) invalidated.push(`${label}:reviewer:${approval.reviewerId}`);
  return kept.length ? kept : undefined;
}

function requiredApprovals(root: string, task: TaskState): number {
  try { return effectiveReviewPolicy(loadConfig(root), task).approvalsRequired; }
  catch (error) {
    if (!(error instanceof HarnessError) || error.code !== "CONFIG_VALIDATION_ERROR") throw error;
    return task.review.policyOverride?.approvalsRequired ?? (task.review.level === "NONE" ? 0 : 1);
  }
}

function hydrateLegacyApproval(root: string, task: TaskState, label: string, fingerprint: string | undefined): ReviewerApproval[] | undefined {
  if (!fingerprint) return undefined;
  const reviews = loadReviewIndex(root, task.id).reviews.filter((review) => {
    if (review.result.verdict !== "APPROVED" || review.sourceFingerprint !== fingerprint) return false;
    const reviewLabel = review.target.kind === "final" ? "final" : `checkpoint:${review.target.checkpointId}`;
    return reviewLabel === label;
  });
  const latest = reviews.at(-1);
  if (!latest) return undefined;
  return [{
    reviewerId: latest.reviewer.name ?? `${latest.reviewer.provider}/${latest.reviewer.model}`,
    provider: latest.reviewer.provider,
    model: latest.reviewer.model,
    sessionId: latest.reviewer.sessionId,
    sourceFingerprint: fingerprint,
    approvedAt: latest.recordedAt,
  }];
}

export function refreshStaleApprovals(root: string, task: TaskState): StalenessResult {
  const invalidated: string[] = [];
  const required = requiredApprovals(root, task);
  const checkpoints = task.checkpoints.map((checkpoint) => {
    const label = `checkpoint:${checkpoint.id}`;
    const current = inspectGit(root, checkpoint.scope).fingerprint;
    let approvals = checkpoint.approvals;
    if (!approvals?.length && checkpoint.verdict === "APPROVED") approvals = hydrateLegacyApproval(root, task, label, checkpoint.sourceFingerprint);
    approvals = currentApprovals(approvals, current, label, invalidated);
    if (checkpoint.verdict === "APPROVED" && checkpoint.sourceFingerprint && current !== checkpoint.sourceFingerprint) {
      invalidated.push(label);
      return { ...checkpoint, verdict: "PENDING" as const, sourceFingerprint: undefined, approvals };
    }
    if (checkpoint.verdict === "APPROVED" && required > 1 && (approvals?.length ?? 0) < required) {
      invalidated.push(`${label}:policy-threshold`);
      return { ...checkpoint, verdict: "PENDING" as const, sourceFingerprint: undefined, approvals };
    }
    return { ...checkpoint, approvals };
  });

  const finalCurrent = inspectGit(root).fingerprint;
  let finalApprovals = task.finalReview.approvals;
  if (!finalApprovals?.length && task.finalReview.verdict === "APPROVED") finalApprovals = hydrateLegacyApproval(root, task, "final", task.finalReview.sourceFingerprint);
  finalApprovals = currentApprovals(finalApprovals, finalCurrent, "final", invalidated);
  let finalReview = { ...task.finalReview, approvals: finalApprovals };
  if (task.finalReview.verdict === "APPROVED" && task.finalReview.sourceFingerprint && finalCurrent !== task.finalReview.sourceFingerprint) {
    invalidated.push("final");
    finalReview = { verdict: "PENDING", approvals: finalApprovals };
  } else if (task.finalReview.verdict === "APPROVED" && required > 1 && (finalApprovals?.length ?? 0) < required) {
    invalidated.push("final:policy-threshold");
    finalReview = { verdict: "PENDING", approvals: finalApprovals };
  }

  return { task: { ...task, checkpoints, finalReview }, invalidated };
}
