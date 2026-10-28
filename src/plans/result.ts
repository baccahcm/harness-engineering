import { HarnessError } from "../core/errors.js";
import type { ReviewLevel } from "../core/types.js";
import { normalizeScope } from "../core/scope.js";
import type { PlannerAnalysis, PlanTaskSpec } from "./types.js";

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();
  if (fenced) {
    try { return JSON.parse(fenced); } catch {}
  }
  const start = trimmed.indexOf("{"); const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  throw new HarnessError("PLAN_ANALYSIS_INVALID", "Planner response did not contain valid JSON.");
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HarnessError("PLAN_ANALYSIS_INVALID", `Planner field ${field} must be a non-empty string.`);
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new HarnessError("PLAN_ANALYSIS_INVALID", `Planner field ${field} must be an array of non-empty strings.`);
  return value.map((item) => item.trim());
}

function reviewLevel(value: unknown, field: string): ReviewLevel {
  if (value !== "NONE" && value !== "LIGHT" && value !== "FULL") throw new HarnessError("PLAN_ANALYSIS_INVALID", `Planner field ${field} must be NONE, LIGHT, or FULL.`);
  return value;
}

export function parsePlannerAnalysis(response: string): PlannerAnalysis {
  const raw = extractJson(response) as Record<string, unknown>;
  const title = stringValue(raw.title, "title");
  const summary = stringValue(raw.summary, "summary");
  if (!Array.isArray(raw.tasks) || !raw.tasks.length) throw new HarnessError("PLAN_ANALYSIS_INVALID", "Planner must produce at least one task.");
  const seen = new Set<string>();
  const tasks = raw.tasks.map((item, index) => {
    if (!item || typeof item !== "object") throw new HarnessError("PLAN_ANALYSIS_INVALID", `tasks[${index}] must be an object.`);
    const task = item as Record<string, unknown>;
    const id = stringValue(task.id, `tasks[${index}].id`);
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new HarnessError("PLAN_ANALYSIS_INVALID", `Invalid task id: ${id}`);
    if (seen.has(id)) throw new HarnessError("PLAN_ANALYSIS_INVALID", `Duplicate task id: ${id}`);
    seen.add(id);
    const level = reviewLevel(task.reviewLevel, `tasks[${index}].reviewLevel`);
    if (!Array.isArray(task.acceptance) || !task.acceptance.length) throw new HarnessError("PLAN_ANALYSIS_INVALID", `Task ${id} must contain at least one acceptance criterion.`);
    const acceptanceIds = new Set<string>();
    const acceptance = task.acceptance.map((entry, ai) => {
      if (!entry || typeof entry !== "object") throw new HarnessError("PLAN_ANALYSIS_INVALID", `Task ${id} acceptance[${ai}] must be an object.`);
      const a = entry as Record<string, unknown>;
      const acceptanceId = stringValue(a.id, `${id}.acceptance[${ai}].id`);
      if (acceptanceIds.has(acceptanceId)) throw new HarnessError("PLAN_ANALYSIS_INVALID", `Task ${id} has duplicate acceptance id ${acceptanceId}.`);
      acceptanceIds.add(acceptanceId);
      return { id: acceptanceId, description: stringValue(a.description, `${id}.acceptance[${ai}].description`) };
    });
    const checkpointsRaw = task.checkpoints === undefined ? [] : task.checkpoints;
    if (!Array.isArray(checkpointsRaw)) throw new HarnessError("PLAN_ANALYSIS_INVALID", `Task ${id} checkpoints must be an array.`);
    const checkpointIds = new Set<string>();
    const checkpoints = checkpointsRaw.map((entry, ci) => {
      if (!entry || typeof entry !== "object") throw new HarnessError("PLAN_ANALYSIS_INVALID", `Task ${id} checkpoint[${ci}] must be an object.`);
      const c = entry as Record<string, unknown>;
      if (!c.scope || typeof c.scope !== "object") throw new HarnessError("PLAN_ANALYSIS_INVALID", `Task ${id} checkpoint ${ci} requires scope.`);
      const scope = c.scope as Record<string, unknown>;
      const include = stringArray(scope.include, `${id}.checkpoint[${ci}].scope.include`);
      if (!include.length) throw new HarnessError("PLAN_ANALYSIS_INVALID", `Task ${id} checkpoint ${ci} requires at least one include scope.`);
      const exclude = stringArray(scope.exclude, `${id}.checkpoint[${ci}].scope.exclude`);
      const titleValue = typeof c.title === "string" && c.title.trim() ? c.title.trim() : undefined;
      const checkpointId = stringValue(c.id, `${id}.checkpoint[${ci}].id`);
      if (checkpointIds.has(checkpointId)) throw new HarnessError("PLAN_ANALYSIS_INVALID", `Task ${id} has duplicate checkpoint id ${checkpointId}.`);
      checkpointIds.add(checkpointId);
      return { id: checkpointId, ...(titleValue ? { title: titleValue } : {}), scope: normalizeScope({ include, ...(exclude.length ? { exclude } : {}) }) };
    });
    if (level === "FULL" && !checkpoints.length) throw new HarnessError("PLAN_ANALYSIS_INVALID", `FULL task ${id} requires at least one checkpoint with ownership scope.`);
    if (level !== "FULL" && checkpoints.length) throw new HarnessError("PLAN_ANALYSIS_INVALID", `Only FULL task ${id} may define checkpoints.`);
    return {
      id,
      title: stringValue(task.title, `${id}.title`),
      objective: stringValue(task.objective, `${id}.objective`),
      reviewLevel: level,
      reviewReason: stringValue(task.reviewReason, `${id}.reviewReason`),
      acceptance,
      checkpoints,
      dependsOn: stringArray(task.dependsOn, `${id}.dependsOn`),
      verificationKeys: stringArray(task.verificationKeys, `${id}.verificationKeys`),
    };
  });
  return { title, summary, tasks };
}

export function canonicalizePlanTasks(analysis: PlannerAnalysis): PlanTaskSpec[] {
  const byId = new Map(analysis.tasks.map((task) => [task.id, task]));
  for (const task of analysis.tasks) {
    for (const dep of task.dependsOn ?? []) if (!byId.has(dep)) throw new HarnessError("PLAN_DEPENDENCY_UNKNOWN", `Task ${task.id} depends on unknown task ${dep}.`);
    if ((task.dependsOn ?? []).includes(task.id)) throw new HarnessError("PLAN_DEPENDENCY_CYCLE", `Task ${task.id} cannot depend on itself.`);
  }
  const visiting = new Set<string>(), visited = new Set<string>(), order: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new HarnessError("PLAN_DEPENDENCY_CYCLE", `Plan task dependencies contain a cycle involving ${id}.`);
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn ?? []) visit(dep);
    visiting.delete(id); visited.add(id); order.push(id);
  };
  for (const task of analysis.tasks) visit(task.id);
  return order.map((id, executionOrder) => {
    const task = byId.get(id)!;
    return { ...task, checkpoints: task.checkpoints ?? [], dependsOn: task.dependsOn ?? [], ...(task.verificationKeys?.length ? { verificationKeys: task.verificationKeys } : {}), status: "PENDING" as const, executionOrder };
  });
}

export function plannerInstruction(planPath: string, planSha: string): string {
  return [
    "You are the planning analyst for an Engineering Harness project. This is analysis only; do not edit application files.",
    `Read the plan file exactly as written: ${planPath}`,
    `Expected plan SHA-256: ${planSha}`,
    "Inspect project rules and repository structure only as needed to map the plan to executable tasks. Do not invent product requirements that are absent from the plan.",
    "Decompose the plan into the smallest coherent implementation tasks. Use dependencies when one task must finish before another.",
    "Review level guidance: NONE only for non-functional docs/formatting; LIGHT for small isolated behavior; FULL for security, permissions, tenant isolation, financial logic, schema/data migration, concurrency, destructive operations, or substantial cross-component workflows.",
    "Every task needs observable acceptance criteria. Every FULL task needs one or more independently reviewable checkpoints, each with explicit include/exclude ownership globs grounded in the repository/plan.",
    "verificationKeys may contain only verification command keys already configured by the project; omit it if uncertain.",
    "Return JSON only using this exact shape:",
    JSON.stringify({ title: "Plan title", summary: "Concise plan summary", tasks: [{ id: "stable-task-id", title: "Task title", objective: "Outcome", reviewLevel: "LIGHT", reviewReason: "Risk reason", acceptance: [{ id: "A1", description: "Observable behavior" }], checkpoints: [], dependsOn: [], verificationKeys: [] }] }, null, 2),
  ].join("\n");
}
