import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DynamicTool } from "@langchain/core/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadServerEnv } from "@/lib/config/serverEnv";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

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
}

export interface ProvisionMcpServerResult {
  success: boolean;
  configId: string | null;
  status: McpConfigStatus;
  tools: string[];
  message: string;
  error: string | null;
}

const MCP_CLIENT_NAME = "llmtims-mcp-client";
const MCP_CLIENT_VERSION = "1.0.0";
const MCP_CONNECT_TIMEOUT_MS = 12_000;
const MCP_CALL_TIMEOUT_MS = 15_000;

const runtimeCache = new Map<string, Promise<McpRuntime | null>>();

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

    return new StdioClientTransport({
      command,
      args,
      env: {
        ...(process.env as Record<string, string>),
        ...envOverrides,
      },
      stderr: "ignore",
    });
  }

  const endpoint = config.url?.trim() ?? "";
  if (!endpoint) {
    throw new Error(`mcp_sse_url_missing:${config.name}`);
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

const getRuntimeForConfig = async (
  config: McpConfigRow,
  options: { forceRefresh?: boolean } = {}
): Promise<McpRuntime | null> => {
  if (options.forceRefresh) {
    for (const key of Array.from(runtimeCache.keys())) {
      if (key.startsWith(`${config.id}:`)) {
        runtimeCache.delete(key);
      }
    }
  }

  const key = getRuntimeCacheKey(config);
  if (!runtimeCache.has(key)) {
    runtimeCache.set(
      key,
      createRuntimeForConfig(config).catch((error) => {
        console.error(`[mcp] failed to connect '${config.name}':`, error);
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
  const result = await withTimeout(
    runtime.client.callTool({
      name: tool.remoteName,
      arguments: args,
    }),
    MCP_CALL_TIMEOUT_MS,
    `${runtime.config.name}:${tool.remoteName}`
  );

  const envelope = result as { isError?: unknown };
  return {
    toolName: tool.alias,
    output: extractTextContent(result),
    isError: envelope.isError === true,
  };
};

const loadActiveRuntimes = async (officeId?: string | null): Promise<McpRuntime[]> => {
  const activeConfigs = await loadMcpConfigs(["active"], officeId);
  if (activeConfigs.length === 0) return [];

  const runtimes = await Promise.all(activeConfigs.map((config) => getRuntimeForConfig(config)));
  return runtimes.filter((runtime): runtime is McpRuntime => Boolean(runtime));
};

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
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("mcp_configs")
    .upsert(candidatePayload, { onConflict: "name" })
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
    await updateMcpConfigStatus(row.id, "active", null);
    await upsertMcpSkillCatalog(row.name, row.type, toolNames, row.officeId);

    return {
      success: true,
      configId: row.id,
      status: "active",
      tools: toolNames,
      message: `MCP server '${row.name}' is connected and active.`,
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
