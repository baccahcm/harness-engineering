import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../../src/installer/install.js";
import { runStreamingCommand } from "../../src/runtime/process-runner.js";
import { loadRuntimeRegistry, reconcileRuntimeProcesses, registerRuntimeProcess } from "../../src/runtime/process-registry.js";
import { createTask } from "../../src/core/task.js";
import { archiveActiveTask, loadActiveTask, loadTaskHistory, saveActiveTask } from "../../src/core/store.js";
import { transitionTask } from "../../src/core/state-machine.js";
import { registerSession, loadSessionRegistry, markInFlight, markUncertain, resolveSessionState } from "../../src/agents/session-registry.js";
import { CodexAdapter } from "../../src/agents/codex.js";
import { adapterCapability } from "../../src/agents/capabilities.js";

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harness-v05-"));
  initProject(value);
  return value;
}

test("streaming runner captures stdout/stderr and terminal runtime state", async () => {
  const r = root();
  try {
    const result = await runStreamingCommand(r, { executable: "node", args: ["-e", "console.log('hello'); console.error('warn')"], cwd: r }, { requestId: "stream-1" }, { timeoutMs: 5000 });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("hello"));
    assert.ok(result.stderr.includes("warn"));
    assert.ok(readFileSync(result.stdoutPath, "utf8").includes("hello"));
    assert.equal(loadRuntimeRegistry(r).processes.find((item) => item.requestId === "stream-1")?.status, "completed");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("streaming runner times out and records timed_out terminal state", async () => {
  const r = root();
  try {
    const result = await runStreamingCommand(r, { executable: "node", args: ["-e", "setTimeout(() => {}, 5000)"], cwd: r }, { requestId: "timeout-1" }, { timeoutMs: 50, terminateGraceMs: 20 });
    assert.equal(result.timedOut, true);
    assert.equal(loadRuntimeRegistry(r).processes.find((item) => item.requestId === "timeout-1")?.status, "timed_out");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("reconcile marks vanished running process uncertain instead of clearing it", () => {
  const r = root();
  try {
    registerRuntimeProcess(r, { requestId: "lost-1", pid: 99999999, executable: "fake", cwd: r, stdoutPath: "out", stderrPath: "err", taskId: "t1" });
    const records = reconcileRuntimeProcesses(r);
    assert.equal(records.find((item) => item.requestId === "lost-1")?.status, "uncertain");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("uncertain session requires explicit resolution before reuse", () => {
  const r = root();
  try {
    const registry = loadSessionRegistry(r);
    const session = registerSession(registry, "t1", { provider: "antigravity", purpose: "developer", model: "m", sessionId: "s1", workspace: r });
    markInFlight(session, "req-1");
    markUncertain(session);
    assert.throws(() => markInFlight(session, "req-2"), (err: any) => err?.code === "SESSION_UNCERTAIN");
    resolveSessionState(session, "idle");
    markInFlight(session, "req-3");
    assert.equal(session.status, "in_flight");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("completed task can be archived and active task slot becomes free", () => {
  const r = root();
  try {
    let task = createTask("done-task", "Done", "NONE", "docs");
    task = transitionTask(task, "READY_FOR_DEV");
    task = transitionTask(task, "IN_PROGRESS");
    task = transitionTask(task, "COMPLETED");
    saveActiveTask(r, task);
    const entry = archiveActiveTask(r, "2026-10-27T00:00:00.000Z");
    assert.equal(entry.taskId, "done-task");
    assert.equal(loadActiveTask(r), null);
    assert.equal(loadTaskHistory(r).tasks.length, 1);
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("adapter capability metadata exposes supported roles before dispatch", () => {
  const adapter = new CodexAdapter("definitely-not-installed-codex");
  const capability = adapterCapability(adapter);
  assert.deepEqual(capability.purposes, ["reviewer", "planner"]);
  assert.equal(capability.modelValidation, "runtime");
});

test("external cancellation request terminates a tracked streaming process", async () => {
  const { requestRuntimeCancellation } = await import("../../src/runtime/process-registry.js");
  const r = root();
  try {
    const running = runStreamingCommand(r, { executable: "node", args: ["-e", "setTimeout(() => {}, 5000)"], cwd: r }, { requestId: "cancel-1" }, { timeoutMs: 5000, terminateGraceMs: 20 });
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 60));
    requestRuntimeCancellation(r, "cancel-1");
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.equal(loadRuntimeRegistry(r).processes.find((item) => item.requestId === "cancel-1")?.status, "cancelled");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("uncertain runtime requires explicit resolution", async () => {
  const { resolveRuntimeProcess } = await import("../../src/runtime/process-registry.js");
  const r = root();
  try {
    registerRuntimeProcess(r, { requestId: "lost-2", pid: 99999998, executable: "fake", cwd: r, stdoutPath: "out", stderrPath: "err", taskId: "t1" });
    reconcileRuntimeProcesses(r);
    const resolved = resolveRuntimeProcess(r, "lost-2", "failed");
    assert.equal(resolved.status, "failed");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("beginActiveTask refuses overwrite until predecessor is completed", async () => {
  const { beginActiveTask } = await import("../../src/core/store.js");
  const r = root();
  try {
    saveActiveTask(r, createTask("active-one", "Active", "NONE", "docs"));
    assert.throws(() => beginActiveTask(r, createTask("active-two", "Other", "NONE", "docs")), (err: any) => err?.code === "ACTIVE_TASK_EXISTS");
  } finally { rmSync(r, { recursive: true, force: true }); }
});
