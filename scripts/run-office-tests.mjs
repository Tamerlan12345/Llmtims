import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import {
  buildDefaultSwarmConfig,
  detectWorkerTriggers,
  scoreMemoryPattern,
  normalizeMemoryNamespace,
  normalizeMemoryLimit,
  normalizeConfidence,
  buildPlainTextSearchQuery,
  normalizeToolTaskGroups,
  extractMemoryHitsFromToolInvocations,
  DEFAULT_MEMORY_NAMESPACE,
  MAX_MEMORY_SEARCH_LIMIT,
} from "../src/lib/agents/rufloCoreShared.ts";

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

const readSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const chatRouteSource = readSource("src/app/api/agents/chat/route.ts");
const runRouteSource = readSource("src/app/api/agents/run/route.ts");
const resumeRouteSource = readSource("src/app/api/agents/resume/route.ts");
const telegramRouteSource = readSource("src/app/api/telegram/webhook/route.ts");
const adminSessionSource = readSource("src/lib/auth/adminSession.ts");
const rlsHardeningSource = readSource("scripts/sql/cic_production_rls_hardening.sql");
const packageSource = readSource("package.json");
const agentRunsMigrationSource = readSource("scripts/sql/cic_agent_runs_v29.sql");
const runServiceSource = readSource("src/lib/agents/runService.ts");
const capabilityServiceSource = readSource("src/lib/agents/capabilityService.ts");
const mcpClientSource = readSource("src/lib/mcp/client.ts");
const toolsSource = readSource("src/lib/agents/tools.ts");
const dashboardSource = readSource("src/app/dashboard/page.tsx");
const toolPolicySource = readSource("src/lib/agents/toolPolicy.ts");
const agentSecurityMigrationSource = readSource("scripts/sql/cic_agent_security_v30.sql");
const approvalRouteSource = readSource("src/app/api/approval-requests/route.ts");
const approvalPanelSource = readSource("src/components/dashboard/OperatorReviewPanel.tsx");

assert.match(chatRouteSource, /requireAdminOfficeAccess/);
assert.match(runRouteSource, /requireAdminOfficeAccess/);
assert.match(resumeRouteSource, /requireAdminOfficeAccess/);
assert.match(telegramRouteSource, /x-telegram-bot-api-secret-token/);
assert.match(telegramRouteSource, /TELEGRAM_WEBHOOK_SECRET/);
assert.match(adminSessionSource, /ALLOW_MOCK_ADMIN_AUTH/);
assert.match(adminSessionSource, /ADMIN_SESSION_SECRET is required in production/);
assert.match(rlsHardeningSource, /using \(false\)/);
assert.doesNotMatch(chatRouteSource, /new URL\("\/api\/agents\/run"/);
assert.doesNotMatch(telegramRouteSource, /new URL\("\/api\/agents\/run"/);
assert.match(packageSource, /"worker": "node scripts\/agent-worker\.mjs"/);
assert.match(packageSource, /"test:e2e:diagnostic": "node scripts\/diagnostic-agent-e2e\.mjs"/);
assert.match(agentRunsMigrationSource, /create table if not exists public\.agent_runs/);
assert.match(agentRunsMigrationSource, /create table if not exists public\.agent_run_steps/);
assert.match(agentRunsMigrationSource, /create table if not exists public\.capability_requests/);
assert.match(agentRunsMigrationSource, /create table if not exists public\.validation_results/);
assert.match(agentSecurityMigrationSource, /create table if not exists public\.tool_policies/);
assert.match(agentSecurityMigrationSource, /create table if not exists public\.tool_invocations/);
assert.match(agentSecurityMigrationSource, /create table if not exists public\.approval_requests/);
assert.match(agentSecurityMigrationSource, /unique \(office_id, name\)/);
assert.match(agentRunsMigrationSource, /add column if not exists office_id/);
assert.match(runServiceSource, /claimNextAgentRun/);
assert.match(runServiceSource, /processAgentRun/);
assert.match(runServiceSource, /heartbeat_at/);
assert.match(runServiceSource, /blocked_reason/);
assert.match(chatRouteSource, /queueTaskRun/);
assert.match(telegramRouteSource, /queueAgentWorkflow/);
assert.match(telegramRouteSource, /approvalRequired: true/);
assert.doesNotMatch(chatRouteSource, /void runAgentWorkflow/);
assert.doesNotMatch(telegramRouteSource, /void runAgentWorkflow/);
assert.match(capabilityServiceSource, /approveCapabilityRequest/);
assert.match(capabilityServiceSource, /rejectCapabilityRequest/);
assert.match(mcpClientSource, /officeId\?: string \| null/);
assert.match(mcpClientSource, /loadDynamicMcpTools = async \(\s*officeId/);
assert.match(mcpClientSource, /@modelcontextprotocol\/server-filesystem \./);
assert.match(mcpClientSource, /buildSafeProcessEnv/);
assert.doesNotMatch(mcpClientSource, /\.\.\.process\.env/);
assert.match(mcpClientSource, /mcp_sse_private_network_blocked/);
assert.match(toolsSource, /REQUEST_CAPABILITY_TOOL_NAME/);
assert.match(toolsSource, /CREATE_SITE_PREVIEW_TOOL_NAME/);
assert.match(toolsSource, /normalizeSitePreviewHtmlPayload/);
assert.match(toolsSource, /escaped_or_wrapped_html/);
assert.match(toolsSource, /placeholder_content/);
assert.match(toolsSource, /runtime === "mcp"/);
assert.match(toolsSource, /status: "skipped"/);
assert.doesNotMatch(toolsSource, /passed: true,\s*status: "skipped"/);
assert.match(toolPolicySource, /approval_required/);
assert.match(toolPolicySource, /Unknown tools are denied/);
assert.match(approvalRouteSource, /listApprovalRequests/);
assert.match(approvalPanelSource, /approval-requests/);
assert.match(approvalPanelSource, /agent-runs/);
assert.match(dashboardSource, /agent_run\./);
assert.match(dashboardSource, /capability\./);
assert.match(dashboardSource, /OperatorReviewPanel/);

// Ruflo-core: swarm config defaults and clamping.
const swarmDefaults = buildDefaultSwarmConfig(null);
assert.equal(swarmDefaults.topology, "hierarchical");
assert.equal(swarmDefaults.strategy, "specialized");
assert.equal(swarmDefaults.maxAgents, 8);
assert.equal(swarmDefaults.consensusMode, "coordinator_gate");
assert.equal(swarmDefaults.memoryNamespace, DEFAULT_MEMORY_NAMESPACE);
assert.equal(swarmDefaults.antiDrift.coordinatorGate, true);
assert.equal(swarmDefaults.antiDrift.maxIterations, 12);
assert.equal(swarmDefaults.antiDrift.reworkLimit, 2);

const swarmCustom = buildDefaultSwarmConfig({
  topology: "mesh",
  strategy: "balanced",
  maxAgents: 999,
  coordinatorGate: false,
});
assert.equal(swarmCustom.topology, "mesh");
assert.equal(swarmCustom.strategy, "balanced");
assert.equal(swarmCustom.maxAgents, 50);
assert.equal(swarmCustom.antiDrift.coordinatorGate, false);
assert.equal(buildDefaultSwarmConfig({ topology: "bogus", strategy: "bogus" }).topology, "hierarchical");
assert.equal(buildDefaultSwarmConfig({ topology: "bogus", strategy: "bogus" }).strategy, "specialized");

// Ruflo-core: trigger detection taxonomy.
const auditTrigger = detectWorkerTriggers("Please run a security audit for OWASP vulnerabilities");
assert.equal(auditTrigger.detected, true);
assert.equal(auditTrigger.triggers[0].trigger, "audit");
assert.equal(auditTrigger.triggers[0].priority, "critical");
assert.equal(detectWorkerTriggers("").detected, false);
assert.equal(detectWorkerTriggers("just a regular status update").detected, false);
const multiTrigger = detectWorkerTriggers("optimize performance and document the api");
assert.ok(multiTrigger.triggers.some((match) => match.trigger === "optimize"));
assert.ok(multiTrigger.triggers.some((match) => match.trigger === "document"));

// Ruflo-core: memory normalization and scoring fallback.
assert.equal(normalizeMemoryNamespace("  My Namespace!! "), "my-namespace");
assert.equal(normalizeMemoryNamespace(""), DEFAULT_MEMORY_NAMESPACE);
assert.equal(normalizeMemoryLimit(999), MAX_MEMORY_SEARCH_LIMIT);
assert.equal(normalizeMemoryLimit(0), 1);
assert.equal(normalizeConfidence(2), 1);
assert.equal(normalizeConfidence(-1), 0);
assert.equal(buildPlainTextSearchQuery("deploy the railway app"), "deploy the railway app");
assert.equal(buildPlainTextSearchQuery("   "), null);

const memoryHighScore = scoreMemoryPattern({
  query: "deploy railway",
  summary: "deploy railway build pipeline",
  confidence: 0.8,
});
const memoryLowScore = scoreMemoryPattern({
  query: "deploy railway",
  summary: "unrelated note about image generation",
  confidence: 0.2,
});
assert.ok(memoryHighScore > memoryLowScore);
assert.ok(memoryHighScore > 0 && memoryHighScore <= 1);

// Ruflo-core: tool task group normalization preserves order and grouping.
const normalizedGroups = normalizeToolTaskGroups([
  {
    id: "t1",
    toolId: "memory_search",
    status: "completed",
    metadata: { toolGroupId: "grp-1-a", toolGroupStep: 1, source: "llm_tool_call_result", durationMs: 120 },
  },
  {
    id: "t2",
    toolId: "swarm_status",
    status: "completed",
    metadata: { toolGroupId: "grp-1-a", toolGroupStep: 1, source: "llm_tool_call_result" },
  },
  { id: "t3", toolId: "ignored", status: "completed", metadata: {} },
]);
assert.equal(normalizedGroups.length, 1);
assert.equal(normalizedGroups[0].tasks.length, 2);
assert.equal(normalizedGroups[0].status, "completed");
assert.equal(normalizedGroups[0].durationMs, 120);

const extractedMemoryHits = extractMemoryHitsFromToolInvocations([
  {
    toolId: "memory_search",
    output: {
      text: JSON.stringify({
        hits: [
          { id: "m1", key: "k", namespace: "patterns", summary: "s", valuePreview: "v", confidence: 0.5, score: 0.7, tags: [] },
        ],
      }),
    },
  },
]);
assert.equal(extractedMemoryHits.length, 1);
assert.equal(extractedMemoryHits[0].id, "m1");

// Ruflo-core: migration, trace, and tool surface assertions.
const rufloMigrationSource = readSource("scripts/sql/cic_ruflo_core_v32.sql");
assert.match(rufloMigrationSource, /create table if not exists public\.agent_memory_patterns/);
assert.match(rufloMigrationSource, /create table if not exists public\.agent_run_tool_details/);
assert.match(rufloMigrationSource, /on public\.agent_memory_patterns\(office_id, namespace, key\)/);
assert.match(rufloMigrationSource, /detail_token text not null unique/);

const traceRouteSource = readSource("src/app/api/agent-runs/[runId]/trace/route.ts");
assert.match(traceRouteSource, /swarm/);
assert.match(traceRouteSource, /memoryHits/);
assert.match(traceRouteSource, /taskGroups/);

const toolDetailRouteSource = readSource("src/app/api/agent-runs/[runId]/tool-details/[detailToken]/route.ts");
assert.match(toolDetailRouteSource, /requireAdminOfficeAccess/);
assert.match(toolDetailRouteSource, /getAgentRunToolDetail/);

assert.match(toolsSource, /memory_search/);
assert.match(toolsSource, /memory_store/);
assert.match(toolsSource, /memory_retrieve/);
assert.match(toolsSource, /swarm_status/);
assert.match(toolsSource, /agent_status/);
assert.match(toolsSource, /Promise\.allSettled/);
assert.match(toolsSource, /toolGroupId/);

assert.match(approvalPanelSource, /taskGroups/);
assert.match(approvalPanelSource, /memoryHits/);
assert.match(approvalPanelSource, /Swarm config/);

console.log("Office engine tests passed.");
