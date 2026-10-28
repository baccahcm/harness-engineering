import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../../src/installer/install.js";
import { loadConfig, saveConfig } from "../../src/core/config.js";
import { createTask } from "../../src/core/task.js";
import { saveActiveTask } from "../../src/core/store.js";
import { transitionTask } from "../../src/core/state-machine.js";
import { runWorkflowAsync } from "../../src/orchestration/run.js";
import { orchestrateReview } from "../../src/review/orchestrator.js";
import type { AgentAdapter } from "../../src/agents/types.js";
import type { ReviewDispatchResult } from "../../src/review/dispatcher.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-async-run-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "a0\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
  initProject(root);
  const cfg = loadConfig(root);
  cfg.verification = { unit: 'node -e "process.exit(0)"' };
  cfg.agents = { developer: { provider: "antigravity", model: "dev" }, reviewers: [{ name: "primary", provider: "codex", model: "review" }] };
  cfg.orchestration = { maxReviewRounds: 2, verificationKeys: ["unit"] };
  cfg.runtime = { agentTimeoutMs: 1000, terminateGraceMs: 20 };
  saveConfig(root, cfg);
  return root;
}

const approved = JSON.stringify({ schemaVersion: 1, verdict: "APPROVED", summary: "approved", findings: [], evidence: ["inspected source"], notChecked: [] });
function dispatch(): ReviewDispatchResult {
  return { reviewer: { provider: "codex", model: "review" }, attempts: [{ reviewer: { provider: "codex", model: "review" } }], result: { provider: "codex", success: true, sessionId: "review-session", response: approved, rawStdout: approved, rawStderr: "", exitCode: 0 } };
}
const adapters = { antigravity: { provider: "antigravity", executable: "agy" } as AgentAdapter, codex: { provider: "codex", executable: "codex" } as AgentAdapter };

test("async workflow path completes developer, evidence and review", async () => {
  const root = repo();
  try {
    saveActiveTask(root, transitionTask(createTask("async-light", "Async light", "LIGHT", "small"), "READY_FOR_DEV"));
    const events: string[] = [];
    const result = await runWorkflowAsync(root, { eventSink: (event) => events.push(event.type) }, {
      adapters,
      develop: async (workspace) => {
        writeFileSync(join(workspace, "src", "a.ts"), "a1\n");
        return { provider: "antigravity", success: true, sessionId: "dev-session", response: "done", rawStdout: "", rawStderr: "", exitCode: 0 };
      },
      review: async (...args: any[]) => orchestrateReview(args[0], args[1], args[2], args[3], args[4], "review-async", () => dispatch()),
    });
    assert.equal(result.task.status, "COMPLETED");
    assert.equal(result.developerTurns.length, 1);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.reviews.length, 1);
    assert.ok(events.includes("run.started"));
    assert.ok(events.includes("run.phase"));
    assert.ok(events.includes("run.completed"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
