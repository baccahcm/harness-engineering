import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizePlanTasks, parsePlannerAnalysis } from "../../src/plans/result.js";

const valid = {
  title: "Feature plan",
  summary: "Two-step implementation",
  tasks: [
    { id: "db", title: "Database", objective: "Add schema", reviewLevel: "FULL", reviewReason: "schema migration", acceptance: [{ id: "A1", description: "Schema exists" }], checkpoints: [{ id: "C1", scope: { include: ["db/**"] } }], dependsOn: [], verificationKeys: [] },
    { id: "api", title: "API", objective: "Expose API", reviewLevel: "LIGHT", reviewReason: "isolated behavior", acceptance: [{ id: "A1", description: "API responds" }], checkpoints: [], dependsOn: ["db"], verificationKeys: [] },
  ],
};

test("planner result parses JSON and canonicalizes dependency order", () => {
  const parsed = parsePlannerAnalysis(`\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
  const tasks = canonicalizePlanTasks(parsed);
  assert.deepEqual(tasks.map((task) => task.id), ["db", "api"]);
  assert.equal(tasks[0].executionOrder, 0);
  assert.equal(tasks[1].status, "PENDING");
});

test("plan canonicalizer rejects dependency cycles", () => {
  const cycle = structuredClone(valid);
  cycle.tasks[0].dependsOn = ["api"];
  assert.throws(() => canonicalizePlanTasks(parsePlannerAnalysis(JSON.stringify(cycle))), (err: any) => err?.code === "PLAN_DEPENDENCY_CYCLE");
});

test("FULL planner task requires scoped checkpoint", () => {
  const bad = structuredClone(valid);
  bad.tasks[0].checkpoints = [];
  assert.throws(() => parsePlannerAnalysis(JSON.stringify(bad)), (err: any) => err?.code === "PLAN_ANALYSIS_INVALID");
});
