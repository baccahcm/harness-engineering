import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../../src/installer/install.js";
import { createTask } from "../../src/core/task.js";
import { saveActiveTask } from "../../src/core/store.js";
import { transitionTask } from "../../src/core/state-machine.js";
import { dispatchReview } from "../../src/review/dispatcher.js";
import { dispatchDeveloper } from "../../src/agents/developer-dispatcher.js";
import { findSession, loadSessionRegistry } from "../../src/agents/session-registry.js";
import type { AgentAdapter, AgentRequest, AgentTurnResult } from "../../src/agents/types.js";

class FakeAdapter implements AgentAdapter {
  constructor(readonly provider: "codex" | "antigravity", readonly executable = "fake") {}
  detect() { return { provider: this.provider, executable: this.executable, available: true }; }
  buildCommand(request: AgentRequest) { return { executable: "fake", args: [request.prompt], cwd: request.workspace }; }
  parseResult(): AgentTurnResult { throw new Error("unused"); }
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harness-v02-"));
  initProject(value);
  return value;
}

function reviewTask(rootPath: string) {
  let task = createTask("t1", "Task", "FULL", "risk");
  task = transitionTask(task, "READY_FOR_DEV");
  task = transitionTask(task, "IN_PROGRESS");
  task = transitionTask(task, "READY_FOR_REVIEW");
  saveActiveTask(rootPath, task);
}

test("review dispatch captures new session and reuses exact session", () => {
  const r = root();
  try {
    reviewTask(r);
    const seen: (string | undefined)[] = [];
    const execute = (_adapter: AgentAdapter, req: AgentRequest): AgentTurnResult => {
      seen.push(req.sessionId);
      return { provider: "codex", success: true, sessionId: req.sessionId ?? "thread-1", response: "VERDICT: APPROVED", rawStdout: "", rawStderr: "", exitCode: 0 };
    };
    const adapters = { codex: new FakeAdapter("codex"), antigravity: new FakeAdapter("antigravity") };
    dispatchReview(r, "review", [{ provider: "codex", model: "m" }], adapters, "req-1", execute);
    dispatchReview(r, "recheck", [{ provider: "codex", model: "m" }], adapters, "req-2", execute);
    assert.deepEqual(seen, [undefined, "thread-1"]);
    assert.equal(findSession(loadSessionRegistry(r), "t1", "codex", "m", "reviewer")?.sessionId, "thread-1");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("review fallback occurs only after qualifying provider failure", () => {
  const r = root();
  try {
    reviewTask(r);
    const calls: string[] = [];
    const execute = (adapter: AgentAdapter): AgentTurnResult => {
      calls.push(adapter.provider);
      if (adapter.provider === "codex") return { provider: "codex", success: false, response: "", rawStdout: "", rawStderr: "quota exceeded", exitCode: 1, failureCode: "QUOTA_EXHAUSTED" };
      return { provider: "antigravity", success: true, sessionId: "conv-2", response: "VERDICT: APPROVED", rawStdout: "", rawStderr: "", exitCode: 0 };
    };
    const result = dispatchReview(r, "review", [{ provider: "codex", model: "a" }, { provider: "antigravity", model: "b" }], { codex: new FakeAdapter("codex"), antigravity: new FakeAdapter("antigravity") }, "req", execute);
    assert.deepEqual(calls, ["codex", "antigravity"]);
    assert.equal(result.reviewer.provider, "antigravity");
    const registry = loadSessionRegistry(r);
    assert.equal(registry.tasks[0].fallbackHistory?.[0].reasonCode, "QUOTA_EXHAUSTED");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("developer dispatcher captures and resumes Antigravity session", () => {
  const r = root();
  try {
    let task = createTask("t1", "Task", "LIGHT", "small");
    task = transitionTask(task, "READY_FOR_DEV");
    task = transitionTask(task, "IN_PROGRESS");
    saveActiveTask(r, task);
    const seen: (string | undefined)[] = [];
    const execute = (_adapter: AgentAdapter, req: AgentRequest): AgentTurnResult => {
      seen.push(req.sessionId);
      return { provider: "antigravity", success: true, sessionId: req.sessionId ?? "conv-dev", response: "done", rawStdout: "", rawStderr: "", exitCode: 0 };
    };
    const adapter = new FakeAdapter("antigravity");
    dispatchDeveloper(r, "do it", "antigravity", "model", adapter, "d1", execute);
    dispatchDeveloper(r, "continue", "antigravity", "model", adapter, "d2", execute);
    assert.deepEqual(seen, [undefined, "conv-dev"]);
  } finally { rmSync(r, { recursive: true, force: true }); }
});
