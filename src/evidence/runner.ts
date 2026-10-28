import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inspectGit, type GitSnapshot } from "../git/git.js";
import { HarnessError } from "../core/errors.js";
import { activeTaskScopedPath, relativeHarnessPath } from "../plans/workspace.js";

export interface EvidenceRun {
  schemaVersion: 1;
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  stdoutPath: string;
  stderrPath: string;
  sourceBefore: GitSnapshot;
  sourceAfter: GitSnapshot;
  sourceStable: boolean;
}

interface EvidenceIndexEntry {
  id: string;
  command: string;
  exitCode: number;
  sourceStable: boolean;
  sourceFingerprint: string;
  startedAt: string;
  finishedAt: string;
}
interface EvidenceIndex { schemaVersion: 1; runs: EvidenceIndexEntry[] }

export function tokenizeCommand(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (const ch of input.trim()) {
    if (escape) { current += ch; escape = false; continue; }
    if (ch === "\\" && quote !== "'") { escape = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { out.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (escape || quote) throw new HarnessError("COMMAND_PARSE_ERROR", "Unterminated quote or escape in verification command.");
  if (current) out.push(current);
  return out;
}

function safeEvidenceName(command: string, startedAt: string): string {
  return createHash("sha256").update(`${startedAt}\n${command}`).digest("hex").slice(0, 12);
}

function updateEvidenceIndex(root: string, evidence: EvidenceRun): void {
  const evidenceDir = activeTaskScopedPath(root, ["evidence"], ["evidence"]);
  const path = join(evidenceDir, "index.json");
  let index: EvidenceIndex = { schemaVersion: 1, runs: [] };
  if (existsSync(path)) {
    try { index = JSON.parse(readFileSync(path, "utf8")) as EvidenceIndex; } catch { index = { schemaVersion: 1, runs: [] }; }
  }
  index.runs.push({
    id: evidence.id,
    command: evidence.command,
    exitCode: evidence.exitCode,
    sourceStable: evidence.sourceStable,
    sourceFingerprint: evidence.sourceAfter.fingerprint,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
  });
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
}

export function runEvidenceCommand(root: string, command: string): EvidenceRun {
  const tokens = tokenizeCommand(command);
  if (!tokens.length) throw new HarnessError("COMMAND_PARSE_ERROR", "Verification command is empty.");
  const startedAt = new Date().toISOString();
  const before = inspectGit(root);
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    stdout = execFileSync(tokens[0], tokens.slice(1), { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { status?: number; stdout?: string | { toString(): string }; stderr?: string | { toString(): string }; message?: string };
    stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "";
    stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? e.message ?? "";
    exitCode = typeof e.status === "number" ? e.status : 1;
  }
  const after = inspectGit(root);
  const finishedAt = new Date().toISOString();
  const id = safeEvidenceName(command, startedAt);
  const evidenceRoot = activeTaskScopedPath(root, ["evidence"], ["evidence"]);
  const dir = join(evidenceRoot, id);
  mkdirSync(dir, { recursive: true });
  const stdoutAbs = join(dir, "stdout.log");
  const stderrAbs = join(dir, "stderr.log");
  const stdoutPath = relativeHarnessPath(root, stdoutAbs);
  const stderrPath = relativeHarnessPath(root, stderrAbs);
  writeFileSync(stdoutAbs, stdout);
  writeFileSync(stderrAbs, stderr);
  const evidence: EvidenceRun = {
    schemaVersion: 1, id, command, cwd: root, startedAt, finishedAt, exitCode,
    stdoutPath, stderrPath, sourceBefore: before, sourceAfter: after,
    sourceStable: before.fingerprint === after.fingerprint,
  };
  writeFileSync(join(dir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  updateEvidenceIndex(root, evidence);
  return evidence;
}
