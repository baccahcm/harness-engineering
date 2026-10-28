import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, AgentPurpose } from "../agents/types.js";
import { findSession, loadSessionRegistry, requestSessionRotation, saveSessionRegistry } from "../agents/session-registry.js";
import { HarnessError } from "../core/errors.js";
import { loadActiveTask } from "../core/store.js";
import { loadReviewIndex } from "../review/artifacts.js";
import { loadTurnMetrics } from "../metrics/store.js";
import { relativeHarnessPath, taskScopedPath } from "../plans/workspace.js";

export interface ContextSessionStatus {
  taskId: string;
  purpose: AgentPurpose;
  provider: AgentProvider;
  model: string;
  profileName?: string;
  sessionId: string;
  turns: number;
  estimatedPromptTokens: number;
  providerInputTokens: number | null;
  cachedInputTokens: number | null;
  compactionRecommended: boolean;
  rotationPending: boolean;
  summaryPath?: string;
}

export function contextStatus(root: string, thresholdEstimatedTokens = 60000): ContextSessionStatus[] {
  const task = loadActiveTask(root);
  if (!task) return [];
  const registry = loadSessionRegistry(root);
  const sessions = registry.tasks.find((entry) => entry.taskId === task.id)?.sessions ?? [];
  const metrics = loadTurnMetrics(root).filter((record) => record.taskId === task.id);
  return sessions.map((session) => {
    const turns = metrics.filter((record) => record.purpose === session.purpose && record.provider === session.provider && record.model === session.model && (session.purpose !== "reviewer" || (record.reviewerName ?? "") === (session.profileName ?? "")) && (record.sessionId ? record.sessionId === session.sessionId : !session.previousSessionIds?.length));
    const estimatedPromptTokens = turns.reduce((sum, record) => sum + (record.prompt?.estimatedInputTokens ?? 0), 0);
    const reportedInputs = turns.map((record) => record.usage?.inputTokens).filter((value): value is number => typeof value === "number");
    const cached = turns.map((record) => record.usage?.cachedInputTokens).filter((value): value is number => typeof value === "number");
    return {
      taskId: task.id,
      purpose: session.purpose,
      provider: session.provider,
      model: session.model,
      ...(session.profileName ? { profileName: session.profileName } : {}),
      sessionId: session.sessionId,
      turns: turns.length,
      estimatedPromptTokens,
      providerInputTokens: reportedInputs.length ? reportedInputs.reduce((a, b) => a + b, 0) : null,
      cachedInputTokens: cached.length ? cached.reduce((a, b) => a + b, 0) : null,
      compactionRecommended: estimatedPromptTokens >= thresholdEstimatedTokens,
      rotationPending: Boolean(session.rotation),
      ...(session.rotation?.summaryPath ? { summaryPath: session.rotation.summaryPath } : {}),
    };
  });
}

function contextDir(root: string, taskId: string): string { return taskScopedPath(root, taskId, ["context"], ["handoff", taskId, "context"]); }

export function buildContextSummary(root: string, purpose: AgentPurpose, provider: AgentProvider, model: string, now = new Date().toISOString(), profileName?: string): { path: string; content: string } {
  const task = loadActiveTask(root);
  if (!task) throw new HarnessError("NO_ACTIVE_TASK", "No active task is available for context compaction.");
  const registry = loadSessionRegistry(root);
  const session = findSession(registry, task.id, provider, model, purpose, profileName);
  if (!session) throw new HarnessError("SESSION_NOT_FOUND", `No ${purpose} session for ${provider}/${model}.`);
  const reviews = loadReviewIndex(root, task.id).reviews;
  const latestByTarget = new Map<string, (typeof reviews)[number]>();
  for (const review of reviews) {
    const key = review.target.kind === "final" ? "final" : `checkpoint:${review.target.checkpointId}`;
    latestByTarget.set(key, review);
  }
  const unresolved = [...latestByTarget.entries()].flatMap(([target, review]) => review.result.verdict === "REVISE"
    ? review.result.findings.map((finding) => `- ${target}/${finding.id} [${finding.severity}] ${finding.location ? `${finding.location}: ` : ""}${finding.description}`)
    : []);
  const content = [
    "# Engineering Harness compact session handoff",
    "",
    `Generated: ${now}`,
    `Task: ${task.id} — ${task.title}`,
    `Role: ${purpose}`,
    `Provider/model: ${provider}/${model}`,
    ...(session.profileName ? [`Reviewer profile: ${session.profileName}`] : []),
    `Previous session: ${session.sessionId}`,
    `Task status: ${task.status}`,
    `Review level: ${task.review.level}`,
    "",
    "## Acceptance criteria",
    ...(task.acceptance.length ? task.acceptance.map((item) => `- ${item.id}: ${item.description}`) : ["- none recorded"]),
    "",
    "## Checkpoints",
    ...(task.checkpoints.length ? task.checkpoints.map((checkpoint) => `- ${checkpoint.id}: ${checkpoint.verdict}${checkpoint.sourceFingerprint ? ` @ ${checkpoint.sourceFingerprint}` : ""}`) : ["- none"]),
    `- final: ${task.finalReview.verdict}${task.finalReview.sourceFingerprint ? ` @ ${task.finalReview.sourceFingerprint}` : ""}`,
    "",
    "## Unresolved findings",
    ...(unresolved.length ? unresolved : ["- none recorded"]),
    "",
    "## Review history summary",
    ...(reviews.length ? reviews.map((review) => {
      const target = review.target.kind === "final" ? "final" : `checkpoint:${review.target.checkpointId}`;
      return `- round ${review.round} ${target}: ${review.result.verdict} — ${review.result.summary}`;
    }) : ["- no reviews recorded"]),
    "",
    "Use this handoff as compact prior context. Re-inspect current source/evidence for the new round; do not treat this summary as proof that source is unchanged.",
  ].join("\n");
  const dir = contextDir(root, task.id);
  mkdirSync(dir, { recursive: true });
  const safe = `${purpose}-${provider}-${model}${session.profileName ? `-${session.profileName}` : ""}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const absolute = join(dir, `${safe}.md`);
  const relative = relativeHarnessPath(root, absolute);
  writeFileSync(absolute, `${content}\n`);
  return { path: relative, content };
}

export function compactSessionContext(root: string, purpose: AgentPurpose, provider: AgentProvider, model: string, profileName?: string): { summaryPath: string; previousSessionId: string } {
  const task = loadActiveTask(root);
  if (!task) throw new HarnessError("NO_ACTIVE_TASK", "No active task is available for context compaction.");
  const registry = loadSessionRegistry(root);
  const session = findSession(registry, task.id, provider, model, purpose, profileName);
  if (!session) throw new HarnessError("SESSION_NOT_FOUND", `No ${purpose} session for ${provider}/${model}.`);
  const summary = buildContextSummary(root, purpose, provider, model, new Date().toISOString(), profileName);
  requestSessionRotation(session, summary.path);
  saveSessionRegistry(root, registry);
  return { summaryPath: summary.path, previousSessionId: session.sessionId };
}

export function loadRotationSummary(root: string, summaryPath?: string): string | undefined {
  if (!summaryPath) return undefined;
  const path = join(root, summaryPath);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}
