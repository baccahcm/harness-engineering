import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeScope, pathInScope } from "../core/scope.js";
import type { CheckpointScope } from "../core/types.js";

export interface GitSnapshot {
  isRepository: boolean;
  head: string | null;
  dirty: boolean;
  changedFiles: string[];
  fingerprint: string;
  scope?: CheckpointScope;
  scopedFiles?: string[];
}

export interface FileManifest { files: Record<string, string> }

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function statusPath(line: string): string {
  const raw = line.slice(3);
  const rename = raw.includes(" -> ") ? raw.split(" -> ").pop() ?? raw : raw;
  return rename.replace(/^"|"$/g, "").replace(/\\/g, "/");
}

function isHarnessRuntimePath(file: string): boolean {
  return file === ".harness" || file.startsWith(".harness/");
}

function repositoryFiles(cwd: string): string[] {
  if (!existsSync(join(cwd, ".git"))) return [];
  const raw = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return [...new Set(raw.split("\0").filter(Boolean).map((file) => file.replace(/\\/g, "/")).filter((file) => !isHarnessRuntimePath(file)))].sort();
}

function contentHash(cwd: string, file: string): string {
  if (!existsSync(join(cwd, file))) return "missing";
  try { return git(cwd, ["hash-object", "--", file]).trim(); }
  catch { return "unreadable"; }
}

export function captureFileManifest(cwd: string, scope?: CheckpointScope): FileManifest {
  const normalized = scope ? normalizeScope(scope) : undefined;
  const files = repositoryFiles(cwd).filter((file) => !normalized || pathInScope(file, normalized));
  const manifest: Record<string, string> = {};
  for (const file of files) manifest[file] = contentHash(cwd, file);
  return { files: manifest };
}

export function diffFileManifests(before: FileManifest, after: FileManifest): string[] {
  const keys = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...keys].filter((file) => before.files[file] !== after.files[file]).sort();
}

export function inspectGit(cwd: string, scope?: CheckpointScope): GitSnapshot {
  if (!existsSync(join(cwd, ".git"))) {
    const normalized = scope ? normalizeScope(scope) : undefined;
    return {
      isRepository: false,
      head: null,
      dirty: false,
      changedFiles: [],
      fingerprint: createHash("sha256").update(JSON.stringify({ noGit: true, scope: normalized ?? null })).digest("hex"),
      ...(normalized ? { scope: normalized, scopedFiles: [] } : {}),
    };
  }
  let head: string | null = null;
  try { head = git(cwd, ["rev-parse", "HEAD"]).trim() || null; } catch { head = null; }
  const rawStatus = git(cwd, ["status", "--porcelain=v1", "-uall"]);
  const allStatusLines = rawStatus ? rawStatus.split(/\r?\n/).filter((line) => !isHarnessRuntimePath(statusPath(line))) : [];

  if (scope) {
    const normalized = normalizeScope(scope);
    const statusLines = allStatusLines.filter((line) => pathInScope(statusPath(line), normalized));
    const changedFiles = statusLines.map(statusPath).sort();
    const manifest = captureFileManifest(cwd, normalized);
    const scopedFiles = Object.keys(manifest.files).sort();
    // Intentionally excludes global HEAD so unrelated commits/changes outside this scope do not invalidate approval.
    const fingerprint = createHash("sha256").update(JSON.stringify({ scope: normalized, files: manifest.files })).digest("hex");
    return { isRepository: true, head, dirty: Boolean(statusLines.length), changedFiles, fingerprint, scope: normalized, scopedFiles };
  }

  const statusLines = allStatusLines;
  const status = statusLines.join("\n");
  const changedFiles = statusLines.map(statusPath).sort();
  const pathspec = ["--", ".", ":(exclude).harness/**"];
  let diff = "";
  try { diff += git(cwd, ["diff", "--no-ext-diff", "--binary", ...pathspec]); } catch {}
  try { diff += git(cwd, ["diff", "--cached", "--no-ext-diff", "--binary", ...pathspec]); } catch {}
  const untrackedContents: string[] = [];
  for (const line of statusLines.filter((line) => line.startsWith("??"))) {
    const file = statusPath(line);
    try { untrackedContents.push(`${file}:${git(cwd, ["hash-object", "--", file])}`); }
    catch { untrackedContents.push(`${file}:unreadable`); }
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ head, status, diff, untrackedContents })).digest("hex");
  return { isRepository: true, head, dirty: Boolean(status), changedFiles, fingerprint };
}
