import test from "node:test";
import assert from "node:assert/strict";
import { parseYaml, stringifyYaml } from "../../src/util/yaml.js";

test("YAML subset round trips harness-shaped data", () => {
  const value = { a: 1, b: true, nested: { name: "hello world", arr: [{ id: "C1", verdict: "PENDING" }, { id: "C2", verdict: "APPROVED" }] } };
  const encoded = stringifyYaml(value);
  assert.deepEqual(parseYaml(encoded), value);
});

test("YAML subset preserves empty arrays and objects", () => {
  const value = { acceptance: [], checkpoints: [], metadata: {} };
  assert.deepEqual(parseYaml(stringifyYaml(value)), value);
});

test("YAML subset omits undefined optional fields", () => {
  const value = { keep: "yes", optional: undefined } as unknown as any;
  const rendered = stringifyYaml(value);
  assert.ok(rendered.includes("keep: yes"));
  assert.equal(rendered.includes("optional"), false);
});
