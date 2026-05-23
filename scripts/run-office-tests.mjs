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
  extractMemoryHitsFromSteps,
  mergeMemoryHits,
  buildMemoryRecallPromptBlock,
  DEFAULT_MEMORY_NAMESPACE,
  MAX_MEMORY_SEARCH_LIMIT,
} from "../src/lib/agents/rufloCoreShared.ts";
import {
  FALLBACK_MODEL,
  MODEL_TIER_ORDER,
  isModelTier,
  normalizeModelTier,
  resolveModelName,
  resolveTierForInvocation,
  sanitizeModelName,
  selectTierForText,
} from "../src/lib/agents/modelRegistry.ts";
import { computeBudgetState } from "../src/lib/agents/budgetShared.ts";
import {
  BUNDLE_VERSION,
  assertBundleVersion,
  buildBundlePayload,
} from "../src/lib/offices/bundleShared.ts";

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

// modelRegistry: tier abstraction stays provider-agnostic and bounded.
assert.deepEqual(MODEL_TIER_ORDER, ["fast", "standard", "advanced", "max"]);
assert.equal(isModelTier("standard"), true);
assert.equal(isModelTier("flagship"), false);
assert.equal(normalizeModelTier(undefined, "advanced"), "advanced");
assert.equal(normalizeModelTier("max"), "max");
// Retired/stale slugs are redirected to the FALLBACK_MODEL so a leftover env
// value can never silently break every agent call.
assert.equal(sanitizeModelName("gemini-3.0-flash"), FALLBACK_MODEL);
assert.equal(sanitizeModelName("gemini-2.0-flash"), FALLBACK_MODEL);
assert.equal(sanitizeModelName(""), FALLBACK_MODEL);
assert.equal(sanitizeModelName("gemini-3.1-flash-lite"), "gemini-3.1-flash-lite");
// Operator-configured ladder: fast/advanced/max each resolve to a distinct id.
assert.equal(resolveModelName("fast"), "gemini-3.1-flash-lite");
assert.equal(resolveModelName("standard"), "gemini-embedding-2");
assert.equal(resolveModelName("advanced"), "gemma-4-31b");
assert.equal(resolveModelName("max"), "gemma-4-26b");
// resolveModelName must always return a non-empty string for any tier.
for (const tier of MODEL_TIER_ORDER) {
  const model = resolveModelName(tier);
  assert.equal(typeof model, "string");
  assert.ok(model.length > 0, `tier ${tier} should resolve to a non-empty model id`);
}
// selectTierForText escalates by length/complexity; bounded heuristics.
assert.equal(selectTierForText(""), "standard");
assert.equal(selectTierForText("hi"), "fast");
assert.equal(selectTierForText("Please refactor the auth module to improve security"), "advanced");
assert.equal(selectTierForText("x".repeat(17000)), "max");
// Without AGENT_MODEL_AUTO_TIER, requested tier is honoured; falls back to default otherwise.
delete process.env.AGENT_MODEL_AUTO_TIER;
assert.equal(resolveTierForInvocation({ requestedTier: "max", promptText: "short" }), "max");
assert.equal(resolveTierForInvocation({ requestedTier: null, promptText: "short" }), "standard");
process.env.AGENT_MODEL_AUTO_TIER = "true";
assert.equal(resolveTierForInvocation({ requestedTier: null, promptText: "hi" }), "fast");
delete process.env.AGENT_MODEL_AUTO_TIER;

// Learning loop: memory recall block + merge dedupes by namespace/key.
const recallBlock = buildMemoryRecallPromptBlock([
  {
    id: "h1",
    key: "deploy",
    namespace: "patterns",
    summary: "Successful deploy run",
    valuePreview: "intent: deploy railway\nstatus: completed",
    confidence: 0.82,
    score: 0.9,
    tags: ["deploy", "railway"],
    sourceRunId: "r1",
    sourceTaskId: "t1",
    createdAt: null,
  },
]);
assert.ok(recallBlock && recallBlock.includes("ПРОВЕРЕННЫЕ ПАТТЕРНЫ"));
assert.ok(recallBlock.includes("Successful deploy run"));
assert.equal(buildMemoryRecallPromptBlock([]), null);

const stepHits = extractMemoryHitsFromSteps([
  {
    stepType: "memory_recall",
    output: {
      hits: [
        { id: "s1", key: "deploy", namespace: "patterns", summary: "from step", valuePreview: "v", confidence: 0.6, score: 0.55, tags: [] },
      ],
    },
  },
  { stepType: "router", output: { hits: [{ key: "ignored" }] } },
]);
assert.equal(stepHits.length, 1);
assert.equal(stepHits[0].id, "s1");

const merged = mergeMemoryHits(
  [
    { id: "a", key: "deploy", namespace: "patterns", summary: "low", valuePreview: "", confidence: 0.3, score: 0.4, tags: [] },
  ],
  [
    { id: "b", key: "deploy", namespace: "patterns", summary: "high", valuePreview: "", confidence: 0.8, score: 0.7, tags: [] },
    { id: "c", key: "other", namespace: "patterns", summary: "unique", valuePreview: "", confidence: 0.5, score: 0.6, tags: [] },
  ]
);
assert.equal(merged.length, 2);
assert.equal(merged[0].id, "b", "highest-confidence dedupe winner should come first");
assert.ok(merged.find((hit) => hit.key === "other"), "non-duplicate hits must survive");

// Adaptive replanning + memory recall are wired into the workflow graph.
const nodesSource = readSource("src/lib/agents/nodes.ts");
const graphSource = readSource("src/lib/agents/graph.ts");
assert.match(nodesSource, /memory_recall/);
assert.match(nodesSource, /searchAgentMemoryPatterns/);
assert.match(nodesSource, /adaptive_replan/);
assert.match(nodesSource, /workflow\.adaptive_replan/);
assert.match(nodesSource, /buildMemoryRecallPromptBlock/);
assert.match(graphSource, /replan_count/);

// Background trigger worker: read-only triggers + dispatch wiring.
const backgroundTriggersSource = readSource("src/lib/agents/backgroundTriggers.ts");
assert.match(backgroundTriggersSource, /READ_ONLY_TRIGGERS/);
for (const trigger of ["audit", "map", "testgaps", "document", "deepdive"]) {
  assert.match(backgroundTriggersSource, new RegExp(`"${trigger}"`));
}
assert.match(backgroundTriggersSource, /ENABLE_BACKGROUND_TRIGGERS/);
assert.match(backgroundTriggersSource, /metadata\.background === true/);
assert.match(backgroundTriggersSource, /backgroundDispatched/);
assert.match(runServiceSource, /dispatchBackgroundTriggers/);

// modelRegistry abstraction wired into tools.ts so model id is no longer hard-coded.
assert.match(toolsSource, /resolveModelName/);
assert.match(toolsSource, /resolveTierForInvocation/);
assert.match(toolsSource, /llmInstances/);
assert.doesNotMatch(toolsSource, /\bactiveGeminiModel\b/);

// Cost tracker: budget state thresholds + tier override wiring.
// No cap configured → enforcement disabled.
assert.equal(
  computeBudgetState({
    dailyUsageTokens: 9_999_999,
    monthlyUsageTokens: 9_999_999,
    dailyCap: null,
    monthlyCap: null,
    warnPct: 80,
    hardPct: 100,
  }).state,
  "ok"
);
// Under warn threshold → ok.
assert.equal(
  computeBudgetState({
    dailyUsageTokens: 500,
    monthlyUsageTokens: 0,
    dailyCap: 1000,
    monthlyCap: null,
    warnPct: 80,
    hardPct: 100,
  }).state,
  "ok"
);
// At/above warn but below hard → warn.
const warnEval = computeBudgetState({
  dailyUsageTokens: 800,
  monthlyUsageTokens: 0,
  dailyCap: 1000,
  monthlyCap: null,
  warnPct: 80,
  hardPct: 100,
});
assert.equal(warnEval.state, "warn");
assert.equal(warnEval.dailyUsagePct, 80);
// At/above hard → block.
assert.equal(
  computeBudgetState({
    dailyUsageTokens: 1000,
    monthlyUsageTokens: 0,
    dailyCap: 1000,
    monthlyCap: null,
    warnPct: 80,
    hardPct: 100,
  }).state,
  "block"
);
// Either cap can trigger block — monthly hit also blocks.
assert.equal(
  computeBudgetState({
    dailyUsageTokens: 10,
    monthlyUsageTokens: 50_000,
    dailyCap: 1000,
    monthlyCap: 50_000,
    warnPct: 80,
    hardPct: 100,
  }).state,
  "block"
);

const budgetMigrationSource = readSource("scripts/sql/cic_office_budgets_v33.sql");
assert.match(budgetMigrationSource, /alter table public\.offices/);
assert.match(budgetMigrationSource, /daily_token_budget/);
assert.match(budgetMigrationSource, /monthly_token_budget/);
assert.match(budgetMigrationSource, /budget_warn_pct/);
assert.match(budgetMigrationSource, /budget_hard_pct/);
assert.match(budgetMigrationSource, /budget_force_tier/);
assert.match(budgetMigrationSource, /idx_token_logs_office_created/);

assert.match(runServiceSource, /evaluateBudget/);
assert.match(runServiceSource, /budget_exceeded/);
assert.match(toolsSource, /evaluateBudget/);
assert.match(toolsSource, /forceTier/);

const officesRouteSource = readSource("src/app/api/offices/route.ts");
assert.match(officesRouteSource, /dailyTokenBudget/);
assert.match(officesRouteSource, /budgetForceTier/);
assert.match(officesRouteSource, /invalidateBudgetUsageCache/);

const budgetRouteSource = readSource("src/app/api/offices/[officeId]/budget/route.ts");
assert.match(budgetRouteSource, /requireAdminOfficeAccess/);
assert.match(budgetRouteSource, /evaluateBudget/);

const operatorPanelSource = readSource("src/components/dashboard/OperatorReviewPanel.tsx");
assert.match(operatorPanelSource, /Token budget/);
assert.match(operatorPanelSource, /loadBudget/);

// Office bundle export/import: version guard + payload normalization + routes.
assert.equal(BUNDLE_VERSION, "1");
assert.throws(() => assertBundleVersion({}), /bundle_version_unsupported/);
assert.throws(() => assertBundleVersion({ version: "0" }), /bundle_version_unsupported/);
assert.throws(() => assertBundleVersion(null), /bundle_invalid/);
assert.deepEqual(assertBundleVersion({ version: "1" }), { version: "1" });

const samplePayload = buildBundlePayload({
  office: { name: "Demo", description: "d", metadata: { theme: "dark" } },
  settings: {
    approveMode: false,
    approveModeMinRisk: "high",
    autoApprovedMcps: [],
    dailyTokenBudget: 1000,
    monthlyTokenBudget: null,
    budgetWarnPct: 80,
    budgetHardPct: 100,
    budgetForceTier: "fast",
  },
  agents: [
    { id: "a1", role: "Coordinator", name: "Coordinator", role_md: "md", metadata: { x: 1 } },
    { id: "a2", role: "", name: "Should be dropped", role_md: null, metadata: null },
  ],
  agentSkills: [
    { agent_id: "a1", skill_id: "s1", is_enabled: true },
    { agent_id: "a1", skill_id: "s2", is_enabled: false },
    { agent_id: "a1", skill_id: "missing", is_enabled: true },
  ],
  skillCatalog: [
    { id: "s1", name: "planning" },
    { id: "s2", name: "coding" },
  ],
  memoryPatterns: [
    { namespace: "patterns", key: "run-1", summary: "s", value: "v", confidence: 0.7, tags: ["deploy"], metadata: {} },
    { namespace: "patterns", key: "", summary: null, value: "ignored", confidence: 0, tags: null, metadata: null },
  ],
});
assert.equal(samplePayload.version, "1");
assert.equal(samplePayload.agents.length, 1, "agents without a role must be dropped");
assert.deepEqual(samplePayload.agents[0].skillNames, ["planning"], "disabled and unknown skills are excluded");
assert.equal(samplePayload.memoryPatterns.length, 1, "memory patterns without a key are dropped");
assert.equal(samplePayload.memoryPatterns[0].confidence, 0.7);

const bundleSource = readSource("src/lib/offices/bundle.ts");
assert.match(bundleSource, /exportOfficeBundle/);
assert.match(bundleSource, /importOfficeBundle/);
// Bundle must never carry runtime tables.
assert.doesNotMatch(bundleSource, /from\(["']agent_runs["']\)/);
assert.doesNotMatch(bundleSource, /from\(["']agent_run_steps["']\)/);
assert.doesNotMatch(bundleSource, /from\(["']tasks["']\)/);
assert.doesNotMatch(bundleSource, /from\(["']token_logs["']\)/);

const exportRouteSource = readSource("src/app/api/offices/[officeId]/export/route.ts");
const importRouteSource = readSource("src/app/api/offices/[officeId]/import/route.ts");
assert.match(exportRouteSource, /requireAdminOfficeAccess/);
assert.match(exportRouteSource, /exportOfficeBundle/);
assert.match(importRouteSource, /requireAdminOfficeAccess/);
assert.match(importRouteSource, /importOfficeBundle/);
assert.match(importRouteSource, /bundle_too_large/);
assert.match(importRouteSource, /dryRun/);

console.log("Office engine tests passed.");
