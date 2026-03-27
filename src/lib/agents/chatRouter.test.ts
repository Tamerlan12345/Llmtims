import test from "node:test";
import assert from "node:assert/strict";
import { pickResponderRole } from "./chatRouter";

test("pickResponderRole resolves technical requests to Developer", () => {
  assert.equal(pickResponderRole("Please fix API bug and refactor service"), "Developer");
});

test("pickResponderRole resolves infra requests to DevOps", () => {
  assert.equal(pickResponderRole("Need deploy logs from CI"), "DevOps");
});

test("pickResponderRole resolves QA requests", () => {
  assert.equal(pickResponderRole("Run regression test and validate edge case"), "QA");
});
