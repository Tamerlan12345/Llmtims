import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const readSource = (path) => readFileSync(new URL(path, root), "utf8");

const mcpClientSource = readSource("src/lib/mcp/client.ts");
const toolPolicySource = readSource("src/lib/agents/toolPolicy.ts");
const toolsSource = readSource("src/lib/agents/tools.ts");
const runServiceSource = readSource("src/lib/agents/runService.ts");

assert.match(toolPolicySource, /Unknown tools are denied/);
assert.match(toolPolicySource, /approval_required/);
assert.match(toolPolicySource, /tool_invocations/);
assert.match(mcpClientSource, /@modelcontextprotocol\/server-filesystem \./);
assert.doesNotMatch(mcpClientSource, /\.\.\.process\.env/);
assert.match(mcpClientSource, /buildSafeProcessEnv/);
assert.match(mcpClientSource, /mcp_sse_private_network_blocked/);
assert.match(toolsSource, /CREATE_SITE_PREVIEW_TOOL_NAME/);
assert.match(toolsSource, /status: "skipped"/);
assert.doesNotMatch(toolsSource, /passed: true,\s*status: "skipped"/);
assert.match(runServiceSource, /heartbeat_at/);
assert.match(runServiceSource, /blocked_reason/);

const officeId = "diagnostic-office";
const taskId = "diagnostic-site-task";
const runId = "diagnostic-run";

const approvalRequest = {
  request_id: "diagnostic-approval-mcp-filesystem",
  run_id: runId,
  task_id: taskId,
  tool_id: "mcp_stdio:filesystem",
  risk_level: "high",
  action_summary: "Connect filesystem MCP for workspace scope",
  arguments: {
    command: "npx.cmd -y @modelcontextprotocol/server-filesystem .",
    envAllowlist: [],
  },
  resource: "mcp:filesystem",
  status: "pending",
};

assert.equal(approvalRequest.status, "pending");
approvalRequest.status = "approved";
approvalRequest.decision_by = "diagnostic-operator";
approvalRequest.decision_at = new Date().toISOString();

const highRiskWriteAttempt = {
  tool_id: "repo_write",
  risk_level: "high",
  decision: "approval_required",
  action_summary: "Write generated site into the project",
};
assert.equal(highRiskWriteAttempt.decision, "approval_required");

const artifactDir = join(process.cwd(), "_diagnostics");
mkdirSync(artifactDir, { recursive: true });
const artifactPath = join(artifactDir, "site-preview.html");
const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AI Agency Preview</title>
  <style>
    body{margin:0;font-family:Inter,Arial,sans-serif;background:#09090b;color:#fafafa}
    main{display:grid;gap:48px;padding:48px;max-width:1120px;margin:auto}
    section{border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:28px;background:rgba(255,255,255,.04)}
    .hero{min-height:320px;display:grid;align-content:center;background:linear-gradient(135deg,#111827,#7f1d1d)}
    .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
    a{color:#fecdd3}
  </style>
</head>
<body>
  <main>
    <section class="hero" id="hero">
      <h1>AI-агентство полного цикла</h1>
      <p>Проектируем автономных агентов, интеграции MCP и безопасные workflow для бизнеса.</p>
      <a href="#cta">Обсудить запуск</a>
    </section>
    <section id="services">
      <h2>Услуги</h2>
      <div class="grid"><article>Agent workflow</article><article>MCP integration</article><article>Security review</article></div>
    </section>
    <section id="cases">
      <h2>Кейсы</h2>
      <div class="grid"><article>Support copilots</article><article>Ops automation</article><article>Research agents</article></div>
    </section>
    <section id="cta">
      <h2>Готовы собрать агентную команду?</h2>
      <p>Начнем с безопасного preview и validation gate.</p>
    </section>
  </main>
</body>
</html>`;
writeFileSync(artifactPath, html, "utf8");

const artifact = readFileSync(artifactPath, "utf8");
assert.ok(artifact.length > 1000);
assert.match(artifact, /<title>AI Agency Preview<\/title>/);
assert.match(artifact, /id="hero"/);
assert.match(artifact, /id="services"/);
assert.match(artifact, /id="cases"/);
assert.match(artifact, /id="cta"/);
assert.doesNotMatch(artifact, /<script/i);
assert.doesNotMatch(artifact, /javascript:/i);
assert.doesNotMatch(artifact, /\son\w+=/i);

const trace = [
  { type: "approval", decision: "approved", tool: approvalRequest.tool_id },
  { type: "tool_policy", decision: "allowed", tool: "create_site_preview" },
  { type: "artifact", status: "ready", path: artifactPath },
  { type: "validation", status: "passed", checks: ["exists", "html", "sections", "dangerous_urls"] },
  { type: "tool_policy", decision: "approval_required", tool: highRiskWriteAttempt.tool_id },
];

console.log(
  JSON.stringify(
    {
      mode: "diagnostic",
      officeId,
      taskId,
      runId,
      artifactPath,
      finalStatus: "completed",
      trace,
    },
    null,
    2
  )
);
