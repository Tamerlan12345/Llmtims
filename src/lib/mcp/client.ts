import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DynamicTool } from "@langchain/core/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadServerEnv } from "@/lib/config/serverEnv";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import {
  authorizeToolInvocation,
  createApprovalRequest,
  redactSensitiveValue,
  recordToolInvocation,
  type ApprovalRequest,
} from "@/lib/agents/toolPolicy";

loadServerEnv();

export type McpConfigType = "stdio" | "sse";
export type McpConfigStatus = "active" | "testing" | "error";

interface McpConfigRow {
  id: string;
  officeId: string | null;
  name: string;
  type: McpConfigType;
  command: string | null;
  url: string | null;
  envVars: Record<string, unknown>;
  status: McpConfigStatus;
  lastError: string | null;
  updatedAt: string | null;
}

interface RuntimeTool {
  alias: string;
  remoteName: string;
  serverName: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
}

interface McpRuntime {
  config: McpConfigRow;
  client: Client;
  tools: RuntimeTool[];
}

interface CallMcpToolResult {
  toolName: string;
  output: string;
  isError: boolean;
}

interface ProvisionMcpServerInput {
  officeId?: string | null;
  name: string;
  type: McpConfigType;
  command?: string | null;
  url?: string | null;
  envVars?: Record<string, string>;
  approved?: boolean;
  approvalRequestId?: string | null;
}

export interface ProvisionMcpServerResult {
  success: boolean;
  configId: string | null;
  status: McpConfigStatus;
  tools: string[];
  message: string;
  error: string | null;
  approvalRequired?: boolean;
  approvalRequestId?: string | null;
}

const MCP_CLIENT_NAME = "llmtims-mcp-client";
const MCP_CLIENT_VERSION = "1.0.0";
const MCP_CONNECT_TIMEOUT_MS = 12_000;
const MCP_CALL_TIMEOUT_MS = 15_000;
const MAX_RUNTIME_CACHE_SIZE = 50;
// Use platform-appropriate npx command (npx.cmd on Windows, npx on Linux/macOS)
const NPX_CMD = process.platform === "win32" ? "npx.cmd" : "npx";

const runtimeCache = new Map<string, Promise<McpRuntime | null>>();

interface McpTemplatePolicy {
  name: string;
  type: McpConfigType;
  command?: string;
  allowedEnv: string[];
  workspaceScoped?: boolean;
  description?: string;
}

export const MCP_TEMPLATE_POLICIES: Record<string, McpTemplatePolicy> = {
  filesystem: {
    name: "filesystem",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-filesystem .`,
    allowedEnv: [],
    workspaceScoped: true,
    description: "Local filesystem: read/write files in workspace",
  },
  "google-search": {
    name: "google-search",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-google-search`,
    allowedEnv: ["GOOGLE_API_KEY"],
    description: "Google Search: web search via Google API",
  },
  github: {
    name: "github",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-github`,
    allowedEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"],
    description: "GitHub: repositories, issues, pull requests, commits",
  },
  notion: {
    name: "notion",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-notion`,
    allowedEnv: ["NOTION_API_KEY"],
    description: "Notion: pages, databases, blocks, workspaces",
  },
  linear: {
    name: "linear",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-linear`,
    allowedEnv: ["LINEAR_API_KEY"],
    description: "Linear: issues, projects, teams, cycles",
  },
  slack: {
    name: "slack",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-slack`,
    allowedEnv: ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
    description: "Slack: messages, channels, users, reactions",
  },
  jira: {
    name: "jira",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-jira`,
    allowedEnv: ["JIRA_API_TOKEN", "JIRA_BASE_URL", "JIRA_EMAIL"],
    description: "Jira: issues, projects, sprints, boards",
  },
  puppeteer: {
    name: "puppeteer",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-puppeteer`,
    allowedEnv: [],
    description: "Browser automation: screenshots, web scraping, form filling",
  },
  postgres: {
    name: "postgres",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-postgres`,
    allowedEnv: ["DATABASE_URL"],
    description: "PostgreSQL: query, inspect schema, run SQL",
  },
  "brave-search": {
    name: "brave-search",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-brave-search`,
    allowedEnv: ["BRAVE_API_KEY"],
    description: "Brave Search: private web search",
  },
  fetch: {
    name: "fetch",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-fetch`,
    allowedEnv: [],
    description: "HTTP fetch: retrieve web pages and API responses",
  },
  "memory-store": {
    name: "memory-store",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-memory`,
    allowedEnv: [],
    description: "Persistent memory: store and retrieve key-value pairs across sessions",
  },
  "sequential-thinking": {
    name: "sequential-thinking",
    type: "stdio",
    command: `${NPX_CMD} -y @modelcontextprotocol/server-sequential-thinking`,
    allowedEnv: [],
    description: "Structured thinking: sequential reasoning chains and problem decomposition",
  },
};

/** Return template names + descriptions for agent prompts */
export const getMcpTemplateCatalog = (): Array<{ name: string; description: string }> =>
  Object.values(MCP_TEMPLATE_POLICIES).map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
  }));

const normalizeName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const normalizeToolName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

const buildToolAlias = (serverName: string, toolName: string): string =>
  normalizeToolName(`${normalizeName(serverName)}__${toolName}`);

const normalizeCommandForCompare = (value: string): string =>
  splitCommandLine(value).join(" ").trim().toLowerCase();

const hasDangerousShellSyntax = (command: string): boolean =>
  /[;&|`<>]|\$\(|\b(curl|wget|powershell|pwsh|cmd\.exe|bash|sh|rm|del|erase|format|mkfs|sudo)\b/i.test(command);

const getTemplatePolicy = (name: string): McpTemplatePolicy | null => {
  const normalized = normalizeName(name);
  return MCP_TEMPLATE_POLICIES[normalized] ?? null;
};

const validateMcpProvisionInput = (input: ProvisionMcpServerInput): { ok: true } | { ok: false; error: string } => {
  const normalizedName = normalizeName(input.name);
  const template = getTemplatePolicy(normalizedName);
  if (!template) {
    return { ok: false, error: "mcp_template_not_allowed" };
  }
  if (template.type !== input.type) {
    return { ok: false, error: "mcp_transport_not_allowed" };
  }

  if (input.type === "stdio") {
    const command = (input.command ?? "").trim();
    if (!command) return { ok: false, error: "missing_command" };
    if (hasDangerousShellSyntax(command)) return { ok: false, error: "mcp_command_dangerous" };
    if (!template.command || normalizeCommandForCompare(command) !== normalizeCommandForCompare(template.command)) {
      return { ok: false, error: "mcp_command_not_allowlisted" };
    }
  }

  if (input.type === "sse") {
    const endpoint = (input.url ?? "").trim();
    const urlValidation = validateSseEndpoint(endpoint);
    if (!urlValidation.ok) return urlValidation;
  }

  const envVars = input.envVars ?? {};
  const disallowedEnv = Object.keys(envVars).filter((key) => !template.allowedEnv.includes(key));
  if (disallowedEnv.length > 0) {
    return { ok: false, error: `mcp_env_not_allowlisted:${disallowedEnv.join(",")}` };
  }

  return { ok: true };
};

const validateSseEndpoint = (endpoint: string): { ok: true } | { ok: false; error: string } => {
  if (!endpoint) return { ok: false, error: "missing_url" };
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "mcp_sse_https_required" };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    /^169\.254\./.test(hostname)
  ) {
    return { ok: false, error: "mcp_sse_private_network_blocked" };
  }
  return { ok: true };
};

const buildSafeProcessEnv = (envOverrides: Record<string, string>, allowedEnv: string[]): Record<string, string> => {
  const safeEnv: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      safeEnv[key] = value;
    }
  }
  for (const key of allowedEnv) {
    const value = envOverrides[key] ?? process.env[key];
    if (typeof value === "string" && value.trim()) {
      safeEnv[key] = value;
    }
  }
  return safeEnv;
};

const toRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

const parseToolInput = (input: string): Record<string, unknown> => {
  const normalized = input.trim();
  if (!normalized) return {};

  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return { input: normalized };
  }

  return { input: normalized };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      reject(new Error(`mcp_timeout:${label}`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]);
};

const splitCommandLine = (commandLine: string): string[] => {
  const tokens: string[] = [];
  const matcher = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let match: RegExpExecArray | null = matcher.exec(commandLine);
  while (match) {
    const token = match[1] ?? match[2] ?? match[0];
    if (token.length > 0) {
      tokens.push(token);
    }
    match = matcher.exec(commandLine);
  }
  return tokens;
};

const deriveCryptoKey = (): Buffer | null => {
  if (process.env.NODE_ENV === "production" && !process.env.MCP_CONFIG_ENCRYPTION_KEY?.trim()) {
    throw new Error("MCP_CONFIG_ENCRYPTION_KEY is required in production.");
  }

  const secret =
    process.env.MCP_CONFIG_ENCRYPTION_KEY ??
    (process.env.NODE_ENV === "production" ? "" : process.env.SUPABASE_SERVICE_ROLE_KEY) ??
    "";
  if (!secret.trim()) return null;
  return createHash("sha256").update(secret).digest();
};

const isEncryptedSecret = (value: string): boolean => value.startsWith("enc:v1:");

const encryptSecret = (value: string): string => {
  const key = deriveCryptoKey();
  if (!key) return value;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}:${authTag.toString("base64url")}:${encrypted.toString(
    "base64url"
  )}`;
};

const decryptSecret = (value: string): string => {
  const key = deriveCryptoKey();
  if (!key || !isEncryptedSecret(value)) return value;

  const parts = value.split(":");
  if (parts.length !== 5) return value;

  try {
    const iv = Buffer.from(parts[2], "base64url");
    const authTag = Buffer.from(parts[3], "base64url");
    const payload = Buffer.from(parts[4], "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return value;
  }
};

export const encryptEnvVars = (envVars: Record<string, string>): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(envVars)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    const normalizedValue = String(raw ?? "").trim();
    if (!normalizedValue) continue;
    output[normalizedKey] = isEncryptedSecret(normalizedValue)
      ? normalizedValue
      : encryptSecret(normalizedValue);
  }
  return output;
};

const decryptEnvVars = (envVars: Record<string, unknown>): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(envVars)) {
    if (typeof raw !== "string") continue;
    const normalizedKey = key.trim();
    if (!normalizedKey) continue;
    output[normalizedKey] = decryptSecret(raw);
  }
  return output;
};

const normalizeMcpConfigRow = (row: Record<string, unknown>): McpConfigRow | null => {
  const id = typeof row.id === "string" ? row.id : "";
  const name = typeof row.name === "string" ? row.name : "";
  const rawType = typeof row.type === "string" ? row.type : "";
  const type = rawType === "sse" ? "sse" : rawType === "stdio" ? "stdio" : null;
  const rawStatus = typeof row.status === "string" ? row.status : "";
  const status =
    rawStatus === "active" || rawStatus === "testing" || rawStatus === "error"
      ? (rawStatus as McpConfigStatus)
      : null;
  if (!id || !name || !type || !status) return null;

  return {
    id,
    officeId: typeof row.office_id === "string" ? row.office_id : null,
    name,
    type,
    command: typeof row.command === "string" ? row.command : null,
    url: typeof row.url === "string" ? row.url : null,
    envVars: toRecord(row.env_vars),
    status,
    lastError: typeof row.last_error === "string" ? row.last_error : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
};

const loadMcpConfigs = async (
  statuses: McpConfigStatus[] = ["active"],
  officeId?: string | null
): Promise<McpConfigRow[]> => {
  if (!isServerSupabaseConfigured) return [];

  try {
    let query = supabase
      .from("mcp_configs")
      .select("id, office_id, name, type, command, url, env_vars, status, last_error, updated_at")
      .in("status", statuses)
      .order("updated_at", { ascending: false });

    const normalizedOfficeId = typeof officeId === "string" ? officeId.trim() : "";
    if (normalizedOfficeId) {
      query = query.or(`office_id.is.null,office_id.eq.${normalizedOfficeId}`);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[mcp] failed to load configs:", error.message);
      return [];
    }

    return (Array.isArray(data) ? data : [])
      .map((row) => normalizeMcpConfigRow(row as Record<string, unknown>))
      .filter((row): row is McpConfigRow => Boolean(row));
  } catch (error) {
    console.error("[mcp] failed to load configs:", error);
    return [];
  }
};

const extractTextContent = (result: unknown): string => {
  const envelope = result as {
    content?: Array<{ type?: string; text?: string; [key: string]: unknown }>;
    toolResult?: unknown;
    [key: string]: unknown;
  };
  const chunks = Array.isArray(envelope.content) ? envelope.content : [];
  const textParts = chunks
    .map((chunk) => (typeof chunk.text === "string" ? chunk.text : null))
    .filter((chunk): chunk is string => Boolean(chunk));

  if (textParts.length > 0) {
    return textParts.join("\n");
  }

  if (typeof envelope.toolResult === "string") {
    return envelope.toolResult;
  }

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
};

const mapRuntimeTools = (configName: string, toolsResult: unknown): RuntimeTool[] => {
  const envelope = toolsResult as {
    tools?: Array<Record<string, unknown>>;
  };

  return (envelope.tools ?? [])
    .map((tool) => {
      const remoteName = typeof tool.name === "string" ? tool.name.trim() : "";
      if (!remoteName) return null;
      const description =
        typeof tool.description === "string" && tool.description.trim().length > 0
          ? tool.description.trim()
          : `MCP tool '${remoteName}' from server '${configName}'.`;
      const alias = buildToolAlias(configName, remoteName);
      const inputSchema =
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? (tool.inputSchema as Record<string, unknown>)
          : null;

      return {
        alias,
        remoteName,
        serverName: configName,
        description,
        inputSchema,
      } satisfies RuntimeTool;
    })
    .filter((tool): tool is RuntimeTool => Boolean(tool));
};

const buildTransport = (config: McpConfigRow) => {
  const envOverrides = decryptEnvVars(config.envVars);
  if (config.type === "stdio") {
    const commandLine = config.command?.trim() ?? "";
    if (!commandLine) {
      throw new Error(`mcp_stdio_command_missing:${config.name}`);
    }

    const [command, ...args] = splitCommandLine(commandLine);
    if (!command) {
      throw new Error(`mcp_stdio_command_parse_failed:${config.name}`);
    }
    const template = getTemplatePolicy(config.name);
    if (!template || !template.command || normalizeCommandForCompare(commandLine) !== normalizeCommandForCompare(template.command)) {
      throw new Error(`mcp_stdio_command_not_allowlisted:${config.name}`);
    }

    return new StdioClientTransport({
      command,
      args,
      env: buildSafeProcessEnv(envOverrides, template.allowedEnv),
      stderr: "ignore",
    });
  }

  const endpoint = config.url?.trim() ?? "";
  if (!endpoint) {
    throw new Error(`mcp_sse_url_missing:${config.name}`);
  }
  const urlValidation = validateSseEndpoint(endpoint);
  if (urlValidation.ok === false) {
    throw new Error(urlValidation.error);
  }
  return new SSEClientTransport(new URL(endpoint));
};

const createRuntimeForConfig = async (config: McpConfigRow): Promise<McpRuntime | null> => {
  const client = new Client(
    {
      name: MCP_CLIENT_NAME,
      version: MCP_CLIENT_VERSION,
    },
    {
      capabilities: {},
    }
  );

  const transport = buildTransport(config);

  try {
    await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, `${config.name}:connect`);
    const tools = await withTimeout(client.listTools(), MCP_CONNECT_TIMEOUT_MS, `${config.name}:list_tools`);

    return {
      config,
      client,
      tools: mapRuntimeTools(config.name, tools),
    };
  } catch (error) {
    try {
      await transport.close();
    } catch {
      // no-op
    }
    throw error;
  }
};

const getRuntimeCacheKey = (config: McpConfigRow): string =>
  `${config.id}:${config.updatedAt ?? "no-updated-at"}`;

const evictRuntimeCacheEntry = async (key: string): Promise<void> => {
  const promise = runtimeCache.get(key);
  runtimeCache.delete(key);
  if (promise) {
    const runtime = await promise.catch(() => null);
    if (runtime) {
      try {
        // Close underlying transport to release subprocess / HTTP stream
        const transport = (runtime.client as unknown as { _transport?: { close?: () => Promise<void> } })._transport;
        await transport?.close?.();
      } catch {
        // no-op: transport may already be closed
      }
    }
  }
};

const cleanupStaleRuntimeEntries = async (activeConfigIds: Set<string>): Promise<void> => {
  for (const key of Array.from(runtimeCache.keys())) {
    const configId = key.split(":")[0];
    if (!activeConfigIds.has(configId)) {
      await evictRuntimeCacheEntry(key);
    }
  }
};

const getRuntimeForConfig = async (
  config: McpConfigRow,
  options: { forceRefresh?: boolean } = {}
): Promise<McpRuntime | null> => {
  if (options.forceRefresh) {
    for (const key of Array.from(runtimeCache.keys())) {
      if (key.startsWith(`${config.id}:`)) {
        await evictRuntimeCacheEntry(key);
      }
    }
  }

  const key = getRuntimeCacheKey(config);
  if (!runtimeCache.has(key)) {
    // Evict LRU entries if cache is too large
    if (runtimeCache.size >= MAX_RUNTIME_CACHE_SIZE) {
      const firstKey = runtimeCache.keys().next().value;
      if (firstKey) await evictRuntimeCacheEntry(firstKey);
    }
    runtimeCache.set(
      key,
      createRuntimeForConfig(config).catch((error) => {
        console.error(`[mcp] failed to connect '${config.name}':`, error instanceof Error ? error.message : error);
        runtimeCache.delete(key); // Remove failed entry so next call retries
        return null;
      })
    );
  }
  return runtimeCache.get(key) ?? null;
};

const resolveToolCandidates = (
  runtimes: McpRuntime[],
  names: string[]
): Array<{ runtime: McpRuntime; tool: RuntimeTool }> => {
  const normalizedTargets = names.map((item) => normalizeToolName(item));
  if (normalizedTargets.length === 0) return [];

  const candidates: Array<{ runtime: McpRuntime; tool: RuntimeTool; rank: number }> = [];
  for (const runtime of runtimes) {
    for (const tool of runtime.tools) {
      const toolAlias = normalizeToolName(tool.alias);
      const toolRemoteName = normalizeToolName(tool.remoteName);
      const serverDotTool = normalizeToolName(`${tool.serverName}.${tool.remoteName}`);

      let rank = Number.POSITIVE_INFINITY;
      for (const target of normalizedTargets) {
        if (target === toolAlias || target === serverDotTool) {
          rank = Math.min(rank, 1);
          continue;
        }
        if (target === toolRemoteName) {
          rank = Math.min(rank, 2);
          continue;
        }
        if (toolAlias.endsWith(`_${target}`) || toolAlias.endsWith(`__${target}`)) {
          rank = Math.min(rank, 3);
        }
      }
      if (Number.isFinite(rank)) {
        candidates.push({ runtime, tool, rank });
      }
    }
  }

  return candidates
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => ({ runtime: entry.runtime, tool: entry.tool }));
};

const callRuntimeTool = async (
  runtime: McpRuntime,
  tool: RuntimeTool,
  args: Record<string, unknown>
): Promise<CallMcpToolResult> => {
  const authorization = await authorizeToolInvocation({
    officeId: runtime.config.officeId,
    toolId: tool.alias,
    actionType: undefined,
    arguments: args,
    resource: `${runtime.config.name}/${tool.remoteName}`,
    actionSummary: `Call MCP tool ${runtime.config.name}/${tool.remoteName}`,
    metadata: {
      source: "mcp_runtime",
      serverName: runtime.config.name,
      remoteTool: tool.remoteName,
    },
  });

  if (authorization.decision === "denied") {
    return {
      toolName: tool.alias,
      output: `tool_denied: ${authorization.reason}`,
      isError: true,
    };
  }

  if (authorization.decision === "approval_required") {
    return {
      toolName: tool.alias,
      output: `approval_required: ${authorization.approvalRequest?.id ?? "pending"} must approve ${tool.alias} before execution.`,
      isError: true,
    };
  }

  try {
    const result = await withTimeout(
      runtime.client.callTool({
        name: tool.remoteName,
        arguments: args,
      }),
      MCP_CALL_TIMEOUT_MS,
      `${runtime.config.name}:${tool.remoteName}`
    );

    const envelope = result as { isError?: unknown };
    const output = extractTextContent(result);
    await recordToolInvocation({
      officeId: runtime.config.officeId,
      toolId: tool.alias,
      arguments: args,
      actionType: undefined,
      riskLevel: authorization.riskLevel,
      decision: "allowed",
      status: envelope.isError === true ? "failed" : "completed",
      output: { text: output.slice(0, 4000) },
      error: envelope.isError === true ? output.slice(0, 1000) : null,
      metadata: {
        source: "mcp_runtime",
        serverName: runtime.config.name,
        remoteTool: tool.remoteName,
      },
    });
    return {
      toolName: tool.alias,
      output,
      isError: envelope.isError === true,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    await recordToolInvocation({
      officeId: runtime.config.officeId,
      toolId: tool.alias,
      arguments: args,
      actionType: undefined,
      riskLevel: authorization.riskLevel,
      decision: "allowed",
      status: "failed",
      error: reason,
      metadata: {
        source: "mcp_runtime",
        serverName: runtime.config.name,
        remoteTool: tool.remoteName,
      },
    });
    throw error;
  }
};

const loadActiveRuntimes = async (officeId?: string | null): Promise<McpRuntime[]> => {
  const activeConfigs = await loadMcpConfigs(["active"], officeId);
  if (activeConfigs.length === 0) return [];

  // Periodically clean up cache entries for removed/errored configs
  if (runtimeCache.size > 20) {
    const activeIds = new Set(activeConfigs.map((c) => c.id));
    cleanupStaleRuntimeEntries(activeIds).catch((err) =>
      console.error("[mcp] cleanup error:", err instanceof Error ? err.message : err)
    );
  }

  const runtimes = await Promise.all(activeConfigs.map((config) => getRuntimeForConfig(config)));
  return runtimes.filter((runtime): runtime is McpRuntime => Boolean(runtime));
};

// Periodic cache cleanup every 30 minutes in server context
if (typeof setInterval !== "undefined") {
  setInterval(
    async () => {
      if (runtimeCache.size === 0) return;
      const activeConfigs = await loadMcpConfigs(["active"]).catch(() => []);
      const activeIds = new Set(activeConfigs.map((c: McpConfigRow) => c.id));
      cleanupStaleRuntimeEntries(activeIds).catch(() => undefined);
    },
    30 * 60 * 1000
  );
}

const upsertMcpSkillCatalog = async (
  configName: string,
  type: McpConfigType,
  toolNames: string[],
  officeId?: string | null
): Promise<void> => {
  if (!isServerSupabaseConfigured) return;

  const normalized = normalizeName(configName);
  const skillName = `mcp_${normalized}`;
  const description = `MCP server '${configName}' (${type}) exposing ${toolNames.length} tool(s).`;

  const parameterSchema = {
    type: "object",
    properties: {
      tool: { type: "string", description: "Tool name exposed by this MCP server" },
      input: { type: "object", description: "Tool payload object" },
    },
    required: ["tool"],
  };

  const metadata = {
    category: "mcp",
    mcp_server: configName,
    mcp_type: type,
    mcp_tools: toolNames,
    office_id: officeId ?? null,
    registered_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("skills_catalog")
    .upsert(
      {
        name: skillName,
        description,
        runtime: "mcp",
        parameter_schema: parameterSchema,
        endpoint: null,
        is_verified: true,
        is_active: true,
        metadata,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "name" }
    );

  if (error) {
    console.error(`[mcp] failed to upsert skills_catalog for '${configName}':`, error.message);
  }
};

const updateMcpConfigStatus = async (
  configId: string,
  status: McpConfigStatus,
  lastError: string | null
): Promise<void> => {
  if (!isServerSupabaseConfigured) return;
  const { error } = await supabase
    .from("mcp_configs")
    .update({
      status,
      last_error: lastError,
      updated_at: new Date().toISOString(),
    })
    .eq("id", configId);

  if (error) {
    console.error(`[mcp] failed to update status for ${configId}:`, error.message);
  }
};

export const callPreferredMcpTool = async (
  preferredNames: string[],
  args: Record<string, unknown>,
  options: { officeId?: string | null } = {}
): Promise<CallMcpToolResult | null> => {
  const runtimes = await loadActiveRuntimes(options.officeId);
  if (runtimes.length === 0) return null;

  const candidates = resolveToolCandidates(runtimes, preferredNames);
  if (candidates.length === 0) return null;

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return await callRuntimeTool(candidate.runtime, candidate.tool, args);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown_error";
      errors.push(`${candidate.tool.alias}:${reason}`);
    }
  }

  if (errors.length > 0) {
    return {
      toolName: candidates[0]?.tool.alias ?? preferredNames[0] ?? "unknown",
      output: `MCP tool invocation failed: ${errors.join("; ")}`,
      isError: true,
    };
  }

  return null;
};

export const loadDynamicMcpTools = async (
  officeId?: string | null,
  _role?: string | null
): Promise<DynamicTool[]> => {
  const runtimes = await loadActiveRuntimes(officeId);
  const mappedTools = runtimes.flatMap((runtime) =>
    runtime.tools.map((tool) =>
      new DynamicTool({
        name: tool.alias,
        description: `${tool.description}\nMCP server: ${runtime.config.name}`,
        func: async (input: string) => {
          try {
            const result = await callRuntimeTool(runtime, tool, parseToolInput(input));
            return result.output;
          } catch (error) {
            return `MCP '${runtime.config.name}/${tool.remoteName}' failed: ${
              error instanceof Error ? error.message : "unknown_error"
            }`;
          }
        },
      })
    )
  );

  const deduped = new Map<string, DynamicTool>();
  for (const tool of mappedTools) {
    if (!deduped.has(tool.name)) {
      deduped.set(tool.name, tool);
    }
  }
  return Array.from(deduped.values());
};

export const provisionMcpServer = async (
  input: ProvisionMcpServerInput
): Promise<ProvisionMcpServerResult> => {
  const normalizedName = normalizeName(input.name);
  if (!normalizedName) {
    return {
      success: false,
      configId: null,
      status: "error",
      tools: [],
      message: "MCP server name is required.",
      error: "invalid_name",
    };
  }

  if (input.type === "stdio" && !(input.command ?? "").trim()) {
    return {
      success: false,
      configId: null,
      status: "error",
      tools: [],
      message: "stdio MCP config requires a launch command.",
      error: "missing_command",
    };
  }

  if (input.type === "sse" && !(input.url ?? "").trim()) {
    return {
      success: false,
      configId: null,
      status: "error",
      tools: [],
      message: "sse MCP config requires a URL.",
      error: "missing_url",
    };
  }

  const securityValidation = validateMcpProvisionInput(input);
  if (securityValidation.ok === false) {
    return {
      success: false,
      configId: null,
      status: "error",
      tools: [],
      message: `MCP server '${normalizedName}' was blocked by security policy.`,
      error: securityValidation.error,
    };
  }

  if (!input.approved) {
    const approval = await createApprovalRequest({
      officeId: input.officeId,
      toolId: `mcp_stdio:${normalizedName}`,
      riskLevel: "high",
      actionSummary: `Activate MCP server '${normalizedName}'`,
      arguments: {
        name: normalizedName,
        type: input.type,
        command: input.type === "stdio" ? input.command ?? null : null,
        url: input.type === "sse" ? input.url ?? null : null,
        envKeys: Object.keys(input.envVars ?? {}),
      },
      resource: normalizedName,
      metadata: {
        actionType: "mcp_provision",
        mcpProvision: {
          name: normalizedName,
          type: input.type,
          command: input.command ?? null,
          url: input.url ?? null,
          envVars: redactSensitiveValue(input.envVars ?? {}),
        },
      },
    });
    return {
      success: false,
      configId: null,
      status: "testing",
      tools: [],
      message: `MCP server '${normalizedName}' requires approval before activation.`,
      error: "approval_required",
      approvalRequired: true,
      approvalRequestId: approval.id,
    };
  }

  if (!isServerSupabaseConfigured) {
    return {
      success: false,
      configId: null,
      status: "error",
      tools: [],
      message: "Supabase is not configured; cannot persist MCP configuration.",
      error: "supabase_not_configured",
    };
  }

  const encryptedEnv = encryptEnvVars(input.envVars ?? {});
  const candidatePayload = {
    office_id: input.officeId?.trim() || null,
    name: normalizedName,
    type: input.type,
    command: input.type === "stdio" ? (input.command ?? "").trim() : null,
    url: input.type === "sse" ? (input.url ?? "").trim() : null,
    env_vars: encryptedEnv,
    status: "testing" as McpConfigStatus,
    last_error: null,
    metadata: {
      template: normalizedName,
      approved: true,
      approvalRequestId: input.approvalRequestId ?? null,
      envAllowlist: getTemplatePolicy(normalizedName)?.allowedEnv ?? [],
      activatedAt: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("mcp_configs")
    .upsert(candidatePayload, { onConflict: "office_id,name" })
    .select("id, office_id, name, type, command, url, env_vars, status, last_error, updated_at")
    .single();

  if (error || !data) {
    const reason = error?.message ?? "mcp_config_upsert_failed";
    return {
      success: false,
      configId: null,
      status: "error",
      tools: [],
      message: `Failed to save MCP config '${normalizedName}'.`,
      error: reason,
    };
  }

  const row = normalizeMcpConfigRow(data as Record<string, unknown>);
  if (!row) {
    return {
      success: false,
      configId: null,
      status: "error",
      tools: [],
      message: "Saved MCP config could not be normalized.",
      error: "config_normalization_failed",
    };
  }

  try {
    const runtime = await getRuntimeForConfig(row, { forceRefresh: true });
    if (!runtime) {
      throw new Error("runtime_connection_failed");
    }

    const toolNames = runtime.tools.map((tool) => tool.alias);

    if (toolNames.length === 0) {
      await updateMcpConfigStatus(row.id, "error", "runtime_connected_but_no_tools_exposed");
      throw new Error("runtime_connected_but_no_tools_exposed");
    }

    await updateMcpConfigStatus(row.id, "active", null);
    await upsertMcpSkillCatalog(row.name, row.type, toolNames, row.officeId);

    return {
      success: true,
      configId: row.id,
      status: "active",
      tools: toolNames,
      message: `MCP server '${row.name}' is connected and active with ${toolNames.length} tool(s).`,
      error: null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "mcp_connection_failed";
    await updateMcpConfigStatus(row.id, "error", reason);
    return {
      success: false,
      configId: row.id,
      status: "error",
      tools: [],
      message: `MCP server '${row.name}' failed connection test.`,
      error: reason,
    };
  }
};

export const activateMcpProvisionFromApproval = async (
  approval: ApprovalRequest
): Promise<ProvisionMcpServerResult | null> => {
  const metadata = approval.metadata as {
    mcpProvision?: {
      name?: unknown;
      type?: unknown;
      command?: unknown;
      url?: unknown;
      envVars?: unknown;
    };
  };
  const provision = metadata.mcpProvision;
  if (!provision) return null;

  const name = typeof provision.name === "string" ? provision.name : approval.resource ?? approval.toolId;
  const type = provision.type === "sse" ? "sse" : "stdio";
  const envVars =
    provision.envVars && typeof provision.envVars === "object" && !Array.isArray(provision.envVars)
      ? Object.fromEntries(
          Object.entries(provision.envVars as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "[REDACTED]"
          )
        )
      : {};

  return provisionMcpServer({
    officeId: approval.officeId,
    name,
    type,
    command: typeof provision.command === "string" ? provision.command : null,
    url: typeof provision.url === "string" ? provision.url : null,
    envVars,
    approved: true,
    approvalRequestId: approval.id,
  });
};

/** Return names of currently active MCP servers for a given office (used to populate agent state) */
export const getInstalledMcpNames = async (officeId?: string | null): Promise<string[]> => {
  const configs = await loadMcpConfigs(["active"], officeId);
  return configs.map((c) => c.name);
};
