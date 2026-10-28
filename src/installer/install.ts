import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectGit } from "../git/git.js";
import { detectProject } from "../project-detector/detect.js";
import { parseYaml, stringifyYaml } from "../util/yaml.js";
import type { ProjectConfig } from "../core/types.js";
import { defaultReviewPolicy } from "../core/config.js";
import { applyMigrationPlan, recordMigrations } from "../migrations/index.js";
import { migratePlanLogicalWorkspaces } from "../plans/migrate-workspace.js";

export const MANAGED_START = "<!-- engineering-harness:start -->";
export const MANAGED_END = "<!-- engineering-harness:end -->";
const managedBlock = `${MANAGED_START}\nEngineering Harness is enabled for this project.\n\nFollow TEAM-WORKFLOW.md for task lifecycle, roles, review levels and review gates.\nHarness-managed project state is stored under .harness/.\n${MANAGED_END}`;

export interface InitResult {
  root: string;
  created: string[];
  updated: string[];
  preserved: string[];
  gitDirtyBefore: boolean;
  gitDirtyAfter: boolean;
}

export function upsertManagedBlock(existing: string): string {
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if (start >= 0 && end >= start) {
    return `${existing.slice(0, start)}${managedBlock}${existing.slice(end + MANAGED_END.length)}`;
  }
  const suffix = existing.length && !existing.endsWith("\n") ? "\n\n" : existing.length ? "\n" : "";
  return `${existing}${suffix}${managedBlock}\n`;
}

function templateRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../templates");
}

export function initProject(rootInput = process.cwd()): InitResult {
  const root = resolve(rootInput);
  const before = inspectGit(root);
  const detection = detectProject(root);
  const harnessDir = join(root, ".harness");
  const created: string[] = [];
  const updated: string[] = [];
  const preserved: string[] = [];
  mkdirSync(join(harnessDir, "state"), { recursive: true });
  mkdirSync(join(harnessDir, "tasks"), { recursive: true });
  mkdirSync(join(harnessDir, "handoff"), { recursive: true });
  mkdirSync(join(harnessDir, "evidence"), { recursive: true });
  mkdirSync(join(harnessDir, "cache"), { recursive: true });
  mkdirSync(join(harnessDir, "plans"), { recursive: true });
  const harnessGitignore = join(harnessDir, ".gitignore");
  if (!existsSync(harnessGitignore)) { writeFileSync(harnessGitignore, "cache/\n"); created.push(".harness/.gitignore"); }
  else preserved.push(".harness/.gitignore");

  const configPath = join(harnessDir, "config.yaml");
  if (!existsSync(configPath)) {
    const config: ProjectConfig = {
      harness: { version: "0.8.3", schemaVersion: 1 },
      project: { root: ".", initializedAt: new Date().toISOString() },
      workflow: { defaultReviewLevel: "FULL" },
      git: { allowAutoCommit: false, allowAutoPush: false, allowAutoMerge: false },
      permissions: { destructiveOperations: "deny", productionAccess: "require_user" },
      evidence: { hashDirtyTree: true, retainLogs: true },
      installation: { managedAgentsBlock: true },
      agents: { reviewers: [] },
      reviewPolicy: defaultReviewPolicy(),
      orchestration: { maxReviewRounds: 3 },
      runtime: { agentTimeoutMs: 900000, terminateGraceMs: 3000 },
      context: { compactionThresholdEstimatedTokens: 60000 },
      events: { retainEntries: 5000 },
      catalog: { cacheTtlMs: 300000 },
      operator: { refreshIntervalMs: 1000, eventLimit: 12 },
      scheduler: { maxParallel: 2 },
      ...(Object.keys(detection.verification).length ? { verification: detection.verification } : {}),
    };
    writeFileSync(configPath, stringifyYaml(config as unknown as Record<string, unknown> as never) + "\n");
    created.push(".harness/config.yaml");
  } else preserved.push(".harness/config.yaml");

  for (const name of ["TEAM-WORKFLOW.md", "TEAM-WORKFLOW-COMMANDS.md"]) {
    const dst = join(root, name);
    if (!existsSync(dst)) { copyFileSync(join(templateRoot(), name), dst); created.push(name); }
    else preserved.push(name);
  }

  const agentsPath = join(root, "AGENTS.md");
  const oldAgents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const newAgents = upsertManagedBlock(oldAgents);
  if (!existsSync(agentsPath)) { writeFileSync(agentsPath, newAgents); created.push("AGENTS.md"); }
  else if (newAgents !== oldAgents) { writeFileSync(agentsPath, newAgents); updated.push("AGENTS.md"); }
  else preserved.push("AGENTS.md");

  const after = inspectGit(root);
  return { root, created, updated, preserved, gitDirtyBefore: before.dirty, gitDirtyAfter: after.dirty };
}

export interface UpgradeResult {
  root: string;
  fromVersion: string;
  toVersion: string;
  updated: string[];
  preserved: string[];
  notes: string[];
}

export function upgradeProject(rootInput = process.cwd(), targetVersion = "0.8.3"): UpgradeResult {
  const root = resolve(rootInput);
  const configPath = join(root, ".harness", "config.yaml");
  if (!existsSync(configPath)) throw new Error("Engineering Harness is not initialized. Run harness init first.");
  const config = parseYaml(readFileSync(configPath, "utf8")) as unknown as ProjectConfig;
  const fromVersion = config.harness?.version ?? "unknown";
  if (fromVersion === "unknown") throw new Error("Project harness version is missing; refusing an ambiguous migration.");
  const updated: string[] = [];
  const preserved: string[] = [];
  const notes: string[] = [];
  if (config.harness.schemaVersion !== 1) throw new Error(`Unsupported schema version: ${config.harness.schemaVersion}`);
  const migrated = applyMigrationPlan(config, fromVersion, targetVersion);
  writeFileSync(configPath, stringifyYaml(migrated.config as unknown as Record<string, unknown> as never) + "\n");
  updated.push(".harness/config.yaml");
  if (migrated.applied.length) {
    recordMigrations(root, fromVersion, migrated.applied);
    updated.push(".harness/state/migrations.json");
    notes.push(`Applied migrations: ${migrated.applied.map((step) => step.id).join(", ")}`);
  }
  if (migrated.applied.some((step) => step.id === "M083-plan-logical-workspace")) {
    const workspaceMigration = migratePlanLogicalWorkspaces(root);
    if (workspaceMigration.moved.length) updated.push(...workspaceMigration.moved);
    if (workspaceMigration.preserved.length) preserved.push(...workspaceMigration.preserved);
    notes.push(...workspaceMigration.notes);
  }

  const agentsPath = join(root, "AGENTS.md");
  const oldAgents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const newAgents = upsertManagedBlock(oldAgents);
  if (!existsSync(agentsPath) || newAgents !== oldAgents) { writeFileSync(agentsPath, newAgents); updated.push("AGENTS.md"); }
  else preserved.push("AGENTS.md");

  for (const name of ["TEAM-WORKFLOW.md", "TEAM-WORKFLOW-COMMANDS.md"]) {
    if (existsSync(join(root, name))) {
      preserved.push(name);
      notes.push(`${name} was preserved because project workflow files may contain local edits; compare with the packaged V${targetVersion} template when desired.`);
    } else {
      copyFileSync(join(templateRoot(), name), join(root, name));
      updated.push(name);
    }
  }
  return { root, fromVersion, toVersion: targetVersion, updated, preserved, notes };
}
