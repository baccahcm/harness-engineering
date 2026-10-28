import test from "node:test";
import assert from "node:assert/strict";
import { classifyReviewLevel } from "../../src/core/classify.js";

test("risk classifier defaults conservatively", () => {
  assert.equal(classifyReviewLevel("fix typo in README").level, "NONE");
  assert.equal(classifyReviewLevel("small isolated button loading behavior").level, "LIGHT");
  assert.equal(classifyReviewLevel("change behavior").level, "FULL");
  assert.equal(classifyReviewLevel("change tenant permission check").level, "FULL");
  assert.equal(classifyReviewLevel("database migration for invoices").level, "FULL");
});
