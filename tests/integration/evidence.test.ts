import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runEvidenceCommand, tokenizeCommand } from "../../src/evidence/runner.js";
import { inspectGit } from "../../src/git/git.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-evidence-"));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "a\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root });
  return root;
}

test("command tokenizer handles quoted arguments without shell execution", () => {
  assert.deepEqual(tokenizeCommand('node -e "console.log(1)"'), ["node", "-e", "console.log(1)"]);
});

test("evidence runner records exit and source stability", () => {
  const root = repo();
  try {
    const evidence = runEvidenceCommand(root, 'node -e "console.log(123)"');
    assert.equal(evidence.exitCode, 0);
    assert.equal(evidence.sourceStable, true);
    assert.ok(existsSync(join(root, ".harness", "evidence", evidence.id, "evidence.json")));
    assert.equal(inspectGit(root).fingerprint, evidence.sourceAfter.fingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
