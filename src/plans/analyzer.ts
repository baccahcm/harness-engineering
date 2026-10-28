import { HarnessError } from "../core/errors.js";
import { loadConfig, requirePlannerProfile } from "../core/config.js";
import type { AgentProfile } from "../core/types.js";
import { createDefaultAdapters } from "../agents/registry.js";
import { assertAdapterReady } from "../agents/capabilities.js";
import { executeAgentStreaming } from "../agents/async-executor.js";
import { recordTurnMetric } from "../metrics/store.js";
import { emitHarnessEvent } from "../events/bus.js";
import { canonicalizePlanTasks, parsePlannerAnalysis, plannerInstruction } from "./result.js";
import { loadActivePlan, resolvePlanSource, savePlanManifest } from "./store.js";
import type { PlanManifest } from "./types.js";
import { clearPlanContext, ensurePlanWorkspace, setPlanContext } from "./workspace.js";

function planIdFromPath(path: string): string {
  const base = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") || "plan";
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "plan";
}

export interface ImportPlanOptions {
  id?: string;
  planner?: AgentProfile;
  timeoutMs?: number;
  terminateGraceMs?: number;
  responseOverride?: string;
}

export async function importPlan(root: string, planPath: string, options: ImportPlanOptions = {}): Promise<PlanManifest> {
  const cfg = loadConfig(root);
  const source = resolvePlanSource(root, planPath);
  const selected = options.planner ? { profile: options.planner, source: "configured" as const } : requirePlannerProfile(cfg);
  const adapters = createDefaultAdapters();
  const adapter = adapters[selected.profile.provider];
  if (!adapter) throw new HarnessError("ADAPTER_MISSING", `No adapter registered for planner provider ${selected.profile.provider}.`);
  const id = options.id ?? planIdFromPath(source.relative);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new HarnessError("PLAN_ID_INVALID", "Plan ID may contain only letters, numbers, dot, underscore, and hyphen.");
  const active = loadActivePlan(root);
  if (active && active.id !== id && active.status !== "COMPLETED") throw new HarnessError("ACTIVE_PLAN_EXISTS", `Active plan ${active.id} is ${active.status}. Complete it before importing another plan.`);
  if (active?.id === id && active.status !== "DRAFT" && active.status !== "COMPLETED") throw new HarnessError("PLAN_REIMPORT_NOT_ALLOWED", `Plan ${id} is ${active.status}; re-import is allowed only while DRAFT or after completion.`);
  let response = options.responseOverride;
  let sessionId: string | undefined;
  let usage: Awaited<ReturnType<typeof executeAgentStreaming>>["usage"];
  ensurePlanWorkspace(root, id);
  if (response === undefined) {
    setPlanContext(root, id);
    try {
      assertAdapterReady(adapter, "planner", selected.profile.model, root);
      const requestId = `plan-${id}-${Date.now()}`;
      emitHarnessEvent(root, "plan.analysis.started", { planId: id, provider: selected.profile.provider, model: selected.profile.model, source: source.relative }, { retainEntries: cfg.events?.retainEntries ?? 5000 });
      const result = await executeAgentStreaming(root, adapter, { workspace: root, prompt: plannerInstruction(source.relative, source.sha256), model: selected.profile.model, purpose: "planner" }, requestId, { taskId: `plan:${id}`, timeoutMs: options.timeoutMs ?? cfg.runtime?.agentTimeoutMs, terminateGraceMs: options.terminateGraceMs ?? cfg.runtime?.terminateGraceMs });
      recordTurnMetric(root, { taskId: `plan:${id}`, requestId, provider: selected.profile.provider, purpose: "planner", model: selected.profile.model, ...(result.sessionId ? { sessionId: result.sessionId } : {}), success: result.success, ...(result.usage ? { usage: result.usage } : {}), responseChars: result.response.length });
      if (!result.success) throw new HarnessError(result.failureCode ?? "PLAN_ANALYSIS_FAILED", result.response || result.rawStderr || "Planner agent failed.");
      response = result.response; sessionId = result.sessionId; usage = result.usage;
    } finally { clearPlanContext(root); }
  }
  const analysis = parsePlannerAnalysis(response);
  const tasks = canonicalizePlanTasks(analysis);
  const configuredVerification = new Set(Object.keys(cfg.verification ?? {}));
  for (const task of tasks) for (const key of task.verificationKeys ?? []) if (!configuredVerification.has(key)) throw new HarnessError("PLAN_VERIFICATION_UNKNOWN", `Plan task ${task.id} references verification key ${key}, which is not configured in .harness/config.yaml.`);
  const manifest: PlanManifest = {
    schemaVersion: 1,
    id,
    title: analysis.title,
    summary: analysis.summary,
    status: "DRAFT",
    source: { path: source.relative, sha256: source.sha256, size: source.size, importedAt: new Date().toISOString() },
    planner: { provider: selected.profile.provider, model: selected.profile.model, analyzedAt: new Date().toISOString(), source: selected.source },
    tasks,
  };
  savePlanManifest(root, manifest);
  emitHarnessEvent(root, "plan.imported", { planId: id, source: source.relative, tasks: tasks.length, planner: `${selected.profile.provider}/${selected.profile.model}`, ...(sessionId ? { sessionId } : {}), ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}) }, { retainEntries: cfg.events?.retainEntries ?? 5000 });
  return manifest;
}
