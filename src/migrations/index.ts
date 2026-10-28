import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "../core/types.js";
import { defaultReviewPolicy } from "../core/config.js";

export interface MigrationStep {
  id: string;
  toVersion: string;
  description: string;
  apply(config: ProjectConfig): boolean;
}

export interface MigrationHistoryEntry {
  id: string;
  fromVersion: string;
  toVersion: string;
  appliedAt: string;
}

export interface MigrationHistoryFile { schemaVersion: 1; entries: MigrationHistoryEntry[] }

const steps: MigrationStep[] = [
  {
    id: "M020-agents",
    toVersion: "0.2.0",
    description: "Add provider-neutral agent profile container.",
    apply(config) {
      if (config.agents) return false;
      config.agents = { reviewers: [] };
      return true;
    },
  },
  {
    id: "M030-orchestration",
    toVersion: "0.3.0",
    description: "Add orchestration review-round defaults.",
    apply(config) {
      let changed = false;
      config.orchestration ??= {};
      if (!config.orchestration.maxReviewRounds) { config.orchestration.maxReviewRounds = 3; changed = true; }
      return changed;
    },
  },
  {
    id: "M050-runtime",
    toVersion: "0.5.0",
    description: "Add crash-safe runtime timeout/grace defaults.",
    apply(config) {
      let changed = false;
      config.runtime ??= {};
      if (!config.runtime.agentTimeoutMs) { config.runtime.agentTimeoutMs = 900000; changed = true; }
      if (!config.runtime.terminateGraceMs) { config.runtime.terminateGraceMs = 3000; changed = true; }
      return changed;
    },
  },
  {
    id: "M060-context",
    toVersion: "0.6.0",
    description: "Add session-context compaction threshold.",
    apply(config) {
      config.context ??= {};
      if (config.context.compactionThresholdEstimatedTokens) return false;
      config.context.compactionThresholdEstimatedTokens = 60000;
      return true;
    },
  },
  {
    id: "M070-operator",
    toVersion: "0.7.0",
    description: "Add event retention and provider catalog cache defaults.",
    apply(config) {
      let changed = false;
      config.events ??= {};
      if (!config.events.retainEntries) { config.events.retainEntries = 5000; changed = true; }
      config.catalog ??= {};
      if (!config.catalog.cacheTtlMs) { config.catalog.cacheTtlMs = 300000; changed = true; }
      return changed;
    },
  },
  {
    id: "M080-operator-ci",
    toVersion: "0.8.0",
    description: "Add operator dashboard and multi-workspace scheduler defaults.",
    apply(config) {
      let changed = false;
      config.operator ??= {};
      if (!config.operator.refreshIntervalMs) { config.operator.refreshIntervalMs = 1000; changed = true; }
      if (!config.operator.eventLimit) { config.operator.eventLimit = 12; changed = true; }
      config.scheduler ??= {};
      if (!config.scheduler.maxParallel) { config.scheduler.maxParallel = 2; changed = true; }
      return changed;
    },
  },
  {
    id: "M081-adaptive-review",
    toVersion: "0.8.1",
    description: "Add ordered-threshold adaptive review policy defaults and pluggable reviewer providers.",
    apply(config) {
      if (config.reviewPolicy) return false;
      config.reviewPolicy = defaultReviewPolicy();
      return true;
    },
  },
  {
    id: "M082-plan-native",
    toVersion: "0.8.2",
    description: "Add plan-native analysis/task decomposition support with optional planner profile.",
    apply(config) {
      config.agents ??= { reviewers: [] };
      config.agents.reviewers ??= [];
      return false;
    },
  },
  {
    id: "M083-plan-logical-workspace",
    toVersion: "0.8.3",
    description: "Move plan-generated task artifacts into self-contained plan logical workspaces.",
    apply(config) {
      return false;
    },
  },
];

function tuple(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported harness version format: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): number {
  const aa = tuple(a), bb = tuple(b);
  for (let i = 0; i < 3; i += 1) if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  return 0;
}

export function migrationPlan(fromVersion: string, toVersion = "0.8.3"): MigrationStep[] {
  if (compareVersions(fromVersion, toVersion) > 0) throw new Error(`Refusing downgrade migration ${fromVersion} -> ${toVersion}.`);
  return steps.filter((step) => compareVersions(step.toVersion, fromVersion) > 0 && compareVersions(step.toVersion, toVersion) <= 0);
}

export function applyMigrationPlan(config: ProjectConfig, fromVersion: string, toVersion = "0.8.3"): { config: ProjectConfig; applied: MigrationStep[] } {
  const applied: MigrationStep[] = [];
  for (const step of migrationPlan(fromVersion, toVersion)) {
    step.apply(config);
    applied.push(step);
  }
  config.agents ??= { reviewers: [] };
  config.agents.reviewers ??= [];
  config.harness.version = toVersion;
  return { config, applied };
}

export function migrationHistoryPath(root: string): string { return join(root, ".harness", "state", "migrations.json"); }

export function loadMigrationHistory(root: string): MigrationHistoryFile {
  const path = migrationHistoryPath(root);
  if (!existsSync(path)) return { schemaVersion: 1, entries: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as MigrationHistoryFile;
    return value.schemaVersion === 1 && Array.isArray(value.entries) ? value : { schemaVersion: 1, entries: [] };
  } catch { return { schemaVersion: 1, entries: [] }; }
}

export function recordMigrations(root: string, fromVersion: string, applied: MigrationStep[], now = new Date().toISOString()): MigrationHistoryFile {
  const history = loadMigrationHistory(root);
  let previous = fromVersion;
  for (const step of applied) {
    history.entries.push({ id: step.id, fromVersion: previous, toVersion: step.toVersion, appliedAt: now });
    previous = step.toVersion;
  }
  mkdirSync(join(root, ".harness", "state"), { recursive: true });
  writeFileSync(migrationHistoryPath(root), `${JSON.stringify(history, null, 2)}\n`);
  return history;
}

export function migrationMatrix(): { from: string; to: string; steps: string[] }[] {
  const versions = ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.7.0", "0.8.0", "0.8.1", "0.8.2"];
  return versions.map((from) => ({ from, to: "0.8.3", steps: migrationPlan(from, "0.8.3").map((step) => step.id) }));
}
