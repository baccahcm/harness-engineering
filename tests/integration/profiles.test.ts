import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../../src/installer/install.js";
import { loadConfig, setDeveloperProfile, upsertReviewerProfile } from "../../src/core/config.js";

test("provider/model profiles persist in project config", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-profile-"));
  try {
    initProject(root);
    setDeveloperProfile(root, { provider: "antigravity", model: "dev-model" });
    upsertReviewerProfile(root, { name: "primary", provider: "codex", model: "review-model" });
    upsertReviewerProfile(root, { name: "fallback", provider: "antigravity", model: "fallback-model" });
    const config = loadConfig(root);
    assert.equal(config.agents?.developer?.model, "dev-model");
    assert.equal(config.agents?.reviewers?.length, 2);
    assert.equal(config.agents?.reviewers?.[0].name, "primary");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
