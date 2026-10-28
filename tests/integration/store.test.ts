import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTask } from "../../src/core/task.js";
import { saveActiveTask, loadActiveTask } from "../../src/core/store.js";

test("task YAML store preserves empty collections and review state", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-store-"));
  try {
    const task = createTask("demo", "Demo", "FULL", "unclear risk");
    saveActiveTask(root, task);
    const loaded = loadActiveTask(root);
    assert.deepEqual(loaded, task);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
