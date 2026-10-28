import test from "node:test";
import assert from "node:assert/strict";
import { normalizeScope, pathInScope } from "../../src/core/scope.js";

test("checkpoint scope supports recursive include and exclude patterns", () => {
  const scope = normalizeScope({ include: ["src/auth/**", "tests/auth/*.test.ts"], exclude: ["src/auth/generated/**"] });
  assert.equal(pathInScope("src/auth/login.ts", scope), true);
  assert.equal(pathInScope("src/auth/deep/token.ts", scope), true);
  assert.equal(pathInScope("src/auth/generated/client.ts", scope), false);
  assert.equal(pathInScope("tests/auth/login.test.ts", scope), true);
  assert.equal(pathInScope("tests/auth/deep/login.test.ts", scope), false);
  assert.equal(pathInScope("src/payments/pay.ts", scope), false);
});

test("checkpoint scope rejects repository escape and harness runtime ownership", () => {
  assert.throws(() => normalizeScope({ include: ["../secret"] }), /SCOPE_INVALID|repository/);
  assert.throws(() => normalizeScope({ include: [".harness/**"] }), /SCOPE_INVALID|Harness runtime/);
});
