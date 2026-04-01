import test from "node:test";
import assert from "node:assert/strict";
import { pickResponderRole } from "./chatRouter";

const roleDescriptions = {
  PM: "planning, roadmap, priorities, backlog",
  Developer: "code implementation api services bug fixes",
  QA: "testing regression verification test-cases",
  DevOps: "deployment ci cd logs infrastructure railway",
};

test("pickResponderRole resolves technical requests to Developer", async () => {
  assert.equal(
    await pickResponderRole(
      "Please fix API bug and refactor service",
      "PM",
      ["PM", "Developer", "QA", "DevOps"],
      {},
      { roleDescriptions }
    ),
    "Developer"
  );
});

test("pickResponderRole resolves infra requests to DevOps", async () => {
  assert.equal(
    await pickResponderRole(
      "Need deploy logs from CI",
      "PM",
      ["PM", "Developer", "QA", "DevOps"],
      {},
      { roleDescriptions }
    ),
    "DevOps"
  );
});

test("pickResponderRole resolves QA requests", async () => {
  assert.equal(
    await pickResponderRole(
      "Run regression test and validate edge case",
      "PM",
      ["PM", "Developer", "QA", "DevOps"],
      {},
      { roleDescriptions }
    ),
    "QA"
  );
});
