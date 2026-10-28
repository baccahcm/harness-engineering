import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { activeTaskArtifactBase, executionArtifactBase } from "../plans/workspace.js";
import type { AgentProvider, AgentPurpose, AgentUsage } from "../agents/types.js";
import type { CompiledPromptMeta } from "../prompts/types.js";

export interface TurnMetricRecord {
  schemaVersion: 1;
  recordedAt: string;
  taskId: string;
  requestId: string;
  provider: AgentProvider;
  purpose: AgentPurpose;
  model: string;
  reviewerName?: string;
  sessionId?: string;
  success: boolean;
  prompt?: CompiledPromptMeta;
  usage?: AgentUsage;
  responseChars: number;
}

export function metricsPath(root: string): string {
  const taskBase = activeTaskArtifactBase(root);
  if (taskBase) return join(taskBase, "metrics", "turns.jsonl");
  const executionBase = executionArtifactBase(root);
  return executionBase ? join(executionBase, "metrics", "turns.jsonl") : join(root, ".harness", "metrics", "turns.jsonl");
}

export function recordTurnMetric(root: string, record: Omit<TurnMetricRecord, "schemaVersion" | "recordedAt">, now = new Date().toISOString()): TurnMetricRecord {
  const value: TurnMetricRecord = { schemaVersion: 1, recordedAt: now, ...record };
  const path = metricsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
  return value;
}

export function loadTurnMetrics(root: string): TurnMetricRecord[] {
  const path = metricsPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as TurnMetricRecord);
}

export interface MetricsSummary {
  turns: number;
  providerReportedTurns: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  estimatedPromptTokens: number;
  sessionReuseTurns: number;
}

export function summarizeMetrics(records: TurnMetricRecord[]): MetricsSummary {
  const withUsage = records.filter((record) => record.usage);
  const sumField = (field: "inputTokens" | "outputTokens" | "cachedInputTokens"): number | null => {
    const values = withUsage.map((record) => record.usage?.[field]).filter((value): value is number => typeof value === "number");
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  return {
    turns: records.length,
    providerReportedTurns: withUsage.length,
    inputTokens: sumField("inputTokens"),
    outputTokens: sumField("outputTokens"),
    cachedInputTokens: sumField("cachedInputTokens"),
    estimatedPromptTokens: records.reduce((sum, record) => sum + (record.prompt?.estimatedInputTokens ?? 0), 0),
    sessionReuseTurns: records.filter((record) => record.prompt?.reusedSession).length,
  };
}

export interface ReviewerMetricsSummary extends MetricsSummary {
  reviewerName: string;
  provider: AgentProvider;
  model: string;
}

export function summarizeMetricsByReviewer(records: TurnMetricRecord[]): ReviewerMetricsSummary[] {
  const groups = new Map<string, TurnMetricRecord[]>();
  for (const record of records) {
    if (record.purpose !== "reviewer") continue;
    const reviewerName = record.reviewerName ?? `${record.provider}/${record.model}`;
    const key = `${reviewerName}\u0000${record.provider}\u0000${record.model}`;
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [reviewerName, provider, model] = key.split("\u0000") as [string, AgentProvider, string];
    return { reviewerName, provider, model, ...summarizeMetrics(group) };
  });
}
