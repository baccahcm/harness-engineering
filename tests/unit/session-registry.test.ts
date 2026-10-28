import test from "node:test";
import assert from "node:assert/strict";
import { findSession, markInFlight, markTerminal, registerSession } from "../../src/agents/session-registry.js";
import type { SessionRegistry } from "../../src/agents/types.js";

function registry(): SessionRegistry { return { schemaVersion: 1, tasks: [] }; }

test("session registry refuses silent replacement", () => {
  const r = registry();
  registerSession(r, "task", { provider: "codex", purpose: "reviewer", model: "m", sessionId: "one", workspace: "/repo" }, "2026-01-01T00:00:00Z");
  assert.throws(() => registerSession(r, "task", { provider: "codex", purpose: "reviewer", model: "m", sessionId: "two", workspace: "/repo" }), (err: any) => err?.code === "SESSION_ID_CONFLICT");
});

test("session cannot be dispatched twice while in flight", () => {
  const r = registry();
  const s = registerSession(r, "task", { provider: "codex", purpose: "reviewer", model: "m", sessionId: "one", workspace: "/repo" });
  markInFlight(s, "req-1");
  assert.throws(() => markInFlight(s, "req-2"), (err: any) => err?.code === "SESSION_BUSY");
  markTerminal(s, true);
  assert.equal(findSession(r, "task", "codex", "m", "reviewer")?.status, "idle");
});
