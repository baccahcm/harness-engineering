import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject, upgradeProject } from "../../src/installer/install.js";
import { generateCi } from "../../src/ci/generate.js";
import { buildDashboardSnapshot, renderDashboard } from "../../src/operator/dashboard.js";
import { generateReleaseArtifacts } from "../../src/release/provenance.js";
import { detectCosign, keylessSignRelease, keylessVerifyRelease } from "../../src/release/sigstore.js";
import { addWorkspace, loadWorkspaceRegistry, planWorkspaces, setWorkspaceEnabled } from "../../src/scheduler/workspaces.js";
import { runWorkspaceScheduler } from "../../src/scheduler/run.js";
import { beginActiveTask, saveActiveTask } from "../../src/core/store.js";
import { createTask } from "../../src/core/task.js";
import { transitionTask } from "../../src/core/state-machine.js";
import { loadConfig, saveConfig } from "../../src/core/config.js";
import { migrationMatrix } from "../../src/migrations/index.js";

function root(prefix = "harness-v08-"): string {
  const r = mkdtempSync(join(tmpdir(), prefix)); initProject(r); return r;
}

test("operator dashboard renders task/run-safe metadata without model content", () => {
  const r = root();
  try {
    const task = transitionTask(createTask("dash", "Dashboard task", "LIGHT", "test"), "READY_FOR_DEV");
    beginActiveTask(r, task);
    const snapshot = buildDashboardSnapshot(r, 5);
    assert.equal(snapshot.task?.id, "dash");
    const text = renderDashboard(snapshot);
    assert.ok(text.includes("Engineering Harness — Operator Dashboard"));
    assert.ok(text.includes("dash / READY_FOR_DEV / LIGHT"));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("GitHub CI generator is idempotent and refuses unmanaged overwrite", () => {
  const r = root();
  try {
    const first = generateCi(r, "github", "0.8.0");
    assert.deepEqual(first.created, [".github/workflows/engineering-harness.yml"]);
    const second = generateCi(r, "github", "0.8.0");
    assert.deepEqual(second.preserved, [".github/workflows/engineering-harness.yml"]);
    const path = join(r, ".github", "workflows", "engineering-harness.yml");
    writeFileSync(path, "name: user workflow\n");
    assert.throws(() => generateCi(r, "github", "0.8.0"), (err: any) => err?.code === "CI_FILE_CONFLICT");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("GitLab CI generator preserves unmanaged main file and emits include fragment", () => {
  const r = root();
  try {
    writeFileSync(join(r, ".gitlab-ci.yml"), "user-job:\n  script: echo user\n");
    const result = generateCi(r, "gitlab", "0.8.0");
    assert.ok(result.preserved.includes(".gitlab-ci.yml"));
    assert.ok(result.notes.length === 1);
    assert.ok(existsSync(join(r, ".harness", "ci", "gitlab-ci.yml")));
    assert.ok(readFileSync(join(r, ".gitlab-ci.yml"), "utf8").includes("user-job"));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("Sigstore adapter builds keyless sign/verify commands without storing credentials", () => {
  const r = mkdtempSync(join(tmpdir(), "harness-sigstore-"));
  try {
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src", "x.ts"), "export const x = 1;\n");
    writeFileSync(join(r, "package.json"), JSON.stringify({ name: "sigstore-test", version: "1.0.0" }));
    writeFileSync(join(r, "tsconfig.json"), "{}\n"); writeFileSync(join(r, "README.md"), "x\n"); writeFileSync(join(r, "HANDOFF.md"), "x\n");
    generateReleaseArtifacts(r, "2026-01-01T00:00:00Z");
    const calls: string[][] = [];
    const exec = (_file: string, args: string[]) => { calls.push(args); if (args[0] === "sign-blob") writeFileSync(join(r, "release", "cosign.bundle.json"), "{\"bundle\":true}\n"); return "ok"; };
    assert.equal(detectCosign("cosign", exec).available, true);
    keylessSignRelease(r, "cosign", exec);
    keylessVerifyRelease(r, { identity: "repo@example", issuer: "https://issuer" }, "cosign", exec);
    assert.deepEqual(calls[1].slice(0, 4), ["sign-blob", "--yes", "--bundle", join(r, "release", "cosign.bundle.json")]);
    assert.ok(calls[2].includes("--certificate-identity"));
    assert.ok(calls[2].includes("--certificate-oidc-issuer"));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("workspace registry plans independent runnable tasks and scheduler respects max parallel runner contract", async () => {
  const controller = root("harness-controller-"); const a = root("harness-work-a-"); const b = root("harness-work-b-");
  try {
    for (const [r, id] of [[a, "a"], [b, "b"]] as const) {
      const task = transitionTask(createTask(id, id, "NONE", "test"), "READY_FOR_DEV");
      beginActiveTask(r, task);
    }
    addWorkspace(controller, "a", a); addWorkspace(controller, "b", b);
    assert.equal(loadWorkspaceRegistry(controller).workspaces.length, 2);
    const plan = planWorkspaces(controller);
    assert.ok(plan.every((item) => item.runnable));
    let inFlight = 0, peak = 0;
    const result = await runWorkspaceScheduler(controller, 1, async (workspace) => {
      inFlight += 1; peak = Math.max(peak, inFlight); await new Promise<void>((resolve) => setTimeout(resolve, 5)); inFlight -= 1;
      return { id: workspace.id, root: workspace.root, status: "completed", exitCode: 0, stdout: "ok", stderr: "" };
    });
    assert.equal(peak, 1);
    assert.equal(result.results.filter((item) => item.status === "completed").length, 2);
    setWorkspaceEnabled(controller, "b", false);
    assert.equal(planWorkspaces(controller).find((item) => item.id === "b")?.runnable, false);

    // Dead owner's run lease does not block scheduling readiness.
    const leaseDir = join(a, ".harness", "state", "run-lease");
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(join(leaseDir, "lease.json"), JSON.stringify({ schemaVersion: 1, taskId: "a", pid: 99999999, acquiredAt: "2026-01-01T00:00:00Z" }));
    assert.equal(planWorkspaces(controller).find((item) => item.id === "a")?.runnable, true);

    // Unresolved uncertain session blocks scheduling readiness even without a live runtime process entry.
    const { loadSessionRegistry, registerSession, markInFlight, markUncertain, saveSessionRegistry } = await import("../../src/agents/session-registry.js");
    const registry = loadSessionRegistry(a);
    const session = registerSession(registry, "a", { provider: "antigravity", purpose: "developer", model: "m", sessionId: "s-uncertain", workspace: a });
    markInFlight(session, "req-uncertain");
    markUncertain(session);
    saveSessionRegistry(a, registry);
    const plannedA = planWorkspaces(controller).find((item) => item.id === "a");
    assert.equal(plannedA?.runnable, false);
    assert.ok(plannedA?.reason?.includes("uncertain session"));
  } finally { rmSync(controller, { recursive: true, force: true }); rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test("migration matrix covers V0.1-V0.7 and upgrade supplies V0.8 operator/scheduler defaults", () => {
  const matrix = migrationMatrix();
  assert.equal(matrix.length, 10);
  assert.ok(matrix.every((row) => row.to === "0.8.3"));
  const r = root();
  try {
    const cfg = loadConfig(r); cfg.harness.version = "0.7.0"; delete cfg.operator; delete cfg.scheduler; saveConfig(r, cfg);
    upgradeProject(r, "0.8.3"); const next = loadConfig(r);
    assert.equal(next.harness.version, "0.8.3"); assert.equal(next.operator?.refreshIntervalMs, 1000); assert.equal(next.scheduler?.maxParallel, 2); assert.equal(next.reviewPolicy?.levels.LIGHT.approvalsRequired, 1);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
