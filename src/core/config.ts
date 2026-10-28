import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigValidationError, HarnessError } from "./errors.js";
import { parseYaml, stringifyYaml } from "../util/yaml.js";
import type { AgentProfile, ProjectConfig, ReviewerProfile, ReviewLevel, ReviewLevelApprovalPolicy, TaskState } from "./types.js";

export function configPath(root: string): string { return join(root, ".harness", "config.yaml"); }

export function defaultReviewPolicy(): NonNullable<ProjectConfig["reviewPolicy"]> {
  return {
    strategy: "ordered_threshold",
    levels: {
      NONE: { approvalsRequired: 0, maxReviewers: 0 },
      LIGHT: { approvalsRequired: 1, maxReviewers: 1 },
      FULL: { approvalsRequired: 1, maxReviewers: 3 },
    },
    execution: { lazyDispatch: true, parallel: false, stopOnRevise: true, reuseSessions: true },
  };
}

export function loadConfig(root: string): ProjectConfig {
  const path = configPath(root);
  if (!existsSync(path)) throw new ConfigValidationError(".harness/config.yaml is missing. Run harness init.");
  const cfg = parseYaml(readFileSync(path, "utf8")) as unknown as ProjectConfig;
  if (cfg?.harness?.schemaVersion !== 1) throw new ConfigValidationError("Unsupported or missing schemaVersion.");
  if (!cfg.workflow?.defaultReviewLevel) throw new ConfigValidationError("workflow.defaultReviewLevel is missing.");
  if (cfg.agents?.developer) assertAgentProfile(cfg.agents.developer);
  if (cfg.agents?.planner) assertAgentProfile(cfg.agents.planner);
  for (const profile of cfg.agents?.reviewers ?? []) assertReviewerProfile(profile);
  if (cfg.reviewPolicy) assertProjectReviewPolicy(cfg.reviewPolicy, cfg.agents?.reviewers?.length ?? 0);
  return cfg;
}

export function saveConfig(root: string, config: ProjectConfig): void {
  writeFileSync(configPath(root), `${stringifyYaml(config as unknown as never)}\n`);
}

function assertProvider(provider: string): asserts provider is "claude" | "codex" | "antigravity" {
  if (provider !== "claude" && provider !== "codex" && provider !== "antigravity") throw new ConfigValidationError(`Unsupported agent provider: ${provider}`);
}

export function assertAgentProfile(profile: AgentProfile): void {
  assertProvider(profile.provider);
  if (!profile.model?.trim()) throw new ConfigValidationError("Agent profile model is required.");
}

export function assertReviewerProfile(profile: ReviewerProfile): void {
  assertAgentProfile(profile);
  if (!profile.name?.trim()) throw new ConfigValidationError("Reviewer profile name is required.");
}

function assertLevelPolicy(level: ReviewLevel, policy: ReviewLevelApprovalPolicy, reviewerCount: number): void {
  if (!Number.isInteger(policy.approvalsRequired) || policy.approvalsRequired < 0) throw new ConfigValidationError(`${level}.approvalsRequired must be a non-negative integer.`);
  if (policy.maxReviewers !== undefined && (!Number.isInteger(policy.maxReviewers) || policy.maxReviewers < 0)) throw new ConfigValidationError(`${level}.maxReviewers must be a non-negative integer.`);
  if (level === "NONE" && policy.approvalsRequired !== 0) throw new ConfigValidationError("NONE review level must require zero approvals.");
  const max = policy.maxReviewers ?? reviewerCount;
  if (policy.approvalsRequired > max) throw new ConfigValidationError(`${level}.approvalsRequired cannot exceed maxReviewers.`);
}

export function assertProjectReviewPolicy(policy: NonNullable<ProjectConfig["reviewPolicy"]>, reviewerCount = 0): void {
  if (policy.strategy !== "ordered_threshold") throw new ConfigValidationError(`Unsupported review strategy: ${policy.strategy}`);
  for (const level of ["NONE", "LIGHT", "FULL"] as const) {
    if (!policy.levels?.[level]) throw new ConfigValidationError(`reviewPolicy.levels.${level} is required.`);
    assertLevelPolicy(level, policy.levels[level], reviewerCount);
  }
  const execution = policy.execution;
  if (!execution || execution.lazyDispatch !== true || execution.parallel !== false || execution.stopOnRevise !== true || execution.reuseSessions !== true) {
    throw new ConfigValidationError("V0.8.1 requires lazyDispatch=true, parallel=false, stopOnRevise=true, reuseSessions=true.");
  }
}

export function setDeveloperProfile(root: string, profile: AgentProfile): ProjectConfig {
  assertAgentProfile(profile);
  const config = loadConfig(root);
  config.agents ??= {};
  config.agents.developer = profile;
  saveConfig(root, config);
  return config;
}


export function setPlannerProfile(root: string, profile: AgentProfile): ProjectConfig {
  assertAgentProfile(profile);
  const config = loadConfig(root);
  config.agents ??= {};
  config.agents.planner = profile;
  saveConfig(root, config);
  return config;
}

export function requirePlannerProfile(config: ProjectConfig): { profile: AgentProfile; source: "configured" | "primary-reviewer" } {
  if (config.agents?.planner) { assertAgentProfile(config.agents.planner); return { profile: config.agents.planner, source: "configured" }; }
  const reviewer = config.agents?.reviewers?.[0];
  if (reviewer) { assertReviewerProfile(reviewer); return { profile: { provider: reviewer.provider, model: reviewer.model }, source: "primary-reviewer" }; }
  throw new HarnessError("PLANNER_PROFILE_MISSING", "No planner profile is configured and no primary reviewer is available. Run harness profile set planner <provider> <model> or add a reviewer profile.");
}

export function upsertReviewerProfile(root: string, profile: ReviewerProfile): ProjectConfig {
  assertReviewerProfile(profile);
  const config = loadConfig(root);
  config.agents ??= {};
  config.agents.reviewers ??= [];
  const index = config.agents.reviewers.findIndex((item) => item.name === profile.name);
  if (index >= 0) config.agents.reviewers[index] = profile;
  else config.agents.reviewers.push(profile);
  if (config.reviewPolicy) assertProjectReviewPolicy(config.reviewPolicy, config.agents.reviewers.length);
  saveConfig(root, config);
  return config;
}

export function setReviewLevelPolicy(root: string, level: ReviewLevel, policy: ReviewLevelApprovalPolicy): ProjectConfig {
  const config = loadConfig(root);
  config.reviewPolicy ??= defaultReviewPolicy();
  const reviewerCount = config.agents?.reviewers?.length ?? 0;
  assertLevelPolicy(level, policy, reviewerCount);
  config.reviewPolicy.levels[level] = policy;
  assertProjectReviewPolicy(config.reviewPolicy, reviewerCount);
  saveConfig(root, config);
  return config;
}

export function effectiveReviewPolicy(config: ProjectConfig, task: TaskState): ReviewLevelApprovalPolicy {
  const project = config.reviewPolicy ?? defaultReviewPolicy();
  const base = project.levels[task.review.level];
  const override = task.review.policyOverride;
  const approvalsRequired = override?.approvalsRequired ?? base.approvalsRequired;
  const maxReviewers = override?.maxReviewers ?? base.maxReviewers ?? (config.agents?.reviewers?.length ?? 0);
  const resolved = { approvalsRequired, maxReviewers };
  assertLevelPolicy(task.review.level, resolved, config.agents?.reviewers?.length ?? 0);
  return resolved;
}

export function requireDeveloperProfile(config: ProjectConfig): AgentProfile {
  const profile = config.agents?.developer;
  if (!profile) throw new HarnessError("DEVELOPER_PROFILE_MISSING", "No developer profile configured. Run harness profile set developer <provider> <model>.");
  assertAgentProfile(profile);
  return profile;
}

export function requireReviewerProfiles(config: ProjectConfig): ReviewerProfile[] {
  const profiles = config.agents?.reviewers ?? [];
  if (!profiles.length) throw new HarnessError("REVIEWER_PROFILE_MISSING", "No reviewer profiles configured. Run harness profile add reviewer <name> <provider> <model>.");
  profiles.forEach(assertReviewerProfile);
  return profiles;
}

export function removeReviewerProfile(root: string, name: string): ProjectConfig {
  const config = loadConfig(root);
  config.agents ??= {};
  const before = config.agents.reviewers ?? [];
  const next = before.filter((profile) => profile.name !== name);
  if (next.length === before.length) throw new HarnessError("REVIEWER_PROFILE_NOT_FOUND", `Reviewer profile not found: ${name}`);
  config.agents.reviewers = next;
  if (config.reviewPolicy) assertProjectReviewPolicy(config.reviewPolicy, next.length);
  saveConfig(root, config);
  return config;
}

export function reorderReviewerProfiles(root: string, names: string[]): ProjectConfig {
  const config = loadConfig(root);
  const current = config.agents?.reviewers ?? [];
  if (names.length !== current.length || new Set(names).size !== names.length) throw new HarnessError("REVIEWER_ORDER_INVALID", "Reviewer order must list every configured reviewer exactly once.");
  const byName = new Map(current.map((profile) => [profile.name, profile]));
  const ordered = names.map((name) => {
    const profile = byName.get(name);
    if (!profile) throw new HarnessError("REVIEWER_PROFILE_NOT_FOUND", `Reviewer profile not found: ${name}`);
    return profile;
  });
  config.agents ??= {};
  config.agents.reviewers = ordered;
  saveConfig(root, config);
  return config;
}
