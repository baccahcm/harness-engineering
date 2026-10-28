import test from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter } from "../../src/agents/codex.js";
import { AntigravityAdapter } from "../../src/agents/antigravity.js";

const workspace = "/repo";

test("Codex reviewer command is exact-session and read-only", () => {
  const adapter = new CodexAdapter("codex-test");
  const spec = adapter.buildCommand({ workspace, prompt: "review", model: "model-x", purpose: "reviewer", sessionId: "thread-123" });
  assert.equal(spec.executable, "codex-test");
  assert.ok(spec.args.includes("read-only"));
  assert.ok(spec.args.includes("never"));
  assert.ok(spec.args.includes("thread-123"));
  assert.equal(spec.args.includes("--last"), false);
});

test("Codex JSONL parser captures thread id and final agent response", () => {
  const adapter = new CodexAdapter();
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-abc" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "1", type: "agent_message", text: "VERDICT: APPROVED" } }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n");
  const result = adapter.parseResult(stdout, "", 0);
  assert.equal(result.success, true);
  assert.equal(result.sessionId, "thread-abc");
  assert.equal(result.response, "VERDICT: APPROVED");
});

test("Antigravity headless parser captures conversation id", () => {
  const adapter = new AntigravityAdapter();
  const result = adapter.parseResult(JSON.stringify({ conversation_id: "conv-1", status: "SUCCESS", response: "done" }), "", 0);
  assert.equal(result.success, true);
  assert.equal(result.sessionId, "conv-1");
  assert.equal(result.response, "done");
});

test("Antigravity developer resumes exact conversation without --continue", () => {
  const adapter = new AntigravityAdapter("agy-test");
  const spec = adapter.buildCommand({ workspace, prompt: "implement", model: "model-y", purpose: "developer", sessionId: "conv-7" });
  assert.ok(spec.args.includes("--conversation"));
  assert.ok(spec.args.includes("conv-7"));
  assert.ok(spec.args.includes("accept-edits"));
  assert.equal(spec.args.includes("--continue"), false);
  assert.equal(spec.args.includes("-c"), false);
});

test("provider failure parser classifies fallback-worthy errors", () => {
  const adapter = new AntigravityAdapter();
  const result = adapter.parseResult(JSON.stringify({ conversation_id: "", status: "ERROR", response: "", error: "model foo is not recognized" }), "", 1);
  assert.equal(result.success, false);
  assert.equal(result.failureCode, "MODEL_UNAVAILABLE");
});

import { ClaudeAdapter } from "../../src/agents/claude.js";

test("Claude reviewer command uses JSON print mode, plan permissions and exact session resume", () => {
  const adapter = new ClaudeAdapter("claude");
  const fresh = adapter.buildCommand({ workspace: "/repo", prompt: "review", model: "opus", purpose: "reviewer" });
  assert.equal(fresh.executable, "claude");
  assert.ok(fresh.args.includes("-p"));
  assert.deepEqual(fresh.args.slice(fresh.args.indexOf("--output-format"), fresh.args.indexOf("--output-format") + 2), ["--output-format", "json"]);
  assert.ok(fresh.args.includes("--permission-mode"));
  assert.ok(fresh.args.includes("plan"));
  assert.equal(fresh.args.includes("--continue"), false);
  const resumed = adapter.buildCommand({ workspace: "/repo", prompt: "recheck", model: "opus", purpose: "reviewer", sessionId: "claude-session-1" });
  const idx = resumed.args.indexOf("--resume");
  assert.ok(idx >= 0);
  assert.equal(resumed.args[idx + 1], "claude-session-1");
});

test("Claude JSON parser captures session id, result and optional usage", () => {
  const adapter = new ClaudeAdapter("claude");
  const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "approved", session_id: "claude-abc", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60 } });
  const parsed = adapter.parseResult(stdout, "", 0);
  assert.equal(parsed.success, true);
  assert.equal(parsed.sessionId, "claude-abc");
  assert.equal(parsed.response, "approved");
  assert.equal(parsed.usage?.inputTokens, 100);
  assert.equal(parsed.usage?.cachedInputTokens, 60);
});

test("Codex planner command is read-only and does not require reviewer purpose", () => {
  const adapter = new CodexAdapter("codex-test");
  const spec = adapter.buildCommand({ workspace, prompt: "analyze plan", model: "model-x", purpose: "planner" });
  assert.ok(spec.args.includes("read-only"));
  assert.ok(spec.args.includes("never"));
  assert.equal(adapter.supportsPurpose?.("planner"), true);
});

test("Claude and Antigravity planner commands use plan/read-only modes", () => {
  const claude = new ClaudeAdapter("claude-test");
  const claudeSpec = claude.buildCommand({ workspace, prompt: "analyze plan", model: "opus", purpose: "planner" });
  assert.ok(claudeSpec.args.includes("--permission-mode"));
  assert.ok(claudeSpec.args.includes("plan"));
  const ag = new AntigravityAdapter("agy-test");
  const agSpec = ag.buildCommand({ workspace, prompt: "analyze plan", model: "gemini-x", purpose: "planner" });
  assert.ok(agSpec.args.includes("--mode"));
  assert.ok(agSpec.args.includes("plan"));
  assert.equal(agSpec.args.includes("accept-edits"), false);
});
