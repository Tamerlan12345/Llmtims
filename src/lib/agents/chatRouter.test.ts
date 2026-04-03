import test from "node:test";
import assert from "node:assert/strict";
import { pickResponderRole, routeChatIntent } from "./chatRouter";

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

test("routeChatIntent prioritizes explicit russian mention", async () => {
  const intent = await routeChatIntent("Аня, сделай пост для соцсетей", "PM", {
    availableRoles: ["PM", "Аня", "Ванька"],
    rosterLabels: {
      PM: "Павел",
      "Аня": "Аня СММ",
      "Ванька": "Ванька Dev",
    },
    roleDescriptions,
  });

  assert.equal(intent.responderRole, "Аня");
  assert.equal(intent.targetRole, "Аня");
  assert.equal(intent.routingSource, "explicit_mention");
  assert.equal(intent.is_actionable_task, true);
});

test("routeChatIntent marks mixed greeting and task as actionable", async () => {
  const intent = await routeChatIntent("Привет, команда! Нужно сделать пост для соцсетей", "PM", {
    availableRoles: ["PM", "Developer", "QA", "DevOps"],
    rosterLabels: {
      PM: "Павел",
      Developer: "Ванька",
      QA: "Аня",
      DevOps: "Илья",
    },
    roleDescriptions,
  });

  assert.equal(intent.is_actionable_task, true);
});

test("routeChatIntent does not create actionable intent for small talk", async () => {
  const intent = await routeChatIntent("Как дела?", "PM", {
    availableRoles: ["PM", "Developer", "QA", "DevOps"],
    rosterLabels: {
      PM: "Павел",
      Developer: "Ванька",
      QA: "Аня",
      DevOps: "Илья",
    },
    roleDescriptions,
  });

  assert.equal(intent.is_actionable_task, false);
});
