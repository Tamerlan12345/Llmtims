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
import {
  detectMediaIntent,
  isContentCreatorContext,
  sanitizeVisibleAgentResponse,
} from "../src/lib/agents/prompts.ts";

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

const roleDescriptions = {
  PM: "planning, roadmap, priorities, backlog",
  Developer: "code implementation api services bug fixes",
  QA: "testing regression verification test-cases",
  DevOps: "deployment ci cd logs infrastructure railway",
};

assert.equal(
  await pickResponderRole(
    "Can you deploy latest build?",
    "PM",
    ["PM", "Developer", "QA", "DevOps"],
    {},
    { roleDescriptions }
  ),
  "DevOps"
);
assert.equal(
  await pickResponderRole(
    "Need regression test coverage",
    "PM",
    ["PM", "Developer", "QA", "DevOps"],
    {},
    { roleDescriptions }
  ),
  "QA"
);
assert.equal(
  await pickResponderRole(
    "Please refactor API handler",
    "PM",
    ["PM", "Developer", "QA", "DevOps"],
    {},
    { roleDescriptions }
  ),
  "Developer"
);
assert.equal(
  await pickResponderRole(
    "Define sprint priorities",
    "PM",
    ["PM", "Developer", "QA", "DevOps"],
    {},
    { roleDescriptions }
  ),
  "PM"
);

const directIntent = await routeChatIntent("@qa проверь регрессию по чату", "Auto", {
  availableRoles: ["PM", "Developer", "QA", "DevOps"],
  coordinatorRole: "PM",
  roleDescriptions,
});
assert.equal(directIntent.responderRole, "QA");
assert.equal(directIntent.coordinatorRole, "PM");
assert.equal(directIntent.targetRole, "QA");

const broadcastIntent = await routeChatIntent(
  "Команде: подготовьте план релиза",
  "All",
  {
    availableRoles: ["PM", "Developer", "QA", "DevOps"],
    coordinatorRole: "PM",
    roleDescriptions,
  }
);
assert.equal(broadcastIntent.broadcast, true);
assert.equal(broadcastIntent.targetRole, "All");

assert.equal(detectMediaIntent("Сделай картинку и покажи ее"), true);
assert.equal(detectMediaIntent("Подготовь пост под Наурыз"), false);

assert.equal(
  isContentCreatorContext({
    role: "SMM",
    name: "Аня",
    roleMarkdown: "Контент и social media",
    metadata: { focus: "marketing" },
  }),
  true
);
assert.equal(
  isContentCreatorContext({
    role: "Developer",
    name: "Алексей",
    roleMarkdown: "Backend implementation",
    metadata: { focus: "api" },
  }),
  false
);

assert.equal(
  sanitizeVisibleAgentResponse(
    [
      "Создаю пост для социальных сетей.",
      "",
      "**Пост:**",
      "Текст поста",
      "",
      "```tool_code",
      '{"skill":"image_generator"}',
      "```",
    ].join("\n"),
    { strictContentContract: true }
  ),
  ["**Пост:**", "Текст поста"].join("\n")
);

console.log("Office engine tests passed.");
