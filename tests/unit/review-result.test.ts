import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredReviewResult } from "../../src/review/result.js";

test("structured review parser accepts fenced JSON", () => {
  const result = parseStructuredReviewResult('```json\n{"schemaVersion":1,"verdict":"APPROVED","summary":"good","findings":[],"evidence":["inspected diff"],"notChecked":["production"]}\n```');
  assert.equal(result.verdict, "APPROVED");
  assert.equal(result.evidence[0], "inspected diff");
});

test("APPROVED without evidence is rejected", () => {
  assert.throws(() => parseStructuredReviewResult('{"schemaVersion":1,"verdict":"APPROVED","summary":"good","findings":[],"evidence":[],"notChecked":[]}'), (err: any) => err?.code === "MISSING_EVIDENCE");
});

test("REVISE requires a concrete finding", () => {
  assert.throws(() => parseStructuredReviewResult('{"schemaVersion":1,"verdict":"REVISE","summary":"fix","findings":[],"evidence":["diff"],"notChecked":[]}'), (err: any) => err?.code === "REVIEW_RESULT_INCONSISTENT");
});

test("APPROVED cannot hide high severity findings", () => {
  assert.throws(() => parseStructuredReviewResult('{"schemaVersion":1,"verdict":"APPROVED","summary":"good","findings":[{"id":"F1","severity":"high","description":"bug"}],"evidence":["diff"],"notChecked":[]}'), (err: any) => err?.code === "REVIEW_RESULT_INCONSISTENT");
});
