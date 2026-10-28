import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider } from "../agents/types.js";
import type { StructuredReviewResult } from "./result.js";
import { taskScopedPath } from "../plans/workspace.js";

export type ReviewTarget = { kind: "checkpoint"; checkpointId: string } | { kind: "final" };

export interface RecordedReview {
  schemaVersion: 1;
  taskId: string;
  round: number;
  target: ReviewTarget;
  reviewer: { name?: string; provider: AgentProvider; model: string; sessionId: string };
  sourceFingerprint: string;
  recordedAt: string;
  result: StructuredReviewResult;
  rawResponse: string;
}

interface ReviewIndex { schemaVersion: 1; reviews: RecordedReview[] }

function dir(root: string, taskId: string): string { return taskScopedPath(root, taskId, ["reviews"], ["handoff", taskId, "reviews"]); }
function indexPath(root: string, taskId: string): string { return join(dir(root, taskId), "index.json"); }

export function loadReviewIndex(root: string, taskId: string): ReviewIndex {
  const path = indexPath(root, taskId);
  if (!existsSync(path)) return { schemaVersion: 1, reviews: [] };
  return JSON.parse(readFileSync(path, "utf8")) as ReviewIndex;
}

export function recordReview(root: string, input: Omit<RecordedReview, "schemaVersion" | "round" | "recordedAt">, now = new Date().toISOString()): RecordedReview {
  const index = loadReviewIndex(root, input.taskId);
  const round = index.reviews.length + 1;
  const record: RecordedReview = { schemaVersion: 1, round, recordedAt: now, ...input };
  index.reviews.push(record);
  mkdirSync(dir(root, input.taskId), { recursive: true });
  const file = join(dir(root, input.taskId), `review-${String(round).padStart(2, "0")}.json`);
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(indexPath(root, input.taskId), `${JSON.stringify(index, null, 2)}\n`);
  return record;
}
