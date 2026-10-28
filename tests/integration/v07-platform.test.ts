import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject, upgradeProject } from "../../src/installer/install.js";
import { loadConfig, saveConfig } from "../../src/core/config.js";
import { migrationMatrix, migrationPlan } from "../../src/migrations/index.js";
import { emitHarnessEvent, loadHarnessEvents } from "../../src/events/bus.js";
import { parseAntigravityModels, AntigravityAdapter } from "../../src/agents/antigravity.js";
import { CodexAdapter } from "../../src/agents/codex.js";
import { adapterCapability, assertAdapterReady } from "../../src/agents/capabilities.js";
import { catalogModelStatus, probeModelCatalog } from "../../src/agents/model-catalog.js";
import type { AgentAdapter } from "../../src/agents/types.js";
import { buildProvenance, generateReleaseArtifacts, signReleaseArtifacts, verifyReleaseArtifacts } from "../../src/release/provenance.js";

function root(prefix = "harness-v07-"): string {
  const r = mkdtempSync(join(tmpdir(), prefix));
  initProject(r);
  return r;
}

test("Antigravity model parser extracts exact provider model slugs while Codex remains runtime-only", () => {
  const models = parseAntigravityModels(`Available models:\n- gemini-4-argon-high  Gemini 4 Argon High\n* claude-opus-5-5-medium\n  gpt-oss-120b-medium   Experimental\n`);
  assert.deepEqual(models, ["gemini-4-argon-high", "claude-opus-5-5-medium", "gpt-oss-120b-medium"]);
  const codex = adapterCapability(new CodexAdapter("codex"));
  assert.equal(codex.modelValidation, "runtime");
  assert.equal(codex.catalogProbe, "unsupported");
});

test("model catalog cache validates only an actually probed catalog", () => {
  const r = root();
  try {
    const adapter = {
      provider: "antigravity",
      executable: "agy",
      detect: () => ({ provider: "antigravity", executable: "agy", available: true }),
      probeModels: () => ({ schemaVersion: 1, provider: "antigravity", status: "available", models: ["m1", "m2"], source: "provider-cli", machineReadable: false, probedAt: new Date().toISOString() }),
      buildCommand: () => ({ executable: "agy", args: [], cwd: r }),
      parseResult: () => { throw new Error("unused"); },
    } as AgentAdapter;
    const catalog = probeModelCatalog(r, adapter, true, 0);
    assert.equal(catalogModelStatus(catalog, "m1"), "valid");
    assert.equal(catalogModelStatus(catalog, "missing"), "invalid");
    assert.throws(() => assertAdapterReady(adapter, "developer", "missing", r), (err: any) => err?.code === "MODEL_NOT_IN_CATALOG");
    assert.doesNotThrow(() => assertAdapterReady(adapter, "developer", "m1", r));
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("event bus retains sanitized structured metadata and trims old entries", () => {
  const r = root();
  try {
    emitHarnessEvent(r, "run.started", { phase: "DEVELOP", note: "x".repeat(900) }, { taskId: "t", retainEntries: 2, at: "2026-01-01T00:00:00Z" });
    emitHarnessEvent(r, "run.phase", { phase: "VERIFY" }, { taskId: "t", retainEntries: 2, at: "2026-01-01T00:00:01Z" });
    emitHarnessEvent(r, "run.completed", { status: "COMPLETED" }, { taskId: "t", retainEntries: 2, at: "2026-01-01T00:00:02Z" });
    const events = loadHarnessEvents(r, 10);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "run.phase");
    assert.equal(events[1].type, "run.completed");
  } finally { rmSync(r, { recursive: true, force: true }); }
});

test("migration matrix covers every historical V0.1-V0.6 baseline", () => {
  const matrix = migrationMatrix();
  assert.ok(matrix.length >= 6);
  assert.ok(matrix.every((row) => row.to === "0.8.3"));
  assert.ok(migrationPlan("0.1.0", "0.8.3").some((step) => step.id === "M070-operator"));
});

test("upgrade from each historical version preserves V0.7 defaults while reaching current config", () => {
  for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0"]) {
    const r = root(`harness-migrate-${version}-`);
    try {
      const cfg = loadConfig(r);
      cfg.harness.version = version;
      delete cfg.events;
      delete cfg.catalog;
      if (version === "0.1.0") delete cfg.agents;
      if (["0.1.0", "0.2.0"].includes(version)) delete cfg.orchestration;
      if (["0.1.0", "0.2.0", "0.3.0", "0.4.0"].includes(version)) delete cfg.runtime;
      if (version !== "0.6.0") delete cfg.context;
      saveConfig(r, cfg);
      upgradeProject(r, "0.8.3");
      const next = loadConfig(r);
      assert.equal(next.harness.version, "0.8.3");
      assert.equal(next.events?.retainEntries, 5000);
      assert.equal(next.catalog?.cacheTtlMs, 300000);
      assert.equal(next.runtime?.agentTimeoutMs, 900000);
      assert.equal(next.context?.compactionThresholdEstimatedTokens, 60000);
    } finally { rmSync(r, { recursive: true, force: true }); }
  }
});

test("release provenance source digest is deterministic and signature verifies", () => {
  const r = mkdtempSync(join(tmpdir(), "harness-release-"));
  try {
    mkdirSync(join(r, "src"), { recursive: true });
    writeFileSync(join(r, "src", "index.ts"), "export const x = 1;\n");
    writeFileSync(join(r, "package.json"), JSON.stringify({ name: "release-test", version: "1.2.3" }, null, 2));
    writeFileSync(join(r, "tsconfig.json"), "{}\n");
    writeFileSync(join(r, "README.md"), "# release test\n");
    writeFileSync(join(r, "HANDOFF.md"), "handoff\n");
    const a = buildProvenance(r, "2026-01-01T00:00:00Z");
    const b = buildProvenance(r, "2026-01-02T00:00:00Z");
    assert.equal(a.sourceDigest, b.sourceDigest);
    generateReleaseArtifacts(r, "2026-01-01T00:00:00Z");
    assert.equal(verifyReleaseArtifacts(r).valid, true);
    const pair = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const keyPath = join(r, "release-key.pem");
    writeFileSync(keyPath, pair.privateKey);
    signReleaseArtifacts(r, keyPath, "2026-01-01T00:00:01Z");
    const verified = verifyReleaseArtifacts(r);
    assert.equal(verified.valid, true);
    assert.equal(verified.signatureValid, true);
    assert.ok(readFileSync(join(r, "release", "sbom.spdx.json"), "utf8").includes("SPDX-2.3"));
  } finally { rmSync(r, { recursive: true, force: true }); }
});
