import { HarnessError } from "./errors.js";
import type { CheckpointScope } from "./types.js";

export function normalizeRepoPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function validatePattern(pattern: string): string {
  const normalized = normalizeRepoPath(pattern.trim());
  if (!normalized) throw new HarnessError("SCOPE_INVALID", "Scope patterns must not be empty.");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) throw new HarnessError("SCOPE_INVALID", `Scope must be repository-relative: ${pattern}`);
  if (normalized.split("/").includes("..")) throw new HarnessError("SCOPE_INVALID", `Scope must not escape the repository: ${pattern}`);
  if (normalized === ".harness" || normalized.startsWith(".harness/")) throw new HarnessError("SCOPE_INVALID", "Harness runtime files cannot be application ownership scope.");
  return normalized;
}

export function normalizeScope(scope: CheckpointScope): CheckpointScope {
  const include = [...new Set(scope.include.map(validatePattern))];
  if (!include.length) throw new HarnessError("SCOPE_INVALID", "Checkpoint scope requires at least one include pattern.");
  const exclude = [...new Set((scope.exclude ?? []).map(validatePattern))];
  return exclude.length ? { include, exclude } : { include };
}

function escapeRegex(ch: string): string { return /[\\^$+?.()|{}\[\]]/.test(ch) ? `\\${ch}` : ch; }

export function globToRegExp(patternInput: string): RegExp {
  const pattern = normalizeRepoPath(patternInput);
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") { i += 1; out += "(?:.*/)?"; }
        else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += escapeRegex(ch);
  }
  out += "$";
  return new RegExp(out);
}

export function pathInScope(pathInput: string, scopeInput: CheckpointScope): boolean {
  const path = normalizeRepoPath(pathInput);
  const scope = normalizeScope(scopeInput);
  const included = scope.include.some((pattern) => globToRegExp(pattern).test(path));
  if (!included) return false;
  return !(scope.exclude ?? []).some((pattern) => globToRegExp(pattern).test(path));
}

export function outOfScopePaths(paths: string[], scope: CheckpointScope): string[] {
  return paths.map(normalizeRepoPath).filter((path) => !pathInScope(path, scope));
}
