import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
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

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function gitRaw(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
}

function git(cwd: string, args: string[]): string {
  return gitRaw(cwd, args).trimEnd();
}

interface StatusEntry {
  xy: string;
  path: string;
  origPath?: string;
}

function normalizeGitPath(file: string): string {
  return file.replace(/\\/g, "/");
}

function parsePorcelainZ(raw: string): StatusEntry[] {
  if (!raw) return [];
  const tokens = raw.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const xy = token.slice(0, 2);
    const path = normalizeGitPath(token.slice(3));
    if (xy[0] === "R" || xy[1] === "R" || xy[0] === "C" || xy[1] === "C") {
      const origRaw = tokens[i + 1] ?? "";
      i += 1;
      entries.push({ xy, path, origPath: normalizeGitPath(origRaw) });
    } else {
      entries.push({ xy, path });
    }
  }
  return entries;
}

function isHarnessRuntimePath(file: string): boolean {
  return file === ".harness" || file.startsWith(".harness/");
}

function repositoryFiles(cwd: string): string[] {
  if (!existsSync(join(cwd, ".git"))) return [];
  const raw = gitRaw(cwd, ["ls-files", "-co", "--exclude-standard", "-z"]);
  return [...new Set(raw.split("\0").filter(Boolean).map(normalizeGitPath).filter((file) => !isHarnessRuntimePath(file)))].sort();
}

function contentHash(cwd: string, file: string): string {
  const fullPath = join(cwd, file);
  if (!existsSync(fullPath)) return "missing";
  const stat = statSync(fullPath);
  if (stat.isDirectory()) return "directory";
  return createHash("sha256").update(readFileSync(fullPath)).digest("hex");
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
  const rawStatus = gitRaw(cwd, ["status", "--porcelain=v1", "-z", "-uall"]);
  const allEntries = parsePorcelainZ(rawStatus).filter(
    (entry) => !isHarnessRuntimePath(entry.path) && (!entry.origPath || !isHarnessRuntimePath(entry.origPath)),
  );

  if (scope) {
    const normalized = normalizeScope(scope);
    const statusEntries = allEntries.filter(
      (entry) => pathInScope(entry.path, normalized) || (entry.origPath !== undefined && pathInScope(entry.origPath, normalized)),
    );
    const changedFiles = [
      ...new Set(
        statusEntries
          .flatMap((entry) => [entry.path, ...(entry.origPath ? [entry.origPath] : [])])
          .filter((file) => pathInScope(file, normalized)),
      ),
    ].sort();
    const manifest = captureFileManifest(cwd, normalized);
    const scopedFiles = Object.keys(manifest.files).sort();
    // Intentionally excludes global HEAD so unrelated commits/changes outside this scope do not invalidate approval.
    const fingerprint = createHash("sha256").update(JSON.stringify({ scope: normalized, files: manifest.files })).digest("hex");
    return { isRepository: true, head, dirty: Boolean(statusEntries.length), changedFiles, fingerprint, scope: normalized, scopedFiles };
  }

  const status = allEntries
    .map((entry) => (entry.origPath ? `${entry.xy} ${entry.origPath} -> ${entry.path}` : `${entry.xy} ${entry.path}`))
    .join("\n");
  const changedFiles = [
    ...new Set(allEntries.flatMap((entry) => [entry.path, ...(entry.origPath ? [entry.origPath] : [])])),
  ].sort();
  const workingTreeFiles: Record<string, string> = {};
  for (const file of changedFiles) {
    workingTreeFiles[file] = contentHash(cwd, file);
  }
  const stagedIndex = changedFiles.length
    ? gitRaw(cwd, ["ls-files", "-s", "-z", "--", ...changedFiles]).split("\0").filter(Boolean)
    : [];
  const fingerprint = createHash("sha256").update(JSON.stringify({ head, status, stagedIndex, workingTreeFiles })).digest("hex");
  return { isRepository: true, head, dirty: Boolean(allEntries.length), changedFiles, fingerprint };
}
