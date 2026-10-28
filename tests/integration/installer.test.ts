import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { initProject, upgradeProject, MANAGED_START } from "../../src/installer/install.js";
import { inspectGit } from "../../src/git/git.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-test-"));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Harness Test"], { cwd: root });
  writeFileSync(join(root, "AGENTS.md"), "# Existing rules\n\nDo not remove me.\n");
  writeFileSync(join(root, "app.txt"), "original\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd: root });
  return root;
}

test("init preserves AGENTS rules and is idempotent", () => {
  const root = makeRepo();
  try {
    const beforeApp = readFileSync(join(root, "app.txt"), "utf8");
    initProject(root);
    const once = readFileSync(join(root, "AGENTS.md"), "utf8");
    initProject(root);
    const twice = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.ok(once.includes("Do not remove me."));
    assert.equal((twice.match(new RegExp(MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 1);
    assert.equal(readFileSync(join(root, "app.txt"), "utf8"), beforeApp);
    assert.ok(existsSync(join(root, ".harness", "config.yaml")));
    assert.ok(existsSync(join(root, "TEAM-WORKFLOW.md")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("git fingerprint changes after tracked and untracked source edits", () => {
  const root = makeRepo();
  try {
    const clean = inspectGit(root).fingerprint;
    writeFileSync(join(root, "app.txt"), "changed\n");
    const tracked = inspectGit(root).fingerprint;
    assert.ok(clean !== tracked);
    writeFileSync(join(root, "new.txt"), "one\n");
    const u1 = inspectGit(root).fingerprint;
    writeFileSync(join(root, "new.txt"), "two\n");
    const u2 = inspectGit(root).fingerprint;
    assert.ok(u1 !== u2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrade changes harness metadata but preserves project workflow files", () => {
  const root = makeRepo();
  try {
    initProject(root);
    const configPath = join(root, ".harness", "config.yaml");
    const configBefore = readFileSync(configPath, "utf8").replace("version: 0.8.3", "version: 0.2.0");
    writeFileSync(configPath, configBefore);
    writeFileSync(join(root, "TEAM-WORKFLOW.md"), "# local workflow edit\n");
    const result = upgradeProject(root, "0.8.3");
    assert.equal(result.fromVersion, "0.2.0");
    assert.equal(readFileSync(join(root, "TEAM-WORKFLOW.md"), "utf8"), "# local workflow edit\n");
    assert.ok(readFileSync(configPath, "utf8").includes("version: 0.8.3"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

