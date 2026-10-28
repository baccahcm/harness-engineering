import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskState } from "../core/types.js";
import type { GitSnapshot } from "../git/git.js";
import type { ReviewTarget } from "./artifacts.js";
import { structuredReviewInstruction } from "./result.js";
import { taskScopedPath, relativeHarnessPath } from "../plans/workspace.js";

export function evidenceSummary(root: string, taskId?: string): string[] {
  const indexPath = taskId ? taskScopedPath(root, taskId, ["evidence", "index.json"], ["evidence", "index.json"]) : join(root, ".harness", "evidence", "index.json");
  if (!existsSync(indexPath)) return [];
  try {
    const value = JSON.parse(readFileSync(indexPath, "utf8")) as { runs?: { id: string; command: string; exitCode: number; sourceStable: boolean; sourceFingerprint?: string }[] };
    return (value.runs ?? []).map((run) => `${run.id}: exit=${run.exitCode}, stable=${run.sourceStable}, source=${run.sourceFingerprint ?? "unknown"}, command=${run.command}`);
  } catch { return [`Evidence index exists but could not be parsed; inspect ${relativeHarnessPath(root, indexPath)} directly.`]; }
}

export function buildReviewPacket(root: string, task: TaskState, target: ReviewTarget, snapshot: GitSnapshot, extraRequest = ""): string {
  const targetText = target.kind === "final" ? "FINAL whole-change gate" : `checkpoint ${target.checkpointId}`;
  const checkpointState = target.kind === "checkpoint" ? task.checkpoints.find((c) => c.id === target.checkpointId) : undefined;
  const scopeLines = checkpointState?.scope ? [
    `Checkpoint ownership include: ${checkpointState.scope.include.join(", ")}`,
    `Checkpoint ownership exclude: ${(checkpointState.scope.exclude ?? []).join(", ") || "none"}`,
    `Scoped files represented by fingerprint: ${snapshot.scopedFiles?.join(", ") || "none"}`,
    "Review the checkpoint scope plus affected callers/dependencies needed to judge correctness; do not expand implementation scope.",
  ] : [];
  const evidence = evidenceSummary(root, task.id);
  return [
    "Independent read-only engineering review.",
    `Task: ${task.id} — ${task.title}`,
    `Review-Level: ${task.review.level}`,
    `Target: ${targetText}`,
    `Task status: ${task.status}`,
    `Source fingerprint (authoritative, supplied by harness): ${snapshot.fingerprint}`,
    `HEAD: ${snapshot.head ?? "unborn"}; scopedDirty=${snapshot.dirty}; changed=${snapshot.changedFiles.join(", ") || "none"}`,
    ...scopeLines,
    checkpointState ? `Current checkpoint verdict: ${checkpointState.verdict}` : `Current final verdict: ${task.finalReview.verdict}`,
    "Acceptance criteria:",
    ...(task.acceptance.length ? task.acceptance.map((a) => `- ${a.id}: ${a.description}`) : ["- none recorded"]),
    "Recorded verification evidence:",
    ...(evidence.length ? evidence.map((e) => `- ${e}`) : ["- none indexed"]),
    "Review the actual source/diff and affected callers/tests. Treat developer claims as evidence to inspect, not authority. Do not edit application source.",
    extraRequest ? `Additional request: ${extraRequest}` : "",
    structuredReviewInstruction(),
  ].filter(Boolean).join("\n");
}
