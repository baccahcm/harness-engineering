import { InvalidTransition, PolicyViolation } from "./errors.js";
import type { ActorRole, ReviewVerdict, TaskState, TaskStatus } from "./types.js";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  DRAFT: ["READY_FOR_DEV", "BLOCKED"],
  READY_FOR_DEV: ["IN_PROGRESS", "BLOCKED"],
  IN_PROGRESS: ["READY_FOR_REVIEW", "COMPLETED", "BLOCKED"],
  READY_FOR_REVIEW: ["IN_PROGRESS", "COMPLETED", "BLOCKED"],
  BLOCKED: ["DRAFT", "READY_FOR_DEV", "IN_PROGRESS", "READY_FOR_REVIEW"],
  COMPLETED: [],
};

export function assertTransition(task: TaskState, to: TaskStatus): void {
  if (!transitions[task.status].includes(to)) throw new InvalidTransition(task.status, to);

  if (to === "COMPLETED") {
    if (task.review.level === "NONE") {
      if (task.status !== "IN_PROGRESS") {
        throw new PolicyViolation("P010", "NONE tasks complete from IN_PROGRESS after proportional verification; they do not use review approval.");
      }
      return;
    }
    if (task.status !== "READY_FOR_REVIEW") {
      throw new PolicyViolation("P020", "Reviewed tasks can complete only from READY_FOR_REVIEW.");
    }
    if (task.review.level === "LIGHT" && task.finalReview.verdict !== "APPROVED") {
      throw new PolicyViolation("P011", "LIGHT task cannot complete without an independent whole-task approval.");
    }
    if (task.review.level === "FULL" && task.finalReview.verdict !== "APPROVED") {
      throw new PolicyViolation("P012", "FULL task cannot complete without final whole-change approval.");
    }
  }
}

export function transitionTask(task: TaskState, to: TaskStatus): TaskState {
  assertTransition(task, to);
  return { ...task, previousStatus: task.status, status: to };
}

export function applyReviewVerdict(
  task: TaskState,
  actor: ActorRole,
  verdict: ReviewVerdict,
  checkpointId?: string,
  sourceFingerprint?: string,
): TaskState {
  if (actor === "developer" && verdict === "APPROVED") {
    throw new PolicyViolation("P001", "Developer cannot approve its own work.");
  }
  if (task.review.level === "NONE" && verdict === "APPROVED") {
    throw new PolicyViolation("P010", "NONE review level never emits APPROVED.");
  }
  if (actor !== "reviewer" && actor !== "team_leader" && verdict !== "PENDING") {
    throw new PolicyViolation("P001", "Only an independent reviewer/team leader may issue review verdicts.");
  }
  if (task.status !== "READY_FOR_REVIEW" && verdict !== "PENDING") {
    throw new PolicyViolation("P020", "Review verdicts require task status READY_FOR_REVIEW.");
  }

  if (checkpointId) {
    const index = task.checkpoints.findIndex((c) => c.id === checkpointId);
    if (index < 0) throw new PolicyViolation("P020", `Unknown checkpoint: ${checkpointId}`);
    const checkpoints = task.checkpoints.map((c, i) =>
      i === index ? { ...c, verdict, sourceFingerprint: verdict === "APPROVED" ? sourceFingerprint : undefined } : c,
    );
    return { ...task, checkpoints };
  }

  return {
    ...task,
    finalReview: { ...task.finalReview, verdict, sourceFingerprint: verdict === "APPROVED" ? sourceFingerprint : undefined },
  };
}

export function invalidateStaleApprovals(task: TaskState, currentFingerprint: string): TaskState {
  const checkpoints = task.checkpoints.map((c) =>
    c.verdict === "APPROVED" && c.sourceFingerprint && c.sourceFingerprint !== currentFingerprint
      ? { ...c, verdict: "PENDING" as const, sourceFingerprint: undefined }
      : c,
  );
  const finalReview =
    task.finalReview.verdict === "APPROVED" && task.finalReview.sourceFingerprint && task.finalReview.sourceFingerprint !== currentFingerprint
      ? { ...task.finalReview, verdict: "PENDING" as const, sourceFingerprint: undefined }
      : task.finalReview;
  return { ...task, checkpoints, finalReview };
}
