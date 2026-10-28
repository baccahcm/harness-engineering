import { HarnessError } from "./errors.js";
import { normalizeScope } from "./scope.js";
import type { CheckpointScope, ReviewLevel, TaskState } from "./types.js";

export function createTask(id: string, title: string, level: ReviewLevel, reason: string, selectedBy: "user" | "team_leader" = "user"): TaskState {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new HarnessError("TASK_ID_INVALID", "Task ID may contain only letters, numbers, dot, underscore, and hyphen.");
  if (!title.trim()) throw new HarnessError("TASK_TITLE_INVALID", "Task title is required.");
  return {
    schemaVersion: 1,
    id,
    title,
    status: "DRAFT",
    review: { level, reason, selectedBy },
    acceptance: [],
    checkpoints: [],
    finalReview: { verdict: "PENDING" },
  };
}

export function addCheckpoint(task: TaskState, id: string, scope?: CheckpointScope): TaskState {
  if (task.review.level !== "FULL") throw new HarnessError("CHECKPOINT_NOT_ALLOWED", "Only FULL tasks use checkpoint review gates.");
  if (!id.trim()) throw new HarnessError("CHECKPOINT_INVALID", "Checkpoint ID is required.");
  if (task.checkpoints.some((c) => c.id === id)) throw new HarnessError("CHECKPOINT_EXISTS", `Checkpoint already exists: ${id}`);
  const checkpoint = { id, verdict: "PENDING" as const, ...(scope ? { scope: normalizeScope(scope) } : {}) };
  return { ...task, checkpoints: [...task.checkpoints, checkpoint] };
}

export function setCheckpointScope(task: TaskState, id: string, scope: CheckpointScope): TaskState {
  if (task.review.level !== "FULL") throw new HarnessError("CHECKPOINT_NOT_ALLOWED", "Only FULL tasks use checkpoint ownership scopes.");
  const normalized = normalizeScope(scope);
  let found = false;
  const checkpoints = task.checkpoints.map((checkpoint) => {
    if (checkpoint.id !== id) return checkpoint;
    found = true;
    // Changing scope changes what was reviewed, so any existing approval becomes stale immediately.
    return { ...checkpoint, scope: normalized, verdict: "PENDING" as const, sourceFingerprint: undefined };
  });
  if (!found) throw new HarnessError("CHECKPOINT_UNKNOWN", `Unknown checkpoint: ${id}`);
  return { ...task, checkpoints };
}

export function activateCheckpoint(task: TaskState, id: string): TaskState {
  if (task.review.level !== "FULL") throw new HarnessError("CHECKPOINT_NOT_ALLOWED", "Only FULL tasks have an active checkpoint.");
  const checkpoint = task.checkpoints.find((c) => c.id === id);
  if (!checkpoint) throw new HarnessError("CHECKPOINT_UNKNOWN", `Unknown checkpoint: ${id}`);
  if (checkpoint.verdict === "APPROVED") throw new HarnessError("CHECKPOINT_ALREADY_APPROVED", `Checkpoint is already approved: ${id}`);
  return { ...task, activeCheckpointId: id };
}

export function addAcceptanceCriterion(task: TaskState, id: string, description: string): TaskState {
  if (!id.trim() || !description.trim()) throw new HarnessError("ACCEPTANCE_INVALID", "Acceptance ID and description are required.");
  if (task.acceptance.some((a) => a.id === id)) throw new HarnessError("ACCEPTANCE_EXISTS", `Acceptance criterion already exists: ${id}`);
  return { ...task, acceptance: [...task.acceptance, { id, description }] };
}

export function setTaskReviewPolicyOverride(
  task: TaskState,
  override: { approvalsRequired?: number; maxReviewers?: number } | undefined,
  selectedBy: "user" | "team_leader" = "user",
): TaskState {
  if (task.status === "COMPLETED") throw new HarnessError("TASK_COMPLETED", "Review policy override cannot be changed after task completion; create a new review task if stronger assurance is required.");
  if (!override) {
    const review = { ...task.review };
    delete review.policyOverride;
    return { ...task, review };
  }
  const approvalsRequired = override.approvalsRequired;
  const maxReviewers = override.maxReviewers;
  if (approvalsRequired !== undefined && (!Number.isInteger(approvalsRequired) || approvalsRequired < 0)) throw new HarnessError("REVIEW_POLICY_INVALID", "approvalsRequired must be a non-negative integer.");
  if (maxReviewers !== undefined && (!Number.isInteger(maxReviewers) || maxReviewers < 0)) throw new HarnessError("REVIEW_POLICY_INVALID", "maxReviewers must be a non-negative integer.");
  if (approvalsRequired !== undefined && maxReviewers !== undefined && approvalsRequired > maxReviewers) throw new HarnessError("REVIEW_POLICY_INVALID", "approvalsRequired cannot exceed maxReviewers.");
  if (task.review.level === "NONE" && (approvalsRequired ?? 0) !== 0) throw new HarnessError("REVIEW_POLICY_INVALID", "NONE tasks cannot require reviewer approvals.");
  return { ...task, review: { ...task.review, policyOverride: { ...override, selectedBy } } };
}
