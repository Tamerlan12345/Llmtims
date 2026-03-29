import assert from "node:assert/strict";
import {
  resolveZoneByRole,
  resolveTargetPoint,
  resolveActivityLabel,
  resolveAgentMode,
  rotateActiveAgent,
  rotateMockTaskStatus,
  roleLabelRu,
} from "../src/lib/office/engine.ts";
import { pickResponderRole, routeChatIntent } from "../src/lib/agents/chatRouter.ts";

assert.equal(resolveZoneByRole("PM"), "planning");
assert.equal(resolveZoneByRole("Developer"), "coding");
assert.equal(resolveZoneByRole("QA"), "testing");
assert.equal(resolveZoneByRole("DevOps"), "cloud");

const loungePoint = resolveTargetPoint("Developer", true, 4, "done");
assert.equal(loungePoint.x, "54%");
assert.equal(loungePoint.y, "72%");

assert.equal(resolveAgentMode("Developer", true, "pending"), "walking");
assert.equal(resolveAgentMode("Developer", true, "in_progress"), "typing");
assert.equal(resolveAgentMode("QA", true, "review"), "testing");
assert.equal(resolveAgentMode("PM", false, "in_progress"), "watching_tv");
assert.equal(resolveAgentMode("PM", true, "failed"), "debugging");

assert.equal(resolveActivityLabel("QA", "testing"), "Прогоняет тесты");
assert.equal(resolveActivityLabel("DevOps", "watching_tv"), "Гуляет по офису");
assert.equal(roleLabelRu("Developer"), "Разработчик");

const rotated = rotateActiveAgent([
  { id: "a", is_active: true },
  { id: "b", is_active: false },
  { id: "c", is_active: false },
]);
assert.deepEqual(
  rotated.map((agent) => agent.is_active),
  [false, true, false]
);

assert.equal(rotateMockTaskStatus("pending"), "in_progress");
assert.equal(rotateMockTaskStatus("in_progress"), "review");
assert.equal(rotateMockTaskStatus("review"), "done");
assert.equal(rotateMockTaskStatus("done"), "failed");
assert.equal(rotateMockTaskStatus("failed"), "pending");

assert.equal(pickResponderRole("Can you deploy latest build?"), "DevOps");
assert.equal(pickResponderRole("Need regression test coverage"), "QA");
assert.equal(pickResponderRole("Please refactor API handler"), "Developer");
assert.equal(pickResponderRole("Define sprint priorities"), "PM");

const directIntent = routeChatIntent("@qa проверь регрессию по чату", "Auto");
assert.equal(directIntent.responderRole, "QA");
assert.equal(directIntent.coordinatorRole, "PM");
assert.equal(directIntent.targetRole, "QA");

const broadcastIntent = routeChatIntent("Команде: подготовьте план релиза", "All");
assert.equal(broadcastIntent.broadcast, true);
assert.equal(broadcastIntent.targetRole, "All");

console.log("Office engine tests passed.");
