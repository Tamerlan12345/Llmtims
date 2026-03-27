import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveZoneByRole,
  resolveTargetPoint,
  resolveActivityLabel,
  resolveAgentMode,
  rotateActiveAgent,
  rotateMockTaskStatus,
} from "./engine";

test("resolveZoneByRole maps supported roles to desk zones", () => {
  assert.equal(resolveZoneByRole("PM"), "planning");
  assert.equal(resolveZoneByRole("Developer"), "coding");
  assert.equal(resolveZoneByRole("QA"), "testing");
  assert.equal(resolveZoneByRole("DevOps"), "cloud");
});

test("resolveTargetPoint sends completed agents to lounge", () => {
  const point = resolveTargetPoint("Developer", true, 4, "done");
  assert.equal(point.x, "52%");
  assert.equal(point.y, "72%");
});

test("resolveAgentMode reflects task state", () => {
  assert.equal(resolveAgentMode("Developer", true, "pending"), "walking");
  assert.equal(resolveAgentMode("Developer", true, "in_progress"), "typing");
  assert.equal(resolveAgentMode("QA", true, "review"), "testing");
  assert.equal(resolveAgentMode("PM", false, "in_progress"), "watching_tv");
  assert.equal(resolveAgentMode("PM", true, "failed"), "debugging");
});

test("resolveActivityLabel maps mode to human text", () => {
  assert.equal(resolveActivityLabel("QA", "testing"), "Running test suite");
  assert.equal(resolveActivityLabel("DevOps", "watching_tv"), "In lounge watching TV");
});

test("rotateActiveAgent cycles activity to next person", () => {
  const input = [
    { id: "a", is_active: true },
    { id: "b", is_active: false },
    { id: "c", is_active: false },
  ];

  const output = rotateActiveAgent(input);
  assert.deepEqual(output.map((agent) => agent.is_active), [false, true, false]);
});

test("rotateMockTaskStatus cycles through mock workflow", () => {
  assert.equal(rotateMockTaskStatus("pending"), "in_progress");
  assert.equal(rotateMockTaskStatus("in_progress"), "review");
  assert.equal(rotateMockTaskStatus("review"), "done");
  assert.equal(rotateMockTaskStatus("done"), "failed");
  assert.equal(rotateMockTaskStatus("failed"), "pending");
});
