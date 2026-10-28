#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initProject, upgradeProject, MANAGED_START, MANAGED_END } from "../installer/install.js";
import { inspectGit } from "../git/git.js";
import { detectProject } from "../project-detector/detect.js";
import { effectiveReviewPolicy, loadConfig, removeReviewerProfile, reorderReviewerProfiles, setDeveloperProfile, setPlannerProfile, setReviewLevelPolicy, upsertReviewerProfile } from "../core/config.js";
import { activateCheckpoint, addAcceptanceCriterion, addCheckpoint, createTask, setCheckpointScope, setTaskReviewPolicyOverride } from "../core/task.js";
import { archiveActiveTask, beginActiveTask, loadActiveTask, loadTaskHistory, saveActiveTask } from "../core/store.js";
import { transitionTask } from "../core/state-machine.js";
import type { ReviewLevel, TaskStatus } from "../core/types.js";
import { HarnessError } from "../core/errors.js";
import { classifyReviewLevel } from "../core/classify.js";
import { createDefaultAdapters } from "../agents/registry.js";
import { adapterCapability } from "../agents/capabilities.js";
import { dispatchDeveloperAsync } from "../agents/developer-dispatcher.js";
import { dispatchReviewAsync } from "../review/dispatcher.js";
import { orchestrateReviewAsync } from "../review/orchestrator.js";
import type { ReviewTarget } from "../review/artifacts.js";
import { findSession, loadSessionRegistry, registerSession, resolveSessionState, saveSessionRegistry } from "../agents/session-registry.js";
import type { AgentProvider, AgentPurpose } from "../agents/types.js";
import type { ReviewerCandidate } from "../review/router.js";
import { runEvidenceCommand } from "../evidence/runner.js";
import { refreshStaleApprovals } from "../review/staleness.js";
import { runWorkflowAsync } from "../orchestration/run.js";
import { loadRunState } from "../orchestration/run-state.js";
import { findRuntimeProcess, requestRuntimeCancellation, resolveRuntimeProcess } from "../runtime/process-registry.js";
import { reconcileRuntimeAndSessions } from "../runtime/recovery.js";
import { loadRunLease } from "../runtime/run-lease.js";
import { compactSessionContext, contextStatus } from "../prompts/context.js";
import { loadTurnMetrics, summarizeMetrics, summarizeMetricsByReviewer } from "../metrics/store.js";
import { cachedCatalogFor, catalogModelStatus, probeModelCatalog } from "../agents/model-catalog.js";
import { emitHarnessEvent, loadHarnessEvents, type HarnessEvent } from "../events/bus.js";
import { loadMigrationHistory, migrationMatrix, migrationPlan } from "../migrations/index.js";
import { generateReleaseArtifacts, signReleaseArtifacts, verifyReleaseArtifacts } from "../release/provenance.js";
import { detectCosign, keylessSignRelease, keylessVerifyRelease } from "../release/sigstore.js";
import { buildDashboardSnapshot, renderDashboard } from "../operator/dashboard.js";
import { generateCi, type CiProvider } from "../ci/generate.js";
import { addWorkspace, loadWorkspaceRegistry, planWorkspaces, removeWorkspace, setWorkspaceEnabled } from "../scheduler/workspaces.js";
import { runWorkspaceScheduler } from "../scheduler/run.js";
import { importPlan } from "../plans/analyzer.js";
import { approvePlan, runPlan } from "../plans/orchestrator.js";
import { assertPlanSourceFresh, loadActivePlan } from "../plans/store.js";
import { describePlanWorkspace, listPlanWorkspaces } from "../plans/workspace.js";

const VERSION = "0.8.3";
const args = process.argv.slice(2);
const json = args.includes("--json");
const cleanArgs = args.filter((a: string) => a !== "--json");
const rootFlag = cleanArgs.indexOf("--root");
const root = resolve(rootFlag >= 0 ? cleanArgs[rootFlag + 1] : process.cwd());
if (rootFlag >= 0) cleanArgs.splice(rootFlag, 2);

function emit(value: unknown) { console.log(json ? JSON.stringify(value, null, 2) : value); }
function fail(err: unknown): never {
  if (err instanceof HarnessError) console.error(json ? JSON.stringify({ error: err.code, message: err.message }, null, 2) : `${err.code}: ${err.message}`);
  else console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

function parseReviewerCandidates(value: string): ReviewerCandidate[] {
  if (!value) throw new Error("Reviewer candidates are required as [name=]provider:model[,provider:model...].");
  return value.split(",").map((raw) => {
    const eq = raw.indexOf("=");
    const name = eq > 0 ? raw.slice(0, eq) : undefined;
    const item = eq > 0 ? raw.slice(eq + 1) : raw;
    const idx = item.indexOf(":");
    if (idx <= 0 || idx === item.length - 1) throw new Error(`Invalid reviewer candidate: ${raw}`);
    const provider = item.slice(0, idx) as AgentProvider;
    if (provider !== "claude" && provider !== "codex" && provider !== "antigravity") throw new Error(`Unsupported reviewer provider: ${provider}`);
    return { ...(name ? { name } : {}), provider, model: item.slice(idx + 1) };
  });
}

function parseProvider(value: string): AgentProvider {
  if (value !== "claude" && value !== "codex" && value !== "antigravity") throw new Error(`Unsupported provider: ${value}`);
  return value;
}

function parsePurpose(value: string): AgentPurpose {
  if (value !== "developer" && value !== "reviewer" && value !== "planner") throw new Error(`Unsupported purpose: ${value}`);
  return value;
}

function parseCiProvider(value: string): CiProvider {
  if (value !== "github" && value !== "gitlab") throw new Error(`Unsupported CI provider: ${value}`);
  return value;
}

function parseReviewTarget(value: string): ReviewTarget {
  if (value === "final") return { kind: "final" };
  if (value.startsWith("checkpoint:")) {
    const checkpointId = value.slice("checkpoint:".length);
    if (!checkpointId) throw new Error("Checkpoint ID is required.");
    return { kind: "checkpoint", checkpointId };
  }
  throw new Error("Review target must be final or checkpoint:<id>.");
}

function parseRunOptions(values: string[]): { maxReviewRounds?: number; verificationKeys?: string[]; agentTimeoutMs?: number; terminateGraceMs?: number; progress?: boolean } {
  const options: { maxReviewRounds?: number; verificationKeys?: string[]; agentTimeoutMs?: number; terminateGraceMs?: number; progress?: boolean } = {};
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === "--max-rounds") {
      const raw = values[++i]; if (!raw) throw new Error("--max-rounds requires a number."); options.maxReviewRounds = Number(raw);
    } else if (values[i] === "--verify") {
      const raw = values[++i]; if (!raw) throw new Error("--verify requires comma-separated verification keys."); options.verificationKeys = raw.split(",").filter(Boolean);
    } else if (values[i] === "--timeout-ms") {
      const raw = values[++i]; if (!raw) throw new Error("--timeout-ms requires a number."); options.agentTimeoutMs = Number(raw);
    } else if (values[i] === "--terminate-grace-ms") {
      const raw = values[++i]; if (!raw) throw new Error("--terminate-grace-ms requires a number."); options.terminateGraceMs = Number(raw);
    } else if (values[i] === "--progress") {
      options.progress = true;
    } else throw new Error(`Unknown harness run option: ${values[i]}`);
  }
  return options;
}

function doctor() {
  const checks: { name: string; status: "ok"|"warn"|"fail"; detail?: string }[] = [];
  const git = inspectGit(root);
  checks.push({ name: "project root", status: "ok", detail: root });
  checks.push({ name: "Git repository", status: git.isRepository ? "ok" : "warn", detail: git.isRepository ? (git.head ?? "unborn HEAD") : "not detected" });
  checks.push({ name: "working tree", status: git.dirty ? "warn" : "ok", detail: git.dirty ? `${git.changedFiles.length} changed files` : "clean" });
  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig(root);
    checks.push({ name: "config schema", status: "ok" });
    checks.push({ name: "harness version", status: config.harness.version === VERSION ? "ok" : "warn", detail: config.harness.version === VERSION ? VERSION : `project=${config.harness.version}, cli=${VERSION}; run harness upgrade` });
    checks.push({ name: "developer profile", status: config.agents?.developer ? "ok" : "warn", detail: config.agents?.developer ? `${config.agents.developer.provider}/${config.agents.developer.model}` : "not configured" });
    const effectivePlanner = config.agents?.planner ?? config.agents?.reviewers?.[0];
    checks.push({ name: "planner profile", status: effectivePlanner ? "ok" : "warn", detail: config.agents?.planner ? `${config.agents.planner.provider}/${config.agents.planner.model} (configured)` : effectivePlanner ? `${effectivePlanner.provider}/${effectivePlanner.model} (primary reviewer fallback)` : "not configured and no reviewer fallback" });
    const reviewerCount = config.agents?.reviewers?.length ?? 0;
    checks.push({ name: "reviewer profiles", status: reviewerCount ? "ok" : "warn", detail: reviewerCount ? config.agents!.reviewers!.map((p) => `${p.name}=${p.provider}/${p.model}`).join(", ") : "not configured" });
    if (config.reviewPolicy) {
      for (const level of ["LIGHT", "FULL"] as const) {
        const policy = config.reviewPolicy.levels[level];
        const capacity = Math.min(policy.maxReviewers ?? reviewerCount, reviewerCount);
        checks.push({
          name: `${level} approval policy`,
          status: policy.approvalsRequired <= capacity ? "ok" : "warn",
          detail: `required=${policy.approvalsRequired}, maxReviewers=${policy.maxReviewers ?? reviewerCount}, configuredReviewers=${reviewerCount}`,
        });
      }
    }
    checks.push({ name: "verification", status: Object.keys(config.verification ?? {}).length ? "ok" : "warn", detail: Object.keys(config.verification ?? {}).join(", ") || "no commands detected/configured" });
    checks.push({ name: "runtime timeout", status: config.runtime?.agentTimeoutMs ? "ok" : "warn", detail: config.runtime?.agentTimeoutMs ? `${config.runtime.agentTimeoutMs}ms` : "not configured; upgrade recommended" });
    const activePlan = loadActivePlan(root);
    if (activePlan) {
      try { assertPlanSourceFresh(root, activePlan); checks.push({ name: "active plan", status: "ok", detail: `${activePlan.id}/${activePlan.status}; tasks=${activePlan.tasks.filter((item) => item.status === "COMPLETED").length}/${activePlan.tasks.length}` }); }
      catch (err) { checks.push({ name: "active plan", status: "fail", detail: err instanceof Error ? err.message : String(err) }); }
    }
  } catch (e) { checks.push({ name: "config schema", status: "fail", detail: e instanceof Error ? e.message : String(e) }); }

  const agentsPath = resolve(root, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const text = readFileSync(agentsPath, "utf8");
    checks.push({ name: "AGENTS managed block", status: text.includes(MANAGED_START) && text.includes(MANAGED_END) ? "ok" : "warn" });
  } else checks.push({ name: "AGENTS.md", status: "fail", detail: "missing" });
  for (const file of ["TEAM-WORKFLOW.md", "TEAM-WORKFLOW-COMMANDS.md"]) checks.push({ name: file, status: existsSync(resolve(root,file)) ? "ok" : "fail" });

  const task = loadActiveTask(root);
  if (task?.review.level === "FULL") {
    const unscoped = task.checkpoints.filter((checkpoint) => !checkpoint.scope).map((checkpoint) => checkpoint.id);
    checks.push({ name: "FULL checkpoint ownership", status: unscoped.length ? "warn" : "ok", detail: unscoped.length ? `missing scope: ${unscoped.join(", ")}` : `${task.checkpoints.length} checkpoint(s) scoped` });
  }
  if (task && config) {
    try {
      const policy = effectiveReviewPolicy(config, task);
      const reviewerCount = config.agents?.reviewers?.length ?? 0;
      const capacity = Math.min(policy.maxReviewers ?? reviewerCount, reviewerCount);
      checks.push({ name: "active task approval capacity", status: policy.approvalsRequired <= capacity ? "ok" : "warn", detail: `level=${task.review.level}, required=${policy.approvalsRequired}, capacity=${capacity}${task.review.policyOverride ? `, override=${task.review.policyOverride.selectedBy}` : ""}` });
    } catch (error) {
      checks.push({ name: "active task approval capacity", status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const detection = detectProject(root);
  checks.push({ name: "project detection", status: "ok", detail: `${detection.ecosystems.join(", ") || "generic"}${detection.packageManager ? ` / ${detection.packageManager}` : ""}` });
  const adapters = createDefaultAdapters();
  const capabilities = Object.values(adapters).map(adapterCapability);
  for (const capability of capabilities) checks.push({ name: `${capability.provider} CLI`, status: capability.available ? "ok" : "warn", detail: `${capability.version ?? "not available"}; roles=${capability.purposes?.join(",") ?? "unknown"}; model-check=${capability.modelValidation}; catalog=${capability.catalogProbe}` });

  if (config?.agents?.developer) {
    const capability = capabilities.find((item) => item.provider === config!.agents!.developer!.provider);
    if (capability && !capability.purposes?.includes("developer")) checks.push({ name: "developer adapter capability", status: "fail", detail: `${capability.provider} adapter does not support developer role` });
  }
  for (const profile of config?.agents?.reviewers ?? []) {
    const capability = capabilities.find((item) => item.provider === profile.provider);
    if (capability && !capability.purposes?.includes("reviewer")) checks.push({ name: `reviewer ${profile.name} capability`, status: "fail", detail: `${capability.provider} adapter does not support reviewer role` });
  }
  if (config?.agents?.developer) {
    const catalog = cachedCatalogFor(root, config.agents.developer.provider);
    const status = catalogModelStatus(catalog, config.agents.developer.model);
    checks.push({ name: "developer model catalog", status: status === "invalid" ? "warn" : "ok", detail: status === "unknown" ? "not probed / provider runtime validation" : `${status}: ${config.agents.developer.provider}/${config.agents.developer.model}` });
  }
  for (const profile of config?.agents?.reviewers ?? []) {
    const catalog = cachedCatalogFor(root, profile.provider);
    const status = catalogModelStatus(catalog, profile.model);
    checks.push({ name: `reviewer ${profile.name} model catalog`, status: status === "invalid" ? "warn" : "ok", detail: status === "unknown" ? "not probed / provider runtime validation" : `${status}: ${profile.provider}/${profile.model}` });
  }

  const recovery = reconcileRuntimeAndSessions(root);
  const running = recovery.processes.filter((item) => item.status === "running");
  const uncertain = recovery.processes.filter((item) => item.status === "uncertain");
  checks.push({ name: "runtime processes", status: uncertain.length ? "fail" : running.length ? "warn" : "ok", detail: uncertain.length ? `${uncertain.length} uncertain; explicit recovery required` : running.length ? `${running.length} still running` : "no unresolved processes" });
  checks.push({ name: "session recovery", status: recovery.uncertainSessions.length ? "fail" : "ok", detail: recovery.uncertainSessions.length ? recovery.uncertainSessions.join(", ") : "no uncertain sessions" });
  const lease = loadRunLease(root);
  checks.push({ name: "run lease", status: lease ? "warn" : "ok", detail: lease ? `task=${lease.taskId}, pid=${lease.pid}` : "free" });
  const compact = contextStatus(root, config?.context?.compactionThresholdEstimatedTokens ?? 60000).filter((item) => item.compactionRecommended);
  checks.push({ name: "session context budget", status: compact.length ? "warn" : "ok", detail: compact.length ? `${compact.length} session(s) should be compacted` : "within configured estimate" });
  checks.push({ name: "operator dashboard", status: config?.operator?.refreshIntervalMs ? "ok" : "warn", detail: config?.operator?.refreshIntervalMs ? `refresh=${config.operator.refreshIntervalMs}ms` : "not configured; upgrade recommended" });
  checks.push({ name: "scheduler", status: config?.scheduler?.maxParallel ? "ok" : "warn", detail: config?.scheduler?.maxParallel ? `maxParallel=${config.scheduler.maxParallel}` : "not configured; upgrade recommended" });
  const workspaces = loadWorkspaceRegistry(root).workspaces;
  if (workspaces.length) checks.push({ name: "registered workspaces", status: "ok", detail: `${workspaces.length}` });
  const cosign = detectCosign();
  checks.push({ name: "cosign (optional)", status: cosign.available ? "ok" : "warn", detail: cosign.available ? cosign.detail : "not installed; keyless signing unavailable" });

  const overall = checks.some(c => c.status === "fail") ? "NOT_READY" : "READY";
  if (json) emit({ overall, checks, detection, agents: capabilities, runtime: recovery });
  else {
    console.log("Engineering Harness Doctor\n");
    for (const c of checks) console.log(`${c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    console.log(`\nStatus: ${overall}`);
  }
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = cleanArgs;
  if (cmd === "init") {
    const result = initProject(root); if (json) emit(result); else {
      console.log(`Engineering Harness initialized: ${result.root}`);
      if (result.created.length) console.log(`Created: ${result.created.join(", ")}`);
      if (result.updated.length) console.log(`Updated: ${result.updated.join(", ")}`);
      if (result.preserved.length) console.log(`Preserved: ${result.preserved.join(", ")}`);
    }
  } else if (cmd === "upgrade") {
    const result = upgradeProject(root, VERSION); if (json) emit(result); else {
      console.log(`Engineering Harness upgraded: ${result.fromVersion} -> ${result.toVersion}`);
      if (result.updated.length) console.log(`Updated: ${result.updated.join(", ")}`);
      if (result.preserved.length) console.log(`Preserved: ${result.preserved.join(", ")}`);
      for (const note of result.notes) console.log(`Note: ${note}`);
    }
  } else if (cmd === "doctor") doctor();
  else if (cmd === "status") {
    const git = inspectGit(root); let task = loadActiveTask(root); const plan = loadActivePlan(root); const detection = detectProject(root); const sessions = loadSessionRegistry(root); const runState = loadRunState(root); const runtime = reconcileRuntimeAndSessions(root);
    let invalidated: string[] = [];
    if (task) { const refreshed = refreshStaleApprovals(root, task); task = refreshed.task; invalidated = refreshed.invalidated; if (invalidated.length) saveActiveTask(root, task); }
    const lease = loadRunLease(root); const contexts = contextStatus(root, loadConfig(root).context?.compactionThresholdEstimatedTokens ?? 60000);
    if (json) emit({ root, git, task, plan, detection, sessions, runState, runtime, lease, contexts, invalidatedApprovals: invalidated });
    else console.log(`Root: ${root}\nGit: ${git.isRepository ? `${git.dirty ? "dirty" : "clean"} ${git.head ?? "unborn"}` : "not a repository"}\nTask: ${task ? `${task.id} / ${task.status} / ${task.review.level}` : "none"}\nPlan: ${plan ? `${plan.id} / ${plan.status} / tasks=${plan.tasks.filter((item) => item.status === "COMPLETED").length}/${plan.tasks.length}` : "none"}${invalidated.length ? `\nInvalidated approvals: ${invalidated.join(", ")}` : ""}${runState ? `\nRun: ${runState.status} / ${runState.phase}${runState.target ? ` / ${runState.target}` : ""}` : ""}\nRun lease: ${lease ? `held by pid=${lease.pid} task=${lease.taskId}` : "free"}\nRuntime unresolved: ${runtime.processes.filter((item) => item.status === "running" || item.status === "uncertain").length}\nContext compaction recommended: ${contexts.filter((item) => item.compactionRecommended).length}`);
  } else if (cmd === "config" && sub === "show") emit(json ? loadConfig(root) : JSON.stringify(loadConfig(root), null, 2));
  else if (cmd === "profile" && sub === "show") { const profiles = loadConfig(root).agents ?? {}; emit(json ? profiles : JSON.stringify(profiles, null, 2)); }
  else if (cmd === "profile" && sub === "set") {
    const [purpose, providerRaw, model] = rest; if ((purpose !== "developer" && purpose !== "planner") || !providerRaw || !model) throw new Error("Usage: harness profile set <developer|planner> <claude|codex|antigravity> <model>");
    const provider = parseProvider(providerRaw);
    const cfg = purpose === "developer" ? setDeveloperProfile(root, { provider, model }) : setPlannerProfile(root, { provider, model });
    emit(json ? cfg.agents : `${purpose === "developer" ? "Developer" : "Planner"} profile: ${providerRaw}/${model}`);
  } else if (cmd === "profile" && sub === "add") {
    const [purpose, name, providerRaw, model] = rest; if (purpose !== "reviewer" || !name || !providerRaw || !model) throw new Error("Usage: harness profile add reviewer <name> <claude|codex|antigravity> <model>");
    const cfg = upsertReviewerProfile(root, { name, provider: parseProvider(providerRaw), model }); emit(json ? cfg.agents : `Reviewer profile ${name}: ${providerRaw}/${model}`);
  } else if (cmd === "profile" && sub === "remove") {
    const [purpose, name] = rest; if (purpose !== "reviewer" || !name) throw new Error("Usage: harness profile remove reviewer <name>");
    const cfg = removeReviewerProfile(root, name); emit(json ? cfg.agents : `Removed reviewer profile ${name}.`);
  } else if (cmd === "profile" && sub === "order") {
    const [purpose, ...namesRaw] = rest; if (purpose !== "reviewers" || !namesRaw.length) throw new Error("Usage: harness profile order reviewers <name1,name2,...>");
    const names = namesRaw.flatMap((value) => value.split(",")).filter(Boolean); const cfg = reorderReviewerProfiles(root, names); emit(json ? cfg.agents : `Reviewer order: ${names.join(" -> ")}`);
  } else if (cmd === "review" && sub === "policy") {
    const action = rest[0]; const cfg = loadConfig(root);
    if (!action || action === "show") {
      const task = loadActiveTask(root); const effective = task ? effectiveReviewPolicy(cfg, task) : undefined; emit(json ? { project: cfg.reviewPolicy, taskOverride: task?.review.policyOverride, effective } : JSON.stringify({ project: cfg.reviewPolicy, taskOverride: task?.review.policyOverride, effective }, null, 2));
    } else if (action === "set") {
      const level = rest[1] as ReviewLevel; const approvals = Number(rest[2]); const maxRaw = rest[3];
      if (!["NONE","LIGHT","FULL"].includes(level) || !Number.isInteger(approvals) || approvals < 0) throw new Error("Usage: harness review policy set <NONE|LIGHT|FULL> <approvals-required> [max-reviewers]");
      const maxReviewers = maxRaw !== undefined ? Number(maxRaw) : undefined; if (maxReviewers !== undefined && (!Number.isInteger(maxReviewers) || maxReviewers < 0)) throw new Error("max-reviewers must be a non-negative integer.");
      const next = setReviewLevelPolicy(root, level, { approvalsRequired: approvals, ...(maxReviewers !== undefined ? { maxReviewers } : {}) }); emit(json ? next.reviewPolicy : `${level}: approvalsRequired=${approvals}${maxReviewers !== undefined ? ` maxReviewers=${maxReviewers}` : ""}`);
    } else throw new Error("Usage: harness review policy <show|set> ...");
  } else if (cmd === "review" && sub === "classify") {
    const description = rest.join(" "); if (!description) throw new Error("Usage: harness review classify <description>"); const result = classifyReviewLevel(description); emit(json ? result : `${result.level}: ${result.reasons.join(", ")}`);
  } else if (cmd === "review" && sub === "dispatch") {
    const candidates = parseReviewerCandidates(rest[0] ?? ""); const prompt = rest.slice(1).join(" "); if (!prompt) throw new Error("Usage: harness review dispatch <provider:model[,provider:model...]> <prompt>");
    const cfg = loadConfig(root); const result = await dispatchReviewAsync(root, prompt, candidates, createDefaultAdapters(), `review-${Date.now()}`, { timeoutMs: cfg.runtime?.agentTimeoutMs, terminateGraceMs: cfg.runtime?.terminateGraceMs });
    emit(json ? result : `${result.result.success ? "SUCCESS" : "FAILED"} reviewer=${result.reviewer.provider}/${result.reviewer.model} session=${result.result.sessionId ?? "unknown"}\n${result.result.response}`);
  } else if (cmd === "review" && sub === "run") {
    const target = parseReviewTarget(rest[0] ?? ""); const cfg = loadConfig(root);
    const selector = rest[1] ?? "configured";
    const candidates: ReviewerCandidate[] = selector === "configured"
      ? (cfg.agents?.reviewers ?? []).map((profile) => ({ name: profile.name, provider: profile.provider, model: profile.model }))
      : parseReviewerCandidates(selector);
    if (!candidates.length) throw new Error("No configured reviewer profiles. Add reviewer profiles or provide the configured project reviewer list.");
    const request = rest.slice(2).join(" ");
    const result = await orchestrateReviewAsync(root, target, candidates, createDefaultAdapters(), request, `review-${Date.now()}`, { timeoutMs: cfg.runtime?.agentTimeoutMs, terminateGraceMs: cfg.runtime?.terminateGraceMs });
    const progress = result.approvalProgress; emit(json ? result : `${result.review.result.verdict} target=${target.kind === "final" ? "final" : target.checkpointId} reviewer=${result.review.reviewer.name ?? `${result.review.reviewer.provider}/${result.review.reviewer.model}`} round=${result.review.round}${progress ? ` approvals=${progress.approvals.length}/${progress.approvalsRequired} reviewed=${progress.completedReviews}/${progress.maxReviewers}` : ""} next=${result.nextAction} status=${result.taskStatus}\n${result.review.result.summary}`);
  } else if (cmd === "plan" && sub === "import") {
    const path = rest[0]; if (!path) throw new Error("Usage: harness plan import <plan-file> [--id PLAN_ID]");
    const idIndex = rest.indexOf("--id"); const planId = idIndex >= 0 ? rest[idIndex + 1] : undefined;
    const cfg = loadConfig(root); const manifest = await importPlan(root, path, { ...(planId ? { id: planId } : {}), timeoutMs: cfg.runtime?.agentTimeoutMs, terminateGraceMs: cfg.runtime?.terminateGraceMs });
    emit(json ? manifest : `Imported plan ${manifest.id} in DRAFT: tasks=${manifest.tasks.length} planner=${manifest.planner.provider}/${manifest.planner.model}\nRun 'harness plan show' to inspect, then 'harness plan approve'.`);
  } else if (cmd === "plan" && (sub === "show" || sub === "status")) {
    const manifest = loadActivePlan(root); if (!manifest) throw new Error("No active plan. Run harness plan import <file>.");
    let fresh = true; let freshnessError = ""; try { assertPlanSourceFresh(root, manifest); } catch (err) { fresh = false; freshnessError = err instanceof Error ? err.message : String(err); }
    emit(json ? { ...manifest, sourceFresh: fresh, ...(freshnessError ? { freshnessError } : {}) } : `${manifest.id} / ${manifest.status} / source=${manifest.source.path} / fresh=${fresh}\n${manifest.tasks.map((task) => `${task.executionOrder + 1}. ${task.id} [${task.status}] ${task.reviewLevel} deps=${task.dependsOn.join(",") || "none"} — ${task.title}`).join("\n")}${freshnessError ? `\n${freshnessError}` : ""}`);
  } else if (cmd === "plan" && sub === "list") {
    const plans = listPlanWorkspaces(root); emit(json ? plans : plans.length ? plans.map((item) => `${item.planId} [${item.status ?? "UNKNOWN"}] tasks=${item.tasks.length} ${item.path}`).join("\n") : "No plan workspaces.");
  } else if (cmd === "plan" && sub === "workspace") {
    const planId = rest[0] ?? loadActivePlan(root)?.id; if (!planId) throw new Error("Usage: harness plan workspace [plan-id]"); const workspace = describePlanWorkspace(root, planId); emit(json ? workspace : `${workspace.planId} [${workspace.status ?? "UNKNOWN"}] ${workspace.path}\nmanifest: ${workspace.manifestPath}\nsource: ${workspace.sourcePath}\nexecution: ${workspace.executionPath}\narchive: ${workspace.archivePath}\n${workspace.tasks.length ? workspace.tasks.map((task) => `- ${task.taskId}: ${task.path} state=${task.hasState} reviews=${task.hasReviews} evidence=${task.hasEvidence} sessions=${task.hasSessions} metrics=${task.hasMetrics}`).join("\n") : "- no materialized tasks"}`);
  } else if (cmd === "plan" && sub === "approve") {
    const manifest = approvePlan(root, "user"); emit(json ? manifest : `Approved plan ${manifest.id}. ${manifest.tasks.length} task(s) are authorized for plan execution.`);
  } else if (cmd === "plan" && sub === "run") {
    const parsed = parseRunOptions(rest); const { progress, ...options } = parsed; const eventSink = progress ? (event: HarnessEvent) => console.error(`[${event.type}] ${Object.entries(event.data).map(([k,v]) => `${k}=${v}`).join(" ")}`) : undefined;
    const result = await runPlan(root, { ...options, ...(eventSink ? { eventSink } : {}) }); emit(json ? result : `Plan ${result.manifest.id} ${result.manifest.status}: taskRuns=${result.taskRuns.length}, completed=${result.manifest.tasks.filter((task) => task.status === "COMPLETED").length}/${result.manifest.tasks.length}`);
  } else if (cmd === "task" && sub === "create") {
    const id = rest[0]; const title = rest[1] ?? id; const level = (rest[2] ?? "FULL") as ReviewLevel; const reason = rest.slice(3).join(" ") || "Selected at task creation"; if (!id) throw new Error("Usage: harness task create <id> [title] [NONE|LIGHT|FULL] [reason]");
    const created = beginActiveTask(root, createTask(id, title, level, reason)); const task = created.task; const archived = created.archived; emit(json ? created : `${archived ? `Archived completed task ${archived.taskId}. ` : ""}Created task ${id} (${level}) in DRAFT.`);
  } else if (cmd === "task" && sub === "archive") {
    const entry = archiveActiveTask(root); emit(json ? entry : `Archived task ${entry.taskId}: ${entry.path}`);
  } else if (cmd === "task" && sub === "history") {
    const history = loadTaskHistory(root); emit(json ? history : history.tasks.length ? history.tasks.map((item) => `${item.archivedAt} ${item.taskId} ${item.status} ${item.path}`).join("\n") : "No archived tasks.");
  } else if (cmd === "task" && sub === "checkpoint") {
    const action = rest[0]; const id = rest[1]; const task = loadActiveTask(root); if (!task) throw new Error("No active task.");
    if (action === "add" && id) { const next = addCheckpoint(task, id); saveActiveTask(root, next); emit(json ? next : `Added checkpoint ${id}.`); }
    else if (action === "activate" && id) { const next = activateCheckpoint(task, id); saveActiveTask(root, next); emit(json ? next : `Active checkpoint: ${id}.`); }
    else if (action === "scope" && id) {
      const marker = rest.indexOf("--exclude"); const includes = (marker >= 0 ? rest.slice(2, marker) : rest.slice(2)).flatMap((item) => item.split(",")).filter(Boolean); const excludes = marker >= 0 ? rest.slice(marker + 1).flatMap((item) => item.split(",")).filter(Boolean) : [];
      if (!includes.length) throw new Error("Usage: harness task checkpoint scope <id> <include...> [--exclude <pattern...>]"); const next = setCheckpointScope(task, id, { include: includes, ...(excludes.length ? { exclude: excludes } : {}) }); saveActiveTask(root, next); emit(json ? next : `Checkpoint ${id} scope: ${includes.join(", ")}${excludes.length ? `; exclude=${excludes.join(", ")}` : ""}`);
    } else throw new Error("Usage: harness task checkpoint <add|activate|scope> <id> ...");
  } else if (cmd === "task" && sub === "acceptance") {
    const action = rest[0]; const id = rest[1]; const description = rest.slice(2).join(" "); if (action !== "add" || !id || !description) throw new Error("Usage: harness task acceptance add <id> <description>"); const task = loadActiveTask(root); if (!task) throw new Error("No active task."); const next = addAcceptanceCriterion(task, id, description); saveActiveTask(root, next); emit(json ? next : `Added acceptance criterion ${id}.`);
  } else if (cmd === "task" && sub === "review-policy") {
    const action = rest[0]; const task = loadActiveTask(root); if (!task) throw new Error("No active task.");
    if (action === "set") {
      const approvals = Number(rest[1]); const maxRaw = rest[2]; if (!Number.isInteger(approvals) || approvals < 0) throw new Error("Usage: harness task review-policy set <approvals-required> [max-reviewers]"); const maxReviewers = maxRaw !== undefined ? Number(maxRaw) : undefined; if (maxReviewers !== undefined && (!Number.isInteger(maxReviewers) || maxReviewers < 0)) throw new Error("max-reviewers must be a non-negative integer.");
      const next = setTaskReviewPolicyOverride(task, { approvalsRequired: approvals, ...(maxReviewers !== undefined ? { maxReviewers } : {}) }, "user"); effectiveReviewPolicy(loadConfig(root), next); saveActiveTask(root, next); emit(json ? next.review.policyOverride : `Task review override: approvalsRequired=${approvals}${maxReviewers !== undefined ? ` maxReviewers=${maxReviewers}` : ""}`);
    } else if (action === "clear") {
      const next = setTaskReviewPolicyOverride(task, undefined, "user"); saveActiveTask(root, next); emit(json ? next.review : "Task review policy override cleared.");
    } else throw new Error("Usage: harness task review-policy <set|clear> ...");
  } else if (cmd === "task" && sub === "show") {
    let task = loadActiveTask(root); if (!task) throw new Error("No active task."); const refreshed = refreshStaleApprovals(root, task); task = refreshed.task; if (refreshed.invalidated.length) saveActiveTask(root, task); emit(json ? { ...task, invalidatedApprovals: refreshed.invalidated } : JSON.stringify(task, null, 2));
  } else if (cmd === "task" && sub === "transition") {
    const to = rest[0] as TaskStatus; if (!to) throw new Error("Usage: harness task transition <STATUS>"); const task = loadActiveTask(root); if (!task) throw new Error("No active task."); const next = transitionTask(task, to); saveActiveTask(root, next); emit(json ? next : `${task.status} -> ${to}`);
  } else if (cmd === "agent" && sub === "doctor") {
    const capabilities = Object.values(createDefaultAdapters()).map(adapterCapability); const catalogs = capabilities.map((cap) => cachedCatalogFor(root, cap.provider)).filter(Boolean); emit(json ? { capabilities, catalogs } : capabilities.map((c) => `${c.available ? "✓" : "!"} ${c.provider}: ${c.version ?? "not available"}; roles=${c.purposes?.join(",") ?? "unknown"}; model-check=${c.modelValidation}; catalog=${c.catalogProbe}`).join("\n"));
  } else if (cmd === "agent" && sub === "models") {
    const provider = parseProvider(rest[0] ?? "antigravity"); const force = rest.includes("--refresh"); const cfg = loadConfig(root); const adapter = createDefaultAdapters()[provider]; const result = probeModelCatalog(root, adapter, force, cfg.catalog?.cacheTtlMs ?? 300000); emitHarnessEvent(root, "catalog.probed", { provider, status: result.status, models: result.models.length }, { retainEntries: cfg.events?.retainEntries ?? 5000 }); emit(json ? result : `${provider}: ${result.status}${result.detail ? ` — ${result.detail}` : ""}${result.models.length ? `\n${result.models.join("\n")}` : ""}`);
  } else if (cmd === "agent" && sub === "develop") {
    const provider = parseProvider(rest[0] ?? "antigravity"); const model = rest[1]; const prompt = rest.slice(2).join(" "); if (!model || !prompt) throw new Error("Usage: harness agent develop <provider> <model> <prompt>"); const cfg = loadConfig(root); const adapter = createDefaultAdapters()[provider];
    const result = await dispatchDeveloperAsync(root, prompt, provider, model, adapter, `dev-${Date.now()}`, { enforceCheckpointScope: true, timeoutMs: cfg.runtime?.agentTimeoutMs, terminateGraceMs: cfg.runtime?.terminateGraceMs }); emit(json ? result : `${result.success ? "SUCCESS" : "FAILED"} ${provider}/${model} session=${result.sessionId ?? "unknown"}\n${result.response}`);
  } else if (cmd === "session" && sub === "show") emit(json ? loadSessionRegistry(root) : JSON.stringify(loadSessionRegistry(root), null, 2));
  else if (cmd === "session" && sub === "register") {
    const task = loadActiveTask(root); if (!task) throw new Error("No active task."); const [purposeRaw, providerRaw, model, sessionId, ...sessionRest] = rest; if (!purposeRaw || !providerRaw || !model || !sessionId) throw new Error("Usage: harness session register <developer|reviewer|planner> <claude|codex|antigravity> <model> <session-id> [--profile NAME]"); const purpose = parsePurpose(purposeRaw); const provider = parseProvider(providerRaw); const profileIndex = sessionRest.indexOf("--profile"); const profileName = profileIndex >= 0 ? sessionRest[profileIndex + 1] : undefined; const registry = loadSessionRegistry(root); const record = registerSession(registry, task.id, { purpose, provider, model, ...(profileName ? { profileName } : {}), sessionId, workspace: root }); saveSessionRegistry(root, registry); emit(json ? record : `Registered ${purpose} session ${provider}/${model}${profileName ? `/profile:${profileName}` : ""}: ${sessionId}`);
  } else if (cmd === "session" && sub === "resolve") {
    const task = loadActiveTask(root); if (!task) throw new Error("No active task."); const [purposeRaw, providerRaw, model, resolution, ...sessionRest] = rest; if (!purposeRaw || !providerRaw || !model || (resolution !== "idle" && resolution !== "failed")) throw new Error("Usage: harness session resolve <developer|reviewer|planner> <provider> <model> <idle|failed> [--profile NAME]"); const purpose = parsePurpose(purposeRaw); const provider = parseProvider(providerRaw); const profileIndex = sessionRest.indexOf("--profile"); const profileName = profileIndex >= 0 ? sessionRest[profileIndex + 1] : undefined; const registry = loadSessionRegistry(root); const session = findSession(registry, task.id, provider, model, purpose, profileName); if (!session) throw new Error("Session not found."); const requestId = session.inFlight?.requestId; resolveSessionState(session, resolution); saveSessionRegistry(root, registry); if (requestId) { const runtime = findRuntimeProcess(root, requestId); if (runtime?.status === "uncertain") resolveRuntimeProcess(root, requestId, resolution === "idle" ? "completed" : "failed"); } emit(json ? session : `Resolved ${purpose} session ${provider}/${model}${profileName ? `/profile:${profileName}` : ""} -> ${resolution}.`);
  } else if (cmd === "runtime" && sub === "status") {
    const result = reconcileRuntimeAndSessions(root); emit(json ? result : result.processes.length ? result.processes.map((item) => `${item.status} ${item.requestId} pid=${item.pid} ${item.provider ?? "process"}/${item.purpose ?? ""}`).join("\n") : "No runtime processes recorded.");
  } else if (cmd === "runtime" && sub === "reconcile") {
    const result = reconcileRuntimeAndSessions(root); emit(json ? result : `Runtime reconciled. uncertainSessions=${result.uncertainSessions.length}, unresolvedProcesses=${result.processes.filter((item) => item.status === "running" || item.status === "uncertain").length}`);
  } else if (cmd === "runtime" && sub === "cancel") {
    const requestId = rest[0]; if (!requestId) throw new Error("Usage: harness runtime cancel <request-id>"); const record = requestRuntimeCancellation(root, requestId); emit(json ? record : `Cancellation requested for ${requestId} pid=${record.pid}.`);
  } else if (cmd === "runtime" && sub === "resolve") {
    const requestId = rest[0]; const resolution = rest[1]; if (!requestId || (resolution !== "completed" && resolution !== "failed")) throw new Error("Usage: harness runtime resolve <request-id> <completed|failed>"); const record = resolveRuntimeProcess(root, requestId, resolution); emit(json ? record : `Resolved runtime ${requestId} -> ${resolution}.`);
  } else if (cmd === "context" && sub === "status") {
    const cfg = loadConfig(root); const result = contextStatus(root, cfg.context?.compactionThresholdEstimatedTokens ?? 60000); emit(json ? result : result.length ? result.map((item) => `${item.compactionRecommended ? "!" : "✓"} ${item.purpose} ${item.provider}/${item.model}${item.profileName ? `/profile:${item.profileName}` : ""} session=${item.sessionId} turns=${item.turns} estimatedPromptTokens=${item.estimatedPromptTokens}${item.cachedInputTokens !== null ? ` cachedInputTokens=${item.cachedInputTokens}` : ""}${item.rotationPending ? ` rotationPending=${item.summaryPath}` : ""}`).join("\n") : "No active task sessions.");
  } else if (cmd === "context" && sub === "compact") {
    const [purposeRaw, providerRaw, model, ...compactRest] = rest; if (!purposeRaw || !providerRaw || !model) throw new Error("Usage: harness context compact <developer|reviewer|planner> <provider> <model> [--profile NAME]"); const purpose = parsePurpose(purposeRaw); const provider = parseProvider(providerRaw); const profileIndex = compactRest.indexOf("--profile"); const profileName = profileIndex >= 0 ? compactRest[profileIndex + 1] : undefined; const result = compactSessionContext(root, purpose, provider, model, profileName); const cfg = loadConfig(root); emitHarnessEvent(root, "context.compacted", { purpose, provider, model, ...(profileName ? { profileName } : {}), previousSessionId: result.previousSessionId, summaryPath: result.summaryPath }, { taskId: loadActiveTask(root)?.id, retainEntries: cfg.events?.retainEntries ?? 5000 }); emit(json ? result : `Context compacted. Previous session=${result.previousSessionId}; next turn will start a fresh session using ${result.summaryPath}.`);
  } else if (cmd === "ui") {
    const uiArgs = [sub, ...rest].filter((value): value is string => Boolean(value)); const cfg = loadConfig(root); const once = uiArgs.includes("--once") || json; const intervalIndex = uiArgs.indexOf("--interval-ms"); const interval = intervalIndex >= 0 ? Number(uiArgs[intervalIndex + 1] ?? cfg.operator?.refreshIntervalMs ?? 1000) : (cfg.operator?.refreshIntervalMs ?? 1000); const eventLimit = cfg.operator?.eventLimit ?? 12;
    if (!Number.isInteger(interval) || interval < 100) throw new Error("--interval-ms must be an integer >= 100.");
    const draw = () => { const snapshot = buildDashboardSnapshot(root, eventLimit); if (json) emit(snapshot); else console.log(`\u001b[2J\u001b[H${renderDashboard(snapshot)}`); };
    draw(); if (!once) await new Promise<void>(() => { setInterval(draw, interval); });
  } else if (cmd === "ci" && sub === "generate") {
    const provider = parseCiProvider(rest[0] ?? ""); const force = rest.includes("--force"); const result = generateCi(root, provider, VERSION, force); const cfg = loadConfig(root); emitHarnessEvent(root, "ci.generated", { provider, created: result.created.length, updated: result.updated.length, preserved: result.preserved.length }, { taskId: loadActiveTask(root)?.id, retainEntries: cfg.events?.retainEntries ?? 5000 }); emit(json ? result : `${provider} CI generated. created=${result.created.length} updated=${result.updated.length} preserved=${result.preserved.length}${result.notes.length ? `\n${result.notes.join("\n")}` : ""}`);
  } else if (cmd === "workspace" && sub === "add") {
    const id = rest[0], path = rest[1]; if (!id || !path) throw new Error("Usage: harness workspace add <id> <path>"); const registry = addWorkspace(root, id, path); const entry = registry.workspaces.find((item) => item.id === id)!; emitHarnessEvent(root, "workspace.registered", { workspaceId: id, root: entry.root }); emit(json ? registry : `Registered workspace ${id}: ${entry.root}`);
  } else if (cmd === "workspace" && sub === "list") {
    const registry = loadWorkspaceRegistry(root); emit(json ? registry : registry.workspaces.length ? registry.workspaces.map((item) => `${item.enabled ? "✓" : "-"} ${item.id} ${item.root}`).join("\n") : "No workspaces registered.");
  } else if (cmd === "workspace" && sub === "remove") {
    const id = rest[0]; if (!id) throw new Error("Usage: harness workspace remove <id>"); const registry = removeWorkspace(root, id); emit(json ? registry : `Removed workspace ${id}.`);
  } else if (cmd === "workspace" && (sub === "enable" || sub === "disable")) {
    const id = rest[0]; if (!id) throw new Error(`Usage: harness workspace ${sub} <id>`); const registry = setWorkspaceEnabled(root, id, sub === "enable"); emit(json ? registry : `${sub === "enable" ? "Enabled" : "Disabled"} workspace ${id}.`);
  } else if (cmd === "scheduler" && sub === "plan") {
    const plan = planWorkspaces(root); emit(json ? plan : plan.length ? plan.map((item) => `${item.runnable ? "READY" : "SKIP"} ${item.id}${item.taskId ? ` task=${item.taskId}/${item.taskStatus}` : ""}${item.reason ? ` reason=${item.reason}` : ""}`).join("\n") : "No workspaces registered.");
  } else if (cmd === "scheduler" && sub === "run") {
    const idx = rest.indexOf("--max-parallel"); const cfg = loadConfig(root); const maxParallel = idx >= 0 ? Number(rest[idx + 1] ?? "") : (cfg.scheduler?.maxParallel ?? 2); const result = await runWorkspaceScheduler(root, maxParallel); emit(json ? result : `Scheduler ${result.id}: completed=${result.results.filter((item) => item.status === "completed").length} failed=${result.results.filter((item) => item.status === "failed").length} skipped=${result.results.filter((item) => item.status === "skipped").length}`);
  } else if (cmd === "events") {
    const limitIndex = rest.indexOf("--limit"); const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1] ?? "100") : 100; const events = loadHarnessEvents(root, Number.isFinite(limit) ? limit : 100); emit(json ? events : events.length ? events.map((event) => `${event.at} ${event.type}${event.taskId ? ` task=${event.taskId}` : ""} ${Object.entries(event.data).map(([k,v]) => `${k}=${v}`).join(" ")}`).join("\n") : "No harness events recorded.");
  } else if (cmd === "migration" && sub === "matrix") {
    const matrix = migrationMatrix(); emit(json ? matrix : matrix.map((row) => `${row.from} -> ${row.to}: ${row.steps.join(", ") || "none"}`).join("\n"));
  } else if (cmd === "migration" && sub === "history") {
    const history = loadMigrationHistory(root); emit(json ? history : history.entries.length ? history.entries.map((entry) => `${entry.appliedAt} ${entry.id}: ${entry.fromVersion} -> ${entry.toVersion}`).join("\n") : "No migrations recorded.");
  } else if (cmd === "migration" && sub === "plan") {
    const from = rest[0] ?? loadConfig(root).harness.version; const plan = migrationPlan(from, VERSION); emit(json ? plan.map(({ id, toVersion, description }) => ({ id, toVersion, description })) : plan.length ? plan.map((step) => `${step.id} -> ${step.toVersion}: ${step.description}`).join("\n") : `No migrations required from ${from}.`);
  } else if (cmd === "release" && sub === "generate") {
    const result = generateReleaseArtifacts(root); emitHarnessEvent(root, "release.generated", { sourceDigest: result.sourceDigest }, { retainEntries: 5000 }); emit(json ? result : `Release artifacts generated. sourceDigest=${result.sourceDigest}`);
  } else if (cmd === "release" && sub === "verify") {
    const result = verifyReleaseArtifacts(root); emitHarnessEvent(root, "release.verified", { valid: result.valid, sourceDigestMatches: result.sourceDigestMatches, checksumsValid: result.checksumsValid, signatureValid: result.signatureValid === null ? "none" : result.signatureValid }, { retainEntries: 5000 }); emit(json ? result : `${result.valid ? "PASS" : "FAIL"} release verification${result.errors.length ? `: ${result.errors.join("; ")}` : ""}`); if (!result.valid) process.exit(1);
  } else if (cmd === "release" && sub === "sign") {
    const keyPath = rest[0]; if (!keyPath) throw new Error("Usage: harness release sign <private-key.pem>"); const signature = signReleaseArtifacts(root, resolve(root, keyPath)); emit(json ? signature : `Release checksums signed with ${signature.algorithm}.`);
  } else if (cmd === "release" && sub === "keyless-sign") {
    const cosignIndex = rest.indexOf("--cosign"); const executable = cosignIndex >= 0 ? rest[cosignIndex + 1] : "cosign"; if (!executable) throw new Error("--cosign requires a path/name."); const result = keylessSignRelease(root, executable); emitHarnessEvent(root, "release.keyless.signed", { bundlePath: result.bundlePath, executable }); emit(json ? result : `Keyless Sigstore bundle created: ${result.bundlePath}`);
  } else if (cmd === "release" && sub === "keyless-verify") {
    const identityIndex = rest.indexOf("--identity"), issuerIndex = rest.indexOf("--issuer"), cosignIndex = rest.indexOf("--cosign"); const identity = identityIndex >= 0 ? rest[identityIndex + 1] : undefined; const issuer = issuerIndex >= 0 ? rest[issuerIndex + 1] : undefined; const executable = cosignIndex >= 0 ? rest[cosignIndex + 1] : "cosign"; if (!executable) throw new Error("--cosign requires a path/name."); const result = keylessVerifyRelease(root, { ...(identity ? { identity } : {}), ...(issuer ? { issuer } : {}) }, executable); emitHarnessEvent(root, "release.keyless.verified", { bundlePath: result.bundlePath, executable, identity: identity ?? "provider-bundle", issuer: issuer ?? "provider-bundle" }); emit(json ? result : `PASS keyless Sigstore verification: ${result.bundlePath}`);
  } else if (cmd === "metrics") {
    const records = loadTurnMetrics(root); const task = loadActiveTask(root); const scoped = task ? records.filter((record) => record.taskId === task.id) : records; const summary = summarizeMetrics(scoped); const byReviewer = summarizeMetricsByReviewer(scoped);
    const reviewerText = byReviewer.length ? `\n\nReviewer usage:\n${byReviewer.map((item) => `- ${item.reviewerName} (${item.provider}/${item.model}): turns=${item.turns}, input=${item.inputTokens ?? "unknown"}, cached=${item.cachedInputTokens ?? "unknown"}, output=${item.outputTokens ?? "unknown"}, estimated=${item.estimatedPromptTokens}, reused=${item.sessionReuseTurns}`).join("\n")}` : "";
    emit(json ? { summary, byReviewer, records: scoped } : `Turns: ${summary.turns}\nProvider-reported usage turns: ${summary.providerReportedTurns}\nInput tokens: ${summary.inputTokens ?? "unknown"}\nCached input tokens: ${summary.cachedInputTokens ?? "unknown"}\nOutput tokens: ${summary.outputTokens ?? "unknown"}\nEstimated prompt tokens: ${summary.estimatedPromptTokens}\nSession reuse turns: ${summary.sessionReuseTurns}${reviewerText}`);
  } else if (cmd === "run" && sub === "lease") {
    const lease = loadRunLease(root); emit(json ? lease : lease ? JSON.stringify(lease, null, 2) : "Run lease is free.");
  } else if (cmd === "evidence" && sub === "run") {
    const key = rest[0]; if (!key) throw new Error("Usage: harness evidence run <verification-key>"); const cfg = loadConfig(root); const command = cfg.verification?.[key]; if (!command) throw new Error(`Verification command not configured: ${key}`); const result = runEvidenceCommand(root, command); emit(json ? result : `${result.exitCode === 0 ? "PASS" : "FAIL"} ${key}: exit=${result.exitCode}, sourceStable=${result.sourceStable}, evidence=${result.id}`);
  } else if (cmd === "run" && sub === "status") { const state = loadRunState(root); emit(json ? state : state ? JSON.stringify(state, null, 2) : "No workflow run state recorded."); }
  else if (cmd === "run") {
    const parsed = parseRunOptions([sub, ...rest].filter((value): value is string => Boolean(value))); const { progress, ...options } = parsed; const eventSink = progress ? (event: HarnessEvent) => console.error(`[${event.type}] ${Object.entries(event.data).map(([k,v]) => `${k}=${v}`).join(" ")}`) : undefined; const result = await runWorkflowAsync(root, { ...options, ...(eventSink ? { eventSink } : {}) }); emit(json ? result : `Harness run ${result.runState.status}: task=${result.task.id} status=${result.task.status} developerTurns=${result.developerTurns.length} evidence=${result.evidence.length} reviews=${result.reviews.length}`);
  } else {
    console.log(`engineering-harness ${VERSION}\n\nCommands:\n  harness init [--root PATH]\n  harness upgrade [--root PATH]\n  harness doctor [--json]\n  harness status [--json]\n  harness config show [--json]\n  harness profile show [--json]\n  harness profile set developer <provider> <model>\n  harness profile set planner <provider> <model>\n  harness profile add reviewer <name> <provider> <model>\n  harness profile remove reviewer <name>\n  harness profile order reviewers <name1,name2,...>\n  harness review policy show [--json]\n  harness review policy set <NONE|LIGHT|FULL> <approvals-required> [max-reviewers]\n  harness plan import <plan-file> [--id PLAN_ID]\n  harness plan show [--json]\n  harness plan approve\n  harness plan run [--max-rounds N] [--verify key1,key2] [--timeout-ms N] [--terminate-grace-ms N] [--progress]\n  harness review classify <description> [--json]\n  harness review dispatch <provider:model[,provider:model...]> <prompt>\n  harness review run <final|checkpoint:id> <provider:model[,provider:model...]> [request]\n  harness task create <id> [title] [level] [reason]\n  harness task archive\n  harness task history [--json]\n  harness task checkpoint add <id>\n  harness task checkpoint activate <id>\n  harness task checkpoint scope <id> <include...> [--exclude <pattern...>]\n  harness task acceptance add <id> <description>\n  harness task review-policy set <approvals-required> [max-reviewers]\n  harness task review-policy clear\n  harness task show [--json]\n  harness task transition <STATUS>\n  harness agent doctor [--json]\n  harness agent models <provider> [--refresh] [--json]\n  harness agent develop <provider> <model> <prompt>\n  harness session show [--json]\n  harness session register <developer|reviewer|planner> <provider> <model> <session-id>\n  harness session resolve <developer|reviewer|planner> <provider> <model> <idle|failed>\n  harness runtime status [--json]\n  harness runtime reconcile [--json]\n  harness runtime cancel <request-id>\n  harness runtime resolve <request-id> <completed|failed>\n  harness context status [--json]\n  harness context compact <developer|reviewer|planner> <provider> <model> [--profile NAME]\n  harness metrics [--json]\n  harness events [--limit N] [--json]\n  harness migration matrix [--json]\n  harness migration plan [from-version] [--json]\n  harness migration history [--json]\n  harness release generate [--json]\n  harness release verify [--json]\n  harness release sign <private-key.pem> [--json]\n  harness release keyless-sign [--cosign PATH] [--json]\n  harness release keyless-verify [--identity VALUE] [--issuer VALUE] [--cosign PATH] [--json]\n  harness ui [--once] [--interval-ms N] [--json]\n  harness ci generate <github|gitlab> [--force] [--json]\n  harness workspace add <id> <path>\n  harness workspace list [--json]\n  harness workspace remove <id>\n  harness workspace enable <id>\n  harness workspace disable <id>\n  harness scheduler plan [--json]\n  harness scheduler run [--max-parallel N] [--json]\n  harness evidence run <verification-key> [--json]\n  harness run [--max-rounds N] [--verify key1,key2] [--timeout-ms N] [--terminate-grace-ms N] [--progress]\n  harness run status [--json]\n  harness run lease [--json]`);
  }
}

main().catch(fail);
