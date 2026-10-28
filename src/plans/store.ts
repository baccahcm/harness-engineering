import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { HarnessError } from "../core/errors.js";
import type { TaskState } from "../core/types.js";
import type { PlanManifest } from "./types.js";
import { ensurePlanWorkspace, planSourceMetadataPath, planWorkspaceRoot } from "./workspace.js";

export function plansDir(root: string): string { return join(root, ".harness", "plans"); }
export function activePlanPath(root: string): string { return join(plansDir(root), "active.json"); }
export function planManifestPath(root: string, id: string): string { return join(planWorkspaceRoot(root, id), "manifest.json"); }

export function hashPlanContent(content: string): string { return createHash("sha256").update(content).digest("hex"); }

export function resolvePlanSource(root: string, input: string): { absolute: string; relative: string; content: string; sha256: string; size: number } {
  const absolute = resolve(root, input);
  if (!existsSync(absolute)) throw new HarnessError("PLAN_FILE_MISSING", `Plan file does not exist: ${input}`);
  const rel = relative(root, absolute).replace(/\\/g, "/");
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) throw new HarnessError("PLAN_OUTSIDE_WORKSPACE", "Plan file must be inside the project workspace.");
  const content = readFileSync(absolute, "utf8");
  if (!content.trim()) throw new HarnessError("PLAN_EMPTY", `Plan file is empty: ${rel}`);
  return { absolute, relative: rel, content, sha256: hashPlanContent(content), size: Buffer.byteLength(content) };
}

export function savePlanManifest(root: string, manifest: PlanManifest): void {
  const dir = ensurePlanWorkspace(root, manifest.id);
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(planSourceMetadataPath(root, manifest.id), `${JSON.stringify({ schemaVersion: 1, ...manifest.source }, null, 2)}\n`);
  mkdirSync(plansDir(root), { recursive: true });
  writeFileSync(activePlanPath(root), `${JSON.stringify({ schemaVersion: 1, planId: manifest.id }, null, 2)}\n`);
}

export function loadPlanManifest(root: string, id: string): PlanManifest {
  const path = planManifestPath(root, id);
  if (!existsSync(path)) throw new HarnessError("PLAN_NOT_FOUND", `Plan manifest not found: ${id}`);
  const value = JSON.parse(readFileSync(path, "utf8")) as PlanManifest;
  if (value.schemaVersion !== 1 || value.id !== id || !Array.isArray(value.tasks)) throw new HarnessError("PLAN_MANIFEST_INVALID", `Invalid plan manifest: ${id}`);
  return value;
}

export function loadActivePlan(root: string): PlanManifest | null {
  const pointer = activePlanPath(root);
  if (!existsSync(pointer)) return null;
  const value = JSON.parse(readFileSync(pointer, "utf8")) as { schemaVersion?: number; planId?: string };
  if (value.schemaVersion !== 1 || !value.planId) throw new HarnessError("PLAN_POINTER_INVALID", "Invalid active plan pointer.");
  return loadPlanManifest(root, value.planId);
}

export function assertPlanSourceFresh(root: string, manifest: PlanManifest): void {
  const source = resolvePlanSource(root, manifest.source.path);
  if (source.sha256 !== manifest.source.sha256) throw new HarnessError("PLAN_CHANGED", `Plan source changed after import: ${manifest.source.path}. Imported=${manifest.source.sha256}, current=${source.sha256}. Re-import/re-approve the plan before continuing.`);
}

export function assertTaskPlanFresh(root: string, task: TaskState): void {
  if (!task.plan) return;
  const manifest = loadPlanManifest(root, task.plan.manifestId);
  assertPlanSourceFresh(root, manifest);
  if (task.plan.sourceSha256 !== manifest.source.sha256 || task.plan.sourcePath !== manifest.source.path) throw new HarnessError("PLAN_TASK_MISMATCH", `Active task ${task.id} is not bound to the current canonical plan source.`);
}
