import { NextRequest, NextResponse } from "next/server";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AUTONOMY_DIRECTIVE, getAgentPrompt, TEAM_RULES } from "@/lib/agents/prompts";
import {
  LLM_TOOL_RUNTIME_MODE,
  invokeAgentModel,
  type AgentInvocationResult,
} from "@/lib/agents/tools";
import { logSystemEvent } from "@/lib/agents/persistence";
import { executeRailwayCommand, parseRailwayCommand } from "@/lib/agents/railwayExecutor";
import {
  buildRoleSkillsPromptBlock,
  buildTeamSkillsPromptBlock,
  loadRoleSkillContextFromDb,
} from "@/lib/agents/skillProfiles";
import {
  routeChatIntent,
  roleLabel,
  roleLabelRu,
  type ChatAgentRole,
  type ChatTargetRole,
} from "@/lib/agents/chatRouter";
import { loadServerEnv } from "@/lib/config/serverEnv";
import { repairMojibakeDeep, repairTextForDisplay } from "@/lib/text/repairMojibake";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { buildOfficeRoomKey, DEFAULT_ROOM_KEY } from "@/lib/offices/utils";
import { provisionMcpServer } from "@/lib/mcp/client";
import {
  patchPlayerStateByRole,
  patchRoomState,
  publishTeamEvent,
  setRoleTypingState,
  syncRoleTokenUsage,
  type TeamEventScope,
} from "@/lib/agents/realtime";

loadServerEnv();

interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

type ChatScope = "auto" | "broadcast" | "targeted";

interface ChatRequestBody {
  message?: string;
  history?: ChatHistoryItem[];
  targetRole?: ChatTargetRole | string;
  scope?: ChatScope | string;
  roomKey?: string;
  officeId?: string;
  threadId?: string;
  senderName?: string;
  clientMessageId?: string;
  selectedTaskId?: string;
  selectedTaskSummary?: string;
}

interface ChatTaskRow {
  id: string;
  description: string | null;
  title?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
  office_id?: string | null;
  current_assignee?: string | null;
  assigned_agent_id?: string | null;
}

interface ChatThreadTaskContext {
  threadId: string;
  activeTaskId: string | null;
  metadata: Record<string, unknown>;
}

interface AgentContextRow {
  id: string;
  title: string | null;
  context_text: string | null;
  target_roles: string[] | null;
  target_agent_ids: string[] | null;
}

const APPROVAL_MARKERS = repairMojibakeDeep([
  "РґР°",
  "Р°РіР°",
  "СѓРіСѓ",
  "РѕРє",
  "РѕРєРµР№",
  "С…РѕСЂРѕС€Рѕ",
  "Р»Р°РґРЅРѕ",
  "РїРѕРґС…РѕРґРёС‚",
  "СЃРѕРіР»Р°СЃРµРЅ",
  "СЃРѕРіР»Р°СЃРЅР°",
  "РјРѕР¶РЅРѕ",
  "РјРѕР¶РЅРѕ Р·Р°РїСѓСЃРєР°С‚СЊ",
  "РїРѕРґС‚РІРµСЂР¶РґР°СЋ",
  "СѓС‚РІРµСЂР¶РґР°СЋ",
  "approve",
  "РЅР°С‡РёРЅР°Р№",
  "Р·Р°РїСѓСЃРєР°Р№",
  "РјРѕР¶РЅРѕ РІС‹РїРѕР»РЅСЏС‚СЊ",
  "РїРѕРґС‚РІРµСЂР¶РґР°СЋ Р·Р°РїСѓСЃРє",
  "РІРїРµСЂРµРґ",
  "РґРµР»Р°Р№С‚Рµ",
  "РЅР°С‡РёРЅР°Р№С‚Рµ",
  "РїРѕРµС…Р°Р»Рё",
  "Р·Р°РїСѓСЃРєР°РµРј",
  "СЃС‚Р°СЂС‚СѓРµРј",
  "РїСЂРёСЃС‚СѓРїР°Р№С‚Рµ",
  "go ahead",
  "lets go",
  "sounds good",
]);

const APPROVAL_NEGATION_MARKERS = repairMojibakeDeep([
  "РЅРµС‚",
  "РЅРµ РЅР°РґРѕ",
  "РЅРµ РЅСѓР¶РЅРѕ",
  "РЅРµ Р·Р°РїСѓСЃРєР°Р№",
  "РЅРµ Р·Р°РїСѓСЃРєР°С‚СЊ",
  "РЅРµ СЃРµР№С‡Р°СЃ",
  "СЃС‚РѕРї",
  "РѕС‚РјРµРЅР°",
  "cancel",
]);

const EXECUTION_MARKERS = repairMojibakeDeep([
  "Р·Р°РїСѓСЃС‚Рё РІС‹РїРѕР»РЅРµРЅРёРµ",
  "Р·Р°РїСѓСЃРєР°Р№ РІС‹РїРѕР»РЅРµРЅРёРµ",
  "СЃС‚Р°СЂС‚ РІС‹РїРѕР»РЅРµРЅРёСЏ",
  "РЅР°С‡Р°С‚СЊ РІС‹РїРѕР»РЅРµРЅРёРµ",
  "РІС‹РїРѕР»РЅСЏР№ Р·Р°РґР°С‡Сѓ",
  "start execution",
  "start run",
  "run execution",
  "execute now",
  "launch execution",
  "/execute",
  "/run",
  "/start",
]);
const CONSULTATION_MARKERS = repairMojibakeDeep([
  "РєР°Рє",
  "С‡С‚Рѕ",
  "РїРѕС‡РµРјСѓ",
  "Р·Р°С‡РµРј",
  "РїРѕРґСЃРєР°Р¶Рё",
  "РѕР±СЉСЏСЃРЅРё",
  "СЂР°СЃСЃРєР°Р¶Рё",
  "РїСЂРёРјРµСЂ",
  "РјРѕР¶РЅРѕ Р»Рё",
  "РЅСѓР¶РЅРѕ Р»Рё",
  "help",
  "explain",
  "clarify",
  "recommend",
  "how",
  "what",
  "why",
]);

const GREETING_MARKERS = repairMojibakeDeep(["РїСЂРёРІРµС‚", "Р·РґСЂР°РІСЃС‚РІСѓР№С‚Рµ", "РґРѕР±СЂС‹Р№ РґРµРЅСЊ", "РґРѕР±СЂС‹Р№ РІРµС‡РµСЂ", "hello", "hi"]);
const MCP_MARKERS = repairMojibakeDeep(["mcp", "railway", "github", "sandbox", "РєРѕРЅС‚РµР№РЅРµСЂ", "РєРѕРЅРЅРµРєС‚РѕСЂ"]);
const MCP_INFO_MARKERS = repairMojibakeDeep([
  "РєР°РєРёРµ",
  "РєР°РєРѕР№",
  "С‡С‚Рѕ РґРѕСЃС‚СѓРїРЅРѕ",
  "РєР°РєРёРµ РґРѕСЃС‚СѓРїРЅС‹",
  "РїРѕРґСЃРєР°Р¶Рё",
  "СЃРїРёСЃРѕРє",
  "РґРѕСЃС‚СѓРї",
  "configured",
  "РґРѕСЃС‚СѓРїС‹",
]);
const MCP_AUDIT_MARKERS = repairMojibakeDeep([
  "РїСЂРѕРІРµСЂСЊ",
  "РїСЂРѕРІРµСЂРєР°",
  "СЃС‚Р°С‚СѓСЃ",
  "РЅР°СЃС‚СЂРѕРµРЅ",
  "РЅР°СЃС‚СЂРѕРµРЅРѕ",
  "РЅР°СЃС‚СЂРѕР№РєР°",
  "РїРѕРґРєР»СЋС‡",
  "РІРєР»СЋС‡",
  "РґРµРІРѕРїСЃ",
  "devops",
]);
interface McpServerTemplate {
  key: string;
  displayName: string;
  type: "stdio" | "sse";
  command?: string;
  url?: string;
  requiredEnv: string[];
  summary: string;
}

interface ParsedMcpConnectCommand {
  template: McpServerTemplate;
  envVars: Record<string, string>;
}

const MCP_SERVER_TEMPLATES: Record<string, McpServerTemplate> = {
  "filesystem": {
    key: "filesystem",
    displayName: "Filesystem MCP",
    type: "stdio",
    command: "npx.cmd -y @modelcontextprotocol/server-filesystem .",
    requiredEnv: [],
    summary: "Local file operations in isolated workspace scope.",
  },
  "google-search": {
    key: "google-search",
    displayName: "Google Search MCP",
    type: "stdio",
    command: "npx.cmd -y @modelcontextprotocol/server-google-search",
    requiredEnv: ["GOOGLE_API_KEY"],
    summary: "Web search connector for research and validation steps.",
  },
};

const findTemplateByMessage = (messageLower: string): McpServerTemplate | null => {
  const normalized = messageLower.trim();
  if (!normalized) return null;

  const googleConnectPhrases = repairMojibakeDeep([
    "подключи google search",
    "подключи поиск google",
    "настрой google search",
    "настрой поиск google",
    "google search mcp",
    "google поиск mcp",
    "гугл поиск mcp",
  ]);
  const filesystemConnectPhrases = repairMojibakeDeep([
    "подключи filesystem",
    "подключи файловый",
    "настрой filesystem",
    "настрой файловый сервер",
    "filesystem mcp",
    "файловый mcp",
  ]);

  if (containsAnyPhrase(normalized, googleConnectPhrases)) {
    return MCP_SERVER_TEMPLATES["google-search"];
  }

  if (containsAnyPhrase(normalized, filesystemConnectPhrases)) {
    return MCP_SERVER_TEMPLATES.filesystem;
  }

  return null;
};

const parseEnvKeyValuePairs = (chunk: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const pairRegex = /([A-Z0-9_]+)\s*=\s*("([^"]*)"|'([^']*)'|[^\s]+)/gi;
  let match: RegExpExecArray | null = pairRegex.exec(chunk);
  while (match) {
    const key = match[1]?.trim().toUpperCase();
    const rawValue = (match[3] ?? match[4] ?? match[2] ?? "").trim();
    if (key && rawValue) {
      result[key] = rawValue;
    }
    match = pairRegex.exec(chunk);
  }
  return result;
};

const containsAnyPhrase = (text: string, phrases: string[]): boolean => {
  const normalized = text.toLowerCase();
  return phrases.some((phrase) => normalized.includes(phrase.toLowerCase()));
};

const parseMcpConnectCommand = (message: string): ParsedMcpConnectCommand | null => {
  const trimmed = message.trim();
  const commandMatch = trimmed.match(/^\/mcp-connect\s+([a-z0-9_-]+)\s*(.*)$/i);
  if (!commandMatch) return null;

  const templateKey = String(commandMatch[1] ?? "").toLowerCase();
  const template = MCP_SERVER_TEMPLATES[templateKey];
  if (!template) return null;

  const envChunk = String(commandMatch[2] ?? "").trim();
  return {
    template,
    envVars: parseEnvKeyValuePairs(envChunk),
  };
};

const getMissingEnvKeys = (
  template: McpServerTemplate,
  envVars: Record<string, string>
): string[] =>
  template.requiredEnv.filter((envKey) => {
    const value = envVars[envKey];
    return typeof value !== "string" || value.trim().length === 0;
  });

const buildMcpConnectionInstruction = (
  template: McpServerTemplate,
  missingKeys: string[]
): string => {
  const required = template.requiredEnv.length > 0
    ? template.requiredEnv.join(", ")
    : "No required ENV keys.";
  const missing = missingKeys.length > 0
    ? `Missing ENV keys: ${missingKeys.join(", ")}.`
    : "All required ENV keys are provided.";
  const exampleSuffix = template.requiredEnv.length > 0
    ? ` ${template.requiredEnv.map((key) => `${key}=<value>`).join(" ")}`
    : "";

  return [
    `DevOps: preparing MCP connection '${template.key}' (${template.displayName}).`,
    `Summary: ${template.summary}`,
    `Required ENV: ${required}`,
    missing,
    `Provide credentials with command: /mcp-connect ${template.key}${exampleSuffix}`,
    "Values are stored encrypted in mcp_configs after submit.",
  ].join("\n");
};
const roleHandleByRole: Record<string, string> = {
  PM: "pm",
  Developer: "developer",
  QA: "qa",
  DevOps: "devops",
};

const getRoleHandle = (role: string) => {
  return roleHandleByRole[role] ?? role.toLowerCase().replace(/\s+/g, "");
};

type MpcConnectionStatus = {
  id: "github" | "railway" | "sandbox";
  title: string;
  configured: boolean;
  authHint: string;
  policy: string;
  configuredKey: string | null;
  runtime: "live" | "diagnostic";
  note: string;
};

type RailwayProbeMode =
  | "no_token"
  | "user_token_valid"
  | "project_token_valid"
  | "token_present_unverified"
  | "token_invalid";

interface RailwayProbeResult {
  mode: RailwayProbeMode;
  summary: string;
  details: string[];
}

const resolveFirstEnvKey = (...keys: string[]): string | null => {
  const found = keys.find((key) => Boolean(process.env[key]));
  return found ?? null;
};

const resolveMcpConnectionStatus = (): MpcConnectionStatus[] => {
  const githubConfiguredKey = resolveFirstEnvKey(
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_APP_ID",
    "GITHUB_PRIVATE_KEY"
  );
  const railwayConfiguredKey = resolveFirstEnvKey(
    "RAILWAY_TOKEN",
    "RAILWAY_API_TOKEN",
    "RAILWAY_API_KEY"
  );
  const sandboxConfiguredKey = resolveFirstEnvKey("E2B_API_KEY");
  const githubConfigured = Boolean(githubConfiguredKey);
  const railwayConfigured = Boolean(railwayConfiguredKey);
  const sandboxConfigured = Boolean(sandboxConfiguredKey);

  return repairMojibakeDeep([
    {
      id: "github",
      title: "GitHub MCP",
      configured: githubConfigured,
      authHint: githubConfigured
        ? `РєР»СЋС‡ РЅР°Р№РґРµРЅ РІ РѕРєСЂСѓР¶РµРЅРёРё (${githubConfiguredKey})`
        : "РєР»СЋС‡ РЅРµ РЅР°Р№РґРµРЅ РІ РѕРєСЂСѓР¶РµРЅРёРё",
      policy:
        "РџСЂР°РІРєРё РґРѕРїСѓСЃРєР°СЋС‚СЃСЏ С‚РѕР»СЊРєРѕ РІ СЏРІРЅРѕ РѕРґРѕР±СЂРµРЅРЅРѕРј СЂРµРїРѕР·РёС‚РѕСЂРёРё.",
      configuredKey: githubConfiguredKey,
      runtime: "diagnostic",
      note: "РљР»СЋС‡ РјРѕР¶РµС‚ Р±С‹С‚СЊ РґРѕСЃС‚СѓРїРµРЅ, РЅРѕ РїСЂСЏРјС‹Рµ GitHub-РґРµР№СЃС‚РІРёСЏ РЅРµ РїРѕРґРєР»СЋС‡РµРЅС‹ Рє live-РєРѕРЅРЅРµРєС‚РѕСЂСѓ РІРЅСѓС‚СЂРё AI-Р°РіРµРЅС‚Р°.",
    },
    {
      id: "railway",
      title: "Railway MCP",
      configured: railwayConfigured,
      authHint: railwayConfigured
        ? `РєР»СЋС‡ РЅР°Р№РґРµРЅ РІ РѕРєСЂСѓР¶РµРЅРёРё (${railwayConfiguredKey})`
        : "РєР»СЋС‡ РЅРµ РЅР°Р№РґРµРЅ РІ РѕРєСЂСѓР¶РµРЅРёРё",
      policy:
        "РЎСѓС‰РµСЃС‚РІСѓСЋС‰РёРµ СЃРµСЂРІРёСЃС‹ СЃС‡РёС‚Р°СЋС‚СЃСЏ read-only; РјРµРЅСЏС‚СЊ РјРѕР¶РЅРѕ С‚РѕР»СЊРєРѕ managed service РїРѕРґ Р·Р°РґР°С‡Сѓ Рё РїРѕСЃР»Рµ РїРѕРґС‚РІРµСЂР¶РґРµРЅРёСЏ.",
      configuredKey: railwayConfiguredKey,
      runtime: "live",
      note: "Railway-РєРѕРјР°РЅРґС‹ РѕР±СЂР°Р±Р°С‚С‹РІР°СЋС‚СЃСЏ РѕС‚РґРµР»СЊРЅС‹Рј executor-СЃР»РѕРµРј, Р° РЅРµ LLM stub-tool РІС‹Р·РѕРІР°РјРё.",
    },
    {
      id: "sandbox",
      title: "Sandbox Execution",
      configured: sandboxConfigured,
      authHint: sandboxConfigured
        ? `РєР»СЋС‡ РЅР°Р№РґРµРЅ РІ РѕРєСЂСѓР¶РµРЅРёРё (${sandboxConfiguredKey})`
        : "РєР»СЋС‡ РЅРµ РЅР°Р№РґРµРЅ РІ РѕРєСЂСѓР¶РµРЅРёРё",
      policy:
        "РР·РѕР»СЏС†РёСЏ РґРѕРїСѓСЃРєР°РµС‚СЃСЏ С‚РѕР»СЊРєРѕ С‡РµСЂРµР· РѕС‚РґРµР»СЊРЅС‹Р№ sandbox-РєРѕРЅС‚СѓСЂ Рё Р±РµР· РІРѕР·РґРµР№СЃС‚РІРёСЏ РЅР° СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёРµ СЃРµСЂРІРёСЃС‹.",
      configuredKey: sandboxConfiguredKey,
      runtime: "diagnostic",
      note: "РР·РѕР»СЏС†РёРѕРЅРЅР°СЏ РїРѕР»РёС‚РёРєР° РµСЃС‚СЊ, РЅРѕ РїСЂСЏРјРѕР№ sandbox-РєРѕРЅРЅРµРєС‚РѕСЂ РІ СЌС‚РѕРј AI-Р°РіРµРЅС‚Рµ РЅРµ РїРѕРґРєР»СЋС‡РµРЅ.",
    },
  ]);
};

const normalizeHistory = (history: unknown): ChatHistoryItem[] => {
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      (item): item is ChatHistoryItem =>
        typeof item === "object" &&
        item !== null &&
        ((item as ChatHistoryItem).role === "user" || (item as ChatHistoryItem).role === "assistant") &&
        typeof (item as ChatHistoryItem).content === "string"
    )
    .slice(-8);
};

const getTeamRoster = async (officeId?: string | null) => {
  const defaults: Record<string, string> = repairMojibakeDeep({
    PM: "РђР№РіРµСЂС–Рј",
    Developer: "РђР»РµРєСЃРµР№",
    QA: "РђР»СѓР°",
    DevOps: "РР»СЊСЏ",
  });

  if (!isServerSupabaseConfigured) {
    return defaults;
  }

  try {
    let query = supabase.from("agents").select("name, role");
    if (officeId) {
      query = query.eq("office_id", officeId);
    }

    const { data } = await query;
    for (const item of data ?? []) {
      if (typeof item.role !== "string" || !item.role.trim()) continue;
      defaults[item.role] =
        typeof item.name === "string" && item.name.trim().length > 0 ? item.name : item.role;
    }
  } catch {
    return defaults;
  }

  return defaults;
};

const normalizeRoleKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");

const normalizeUuidArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item));
};

const normalizeRoleArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
};

const resolveResponderAgentId = async (
  responderRole: string,
  officeId?: string | null
): Promise<string | null> => {
  if (!isServerSupabaseConfigured || !officeId) return null;

  const { data, error } = await supabase
    .from("agents")
    .select("id")
    .eq("office_id", officeId)
    .eq("role", responderRole)
    .limit(1);

  if (error) {
    console.error("[chat.context] failed to resolve responder agent id:", error.message);
    return null;
  }

  const row = Array.isArray(data) ? data[0] : null;
  return typeof row?.id === "string" ? row.id : null;
};

const buildAgentContextPromptBlock = async (
  officeId: string | null,
  responderRole: string,
  responderAgentId: string | null
): Promise<string> => {
  if (!isServerSupabaseConfigured || !officeId) return "";

  const { data, error } = await supabase
    .from("agent_context_items")
    .select("id, title, context_text, target_roles, target_agent_ids")
    .eq("office_id", officeId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(64);

  if (error) {
    console.error("[chat.context] failed to load agent contexts:", error.message);
    return "";
  }

  const normalizedResponderRole = normalizeRoleKey(responderRole);
  const normalizedResponderAgentId = responderAgentId?.toLowerCase() ?? null;
  const rows = (data ?? []) as AgentContextRow[];
  const lines: string[] = [];

  for (const row of rows) {
    const contextText = String(row.context_text ?? "").trim();
    if (!contextText) continue;

    const targetRoles = normalizeRoleArray(row.target_roles);
    const targetAgentIds = normalizeUuidArray(row.target_agent_ids);
    const appliesGlobally = targetRoles.length === 0 && targetAgentIds.length === 0;
    const appliesByRole = targetRoles.some(
      (role) => normalizeRoleKey(role) === normalizedResponderRole
    );
    const appliesByAgent =
      normalizedResponderAgentId !== null &&
      targetAgentIds.some((agentId) => agentId === normalizedResponderAgentId);

    if (!appliesGlobally && !appliesByRole && !appliesByAgent) {
      continue;
    }

    const title = repairTextForDisplay(String(row.title ?? "").trim()) || "Контекст";
    lines.push(`- ${title}: ${contextText}`);
  }

  if (lines.length === 0) return "";

  return [
    "=== AGENT CONTEXT KNOWLEDGE ===",
    "Apply these constraints and background facts when answering:",
    ...lines,
  ].join("\n");
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("LLM_TIMEOUT")), timeoutMs);
  });

  return Promise.race([promise, timeout]);
};

const hasMarker = (text: string, markers: string[]): boolean => {
  return markers.some((marker) => text.includes(marker));
};

const stripPunctuation = (value: string): string => {
  return value.replace(/[.,!?;:()[\]{}\"']/g, " ").replace(/\s+/g, " ").trim();
};

const hasWholePhrase = (text: string, phrase: string): boolean => {
  const normalizedPhrase = stripPunctuation(phrase.toLowerCase());
  if (!normalizedPhrase) return false;

  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\s)${escaped}(?=$|\\s)`);
  return pattern.test(text);
};

const detectApproval = (text: string): boolean => {
  const normalized = stripPunctuation(text.toLowerCase());
  if (!normalized) return false;
  if (APPROVAL_NEGATION_MARKERS.some((marker) => hasWholePhrase(normalized, marker))) {
    return false;
  }

  return APPROVAL_MARKERS.some((marker) => hasWholePhrase(normalized, marker));
};

const isShortApprovalOnlyMessage = (text: string): boolean => {
  const normalized = stripPunctuation(text.toLowerCase());
  if (!normalized) return false;
  if (normalized.length > 48) return false;
  const words = normalized.split(" ").filter(Boolean);
  if (words.length > 6) return false;
  return detectApproval(normalized);
};

const resolveApprovedTaskInput = (
  message: string,
  history: ChatHistoryItem[],
  selectedTaskSummary?: string | null
): string => {
  if (!isShortApprovalOnlyMessage(message)) return message;

  const selectedContext = selectedTaskSummary?.trim();
  if (selectedContext && selectedContext.length > 0) {
    return selectedContext;
  }

  const previousUserMessage = [...history]
    .reverse()
    .find((item) => item.role === "user" && !isShortApprovalOnlyMessage(item.content));

  const fallback = previousUserMessage?.content?.trim();
  if (fallback && fallback.length > 0) return fallback;
  return message;
};

const createChatTaskTitle = (input: string): string => {
  const normalized = input.replace(/\s+/g, " ").trim();
  const short = normalized.slice(0, 72).trim();
  if (!short) return "Задача из чата";
  return `Задача из чата: ${short}`;
};

const CHAT_HANDOFF_INTENT_PATTERN =
  /(передаю|передал|делегирую|возьми дальше|handoff|передаю задачу|отправляю|take over|passing to)/i;

const toMetadataRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const resolveThreadTaskContext = async (
  threadId?: string | null,
  officeId?: string | null
): Promise<ChatThreadTaskContext | null> => {
  if (!isServerSupabaseConfigured || !threadId || !officeId) return null;

  const { data, error } = await supabase
    .from("chat_threads")
    .select("id, metadata")
    .eq("id", threadId)
    .eq("office_id", officeId)
    .maybeSingle();

  if (error || !data?.id) {
    return null;
  }

  const metadata = toMetadataRecord(data.metadata);
  const activeTaskId =
    typeof metadata.activeTaskId === "string" && metadata.activeTaskId.trim().length > 0
      ? metadata.activeTaskId.trim()
      : null;

  return {
    threadId: String(data.id),
    activeTaskId,
    metadata,
  };
};

const bindThreadToTask = async (
  threadId: string,
  officeId: string,
  taskId: string
): Promise<void> => {
  if (!isServerSupabaseConfigured) return;

  const context = await resolveThreadTaskContext(threadId, officeId);
  const existingMetadata = context?.metadata ?? {};

  await supabase
    .from("chat_threads")
    .update({
      metadata: {
        ...existingMetadata,
        activeTaskId: taskId,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", threadId)
    .eq("office_id", officeId);
};

const attachTaskIdToChatMessage = async (
  threadId: string,
  officeId: string,
  clientMessageId: string | null,
  taskId: string
): Promise<void> => {
  if (!isServerSupabaseConfigured || !clientMessageId) return;

  await supabase
    .from("chat_messages")
    .update({ task_id: taskId })
    .eq("thread_id", threadId)
    .eq("office_id", officeId)
    .eq("client_message_id", clientMessageId)
    .eq("sender", "user");
};

const ensureActionableTaskContext = async ({
  officeId,
  threadId,
  selectedTaskId,
  activeTaskId,
  responderRole,
  initialMessage,
}: {
  officeId: string | null;
  threadId: string | null;
  selectedTaskId: string | null;
  activeTaskId: string | null;
  responderRole: string;
  initialMessage: string;
}): Promise<string | null> => {
  if (!isServerSupabaseConfigured || !officeId) return selectedTaskId ?? activeTaskId ?? null;

  const existingTaskId = selectedTaskId ?? activeTaskId ?? null;
  if (existingTaskId) {
    if (threadId) {
      await bindThreadToTask(threadId, officeId, existingTaskId);
    }
    return existingTaskId;
  }

  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("office_id", officeId)
    .eq("role", responderRole)
    .limit(1)
    .maybeSingle();

  const taskPayload = {
    title: createChatTaskTitle(initialMessage),
    description: initialMessage,
    status: "pending",
    office_id: officeId,
    current_assignee: responderRole,
    assigned_agent_id: typeof agentRow?.id === "string" ? agentRow.id : null,
    metadata: {
      source: "chat",
      threadId,
    },
  };

  const { data: createdTask, error: taskError } = await supabase
    .from("tasks")
    .insert(taskPayload)
    .select("id")
    .single();

  if (taskError || !createdTask?.id) {
    throw taskError ?? new Error("chat_task_insert_failed");
  }

  if (threadId) {
    await bindThreadToTask(threadId, officeId, createdTask.id as string);
  }

  return createdTask.id as string;
};

const detectExecutionIntent = (text: string, hasApproval: boolean): boolean => {
  const normalized = text.trim().toLowerCase();
  if (!normalized || hasApproval) return false;

  const hasConsultingIntent =
    normalized.includes("?") || CONSULTATION_MARKERS.some((marker) => normalized.includes(marker));
  if (hasConsultingIntent) return false;

  if (hasMarker(normalized, EXECUTION_MARKERS)) return true;
  if (/^\/(execute|run|start)\b/.test(normalized)) return true;
  if (/^(start|run|execute|launch)\s+(now|task|workflow|process)$/.test(normalized)) return true;
  return false;
};

const detectRosterMentionRole = (
  message: string,
  roster: Record<ChatAgentRole, string>
): ChatTargetRole | null => {
  const mentions = message
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim().replace(/[,:;.!?]+$/g, ""))
    .filter((token) => token.startsWith("@") && token.length > 1)
    .map((token) => token.slice(1));
  if (mentions.length === 0) return null;

  for (const mention of mentions) {
    if (mention === "all") return "All";

    for (const role of Object.keys(roster) as ChatAgentRole[]) {
      const displayName = roster[role].toLowerCase();
      const compactName = displayName.replace(/\s+/g, "");
      const firstName = displayName.split(/\s+/)[0];
      if (
        mention === getRoleHandle(role) ||
        mention === displayName ||
        mention === compactName ||
        mention === firstName
      ) {
        return role;
      }
    }
  }

  return null;
};

const isGreetingMessage = (text: string) => GREETING_MARKERS.some((marker) => text.includes(marker));
const isMcpQuestion = (text: string) => {
  if (text.includes("mcp")) return true;

  const hasMcpDomainKeyword = MCP_MARKERS.some((marker) => text.includes(marker));
  const hasInfoIntent =
    text.includes("?") ||
    MCP_INFO_MARKERS.some((marker) => text.includes(marker)) ||
    MCP_AUDIT_MARKERS.some((marker) => text.includes(marker));
  return hasMcpDomainKeyword && hasInfoIntent;
};

type McpFocus = MpcConnectionStatus["id"] | "all";

const detectMcpFocus = (text: string): McpFocus => {
  const hasGithub = text.includes("github") || text.includes("гитхаб") || text.includes("репозитор");
  const hasRailway = text.includes("railway") || text.includes("рейлвей");
  const hasSandbox = text.includes("sandbox") || text.includes("песочниц");

  const focused = [
    hasGithub ? "github" : null,
    hasRailway ? "railway" : null,
    hasSandbox ? "sandbox" : null,
  ].filter((value): value is MpcConnectionStatus["id"] => Boolean(value));

  if (focused.length === 1) return focused[0];
  return "all";
};

const resolveChatScope = (
  requestedScope: string | undefined,
  intent: { broadcast: boolean; targetRole: ChatTargetRole }
): TeamEventScope => {
  if (requestedScope === "broadcast") return "broadcast";
  if (requestedScope === "targeted") return "targeted";
  if (intent.broadcast || intent.targetRole === "All") return "broadcast";
  return "targeted";
};

interface RoomSnapshot {
  mode: string;
  taskStatus: string;
  pendingTaskId: string | null;
}

const readRoomSnapshot = async (roomKey: string): Promise<RoomSnapshot> => {
  if (!isServerSupabaseConfigured) {
    return {
      mode: "discussion",
      taskStatus: "pending",
      pendingTaskId: null,
    };
  }

  try {
    const { data } = await supabase
      .from("room_state")
      .select("mode, task_status, pending_task_id")
      .eq("room_key", roomKey)
      .maybeSingle();

    return {
      mode: String(data?.mode ?? "discussion"),
      taskStatus: String(data?.task_status ?? "pending"),
      pendingTaskId: typeof data?.pending_task_id === "string" ? data.pending_task_id : null,
    };
  } catch {
    return {
      mode: "discussion",
      taskStatus: "pending",
      pendingTaskId: null,
    };
  }
};

const hasActiveExecution = (snapshot: RoomSnapshot): boolean => {
  if (!snapshot.pendingTaskId) return false;
  return (
    snapshot.mode === "execution" ||
    snapshot.taskStatus === "in_progress" ||
    snapshot.taskStatus === "review"
  );
};

const buildClarification = (targetRole: ChatTargetRole): string => {
  const target =
    targetRole === "All" || targetRole === "Auto"
      ? "команды"
      : `роли ${roleLabelRu(targetRole as ChatAgentRole)}`;

  return (
    `Короткое уточнение для ${target}:\n` +
    "1) Что обязательно должно быть в первой версии?\n" +
    "2) Делаем сразу MVP и потом улучшаем итерациями?\n" +
    'Если не хотите уточнять детали, напишите: "делайте на ваше усмотрение", и команда начнет с базового варианта без лишних вопросов.'
  );
};

const buildApprovalRequest = (
  targetRole: ChatTargetRole,
  roster: Record<ChatAgentRole, string>
): string => {
  const destination =
    targetRole === "All"
      ? "всей команды"
      : targetRole === "Auto"
        ? "PM"
        : `${roleLabelRu(targetRole as ChatAgentRole)} (${roster[targetRole as ChatAgentRole]})`;

  return (
    `Принято. Запрос направлен для ${destination}.\n` +
    "Сначала обсуждаем и согласуем подход.\n" +
    'Для старта выполнения можно написать: "да", "ок", "подходит" или "подтверждаю запуск".'
  );
};

const buildFormalGreeting = (responderName: string): string => {
  return `Здравствуйте. На связи ${responderName}. Готов(а) к формальному обсуждению задачи.`;
};

const PM_OVERQUESTION_MARKERS = repairMojibakeDeep([
  "Р±СЋРґР¶РµС‚",
  "СЃСЂРѕРє",
  "РґРµРґР»Р°Р№РЅ",
  "С†РµР»РµРІР°СЏ Р°СѓРґРёС‚РѕСЂРёСЏ",
  "РєРѕРЅС‚РµРЅС‚",
  "РїСЂРёРјРµСЂС‹ СЃР°Р№С‚РѕРІ",
  "Р»РѕРіРѕС‚РёРї",
  "С„РѕС‚РѕРіСЂР°С„РёРё",
  "РїСЂРёРјРµСЂ",
]);

const maybeSimplifyPmReply = (reply: string): string => {
  const normalized = reply.toLowerCase();
  const markerHits = PM_OVERQUESTION_MARKERS.reduce((sum, marker) => {
    return sum + (normalized.includes(marker) ? 1 : 0);
  }, 0);
  const hasLongQuestionnaire =
    markerHits >= 3 &&
    (normalized.includes("1)") || normalized.includes("1.") || normalized.includes("*"));

  if (!hasLongQuestionnaire) return reply;

  return (
    "Принято. Упростим: запускаем MVP без обсуждения бюджета и сроков.\n" +
    "План:\n" +
    "1) PM фиксирует структуру и стиль.\n" +
    "2) Developer собирает первую рабочую версию.\n" +
    "3) QA быстро проверяет и дает список правок.\n" +
    "4) DevOps публикует demo.\n" +
    "Если нет дополнительных требований, начинаем сразу на нашем усмотрении."
  );
};

const RAILWAY_GRAPHQL_ENDPOINT =
  process.env.RAILWAY_GRAPHQL_ENDPOINT?.trim() || "https://backboard.railway.com/graphql/v2";

type RailwayAuthHeaderMode = "bearer" | "project_access_token" | "auto";

const railwayGraphqlRequest = async (
  token: string,
  query: string,
  variables?: Record<string, unknown>,
  timeoutMs = 5000,
  authMode: RailwayAuthHeaderMode = "auto"
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> => {
  const modes: RailwayAuthHeaderMode[] =
    authMode === "auto" ? ["bearer", "project_access_token"] : [authMode];

  for (const mode of modes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (mode === "project_access_token") {
        headers["Project-Access-Token"] = token;
      } else {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: controller.signal,
      });

      const json = (await response.json().catch(() => null)) as
        | { data?: Record<string, unknown>; errors?: Array<{ message?: string }> }
        | null;

      if (!response.ok) {
        if (mode === modes[modes.length - 1]) {
          return { ok: false, error: `HTTP ${response.status}` };
        }
        continue;
      }

      if (json?.errors?.length) {
        const message = String(json.errors[0]?.message ?? "GraphQL error");
        const isAuthError =
          message.toLowerCase().includes("not authorized") ||
          message.toLowerCase().includes("unauthorized");
        if (isAuthError && mode !== modes[modes.length - 1]) {
          continue;
        }
        return { ok: false, error: message };
      }

      return { ok: true, data: json?.data ?? {} };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "network error";
      if (mode === modes[modes.length - 1]) {
        return { ok: false, error: reason };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, error: "authorization failed" };
};

const probeRailwayAccess = async (connections: MpcConnectionStatus[]): Promise<RailwayProbeResult> => {
  const railway = connections.find((connection) => connection.id === "railway");
  if (!railway?.configured || !railway.configuredKey) {
    return {
      mode: "no_token",
      summary: "Ключ Railway не найден в ENV.",
      details: [
        "Добавьте RAILWAY_TOKEN или RAILWAY_API_TOKEN (поддерживается RAILWAY_API_KEY).",
      ],
    };
  }

  const token = process.env[railway.configuredKey];
  if (!token) {
    return {
      mode: "no_token",
      summary: `Переменная ${railway.configuredKey} указана, но значение пустое.`,
      details: ["Проверьте ENV и перезапустите сервис."],
    };
  }

  const meProbe = await railwayGraphqlRequest(
    token,
    "query { me { id name email } }"
  );

  const meNode = meProbe.data?.me as { id?: string } | undefined;
  if (meProbe.ok && typeof meNode?.id === "string" && meNode.id.length > 0) {
    return {
      mode: "user_token_valid",
      summary: "Railway user-token валиден (query me проходит).",
      details: [
        "Можно работать через account scope.",
        "Следующий шаг: создавать отдельный environment/service под задачу.",
      ],
    };
  }

  const projectId =
    process.env.RAILWAY_PROJECT_ID?.trim() ||
    process.env.RAILWAY_PROJECT?.trim() ||
    process.env.RAILWAY_PROJECT_NAME?.trim() ||
    "";

  if (projectId) {
    const projectProbe = await railwayGraphqlRequest(
      token,
      "query($id: String!) { project(id: $id) { id name } }",
      { id: projectId }
    );
    const projectNode = projectProbe.data?.project as { id?: string } | undefined;
    if (projectProbe.ok && typeof projectNode?.id === "string" && projectNode.id.length > 0) {
      return {
        mode: "project_token_valid",
        summary: "Railway project-token валиден (project scope доступен).",
        details: [
          `Проект: ${projectNode.id}`,
          "Можно создавать или менять сервисы только в рамках указанного проекта.",
        ],
      };
    }
  }

  const lowerError = String(meProbe.error ?? "").toLowerCase();
  if (lowerError.includes("unauthorized") || lowerError.includes("not authorized")) {
    return {
      mode: "token_present_unverified",
      summary:
        "Токен есть, но query me не прошел (возможен project-token режим или невалидный токен).",
      details: [
        "Если это project-token: задайте RAILWAY_PROJECT_ID и повторите project-scope probe.",
        "Если это user-token: перевыпустите токен и проверьте whoami/me.",
      ],
    };
  }

  return {
    mode: "token_invalid",
    summary: "Railway токен не прошел проверку.",
    details: [
      `Ошибка probe: ${meProbe.error ?? "unknown"}`,
      "Проверьте токен, права и сетевой доступ в runtime.",
    ],
  };
};

const buildRailwayDevOpsChecklist = (
  configured: boolean,
  probe: RailwayProbeResult | null = null
): string => {
  const probeSummary = probe ? `Railway probe: ${probe.summary}` : "Railway probe: не запускался.";
  const compactProbeDetails = probe?.details?.slice(0, 3) ?? [];

  if (configured) {
    return [
      "DevOps verdict: Railway готов к работе только после preflight.",
      probeSummary,
      ...compactProbeDetails.map((item) => `- ${item}`),
      "Короткий порядок:",
      "1) Проверить `railway --version` и `railway whoami`.",
      "2) Проверить API-доступ через `me` или `project(id)`.",
      "3) Работать только в отдельном managed service/environment под задачу.",
      "4) Любой deploy или env change выполнять только после подтверждения.",
    ].join("\n");
  }

  return [
    "DevOps verdict: Railway пока заблокирован.",
    probeSummary,
    ...compactProbeDetails.map((item) => `- ${item}`),
    "Что исправить:",
    "1) Добавить валидный Railway token в ENV.",
    "2) Проверить project scope и `RAILWAY_PROJECT_ID`.",
    "3) Подтвердить CLI/API-доступ до старта задачи.",
  ].join("\n");
};

const buildMcpCapabilitiesMessage = (
  connections: MpcConnectionStatus[],
  focus: McpFocus,
  railwayProbe: RailwayProbeResult | null = null
): string => {
  const selected = focus === "all" ? connections : connections.filter((connection) => connection.id === focus);
  const detailLines = selected.map((connection, index) => {
    const runtimeLabel = connection.runtime === "live" ? "live" : "diagnostic";
    const statusLabel = connection.configured ? "ключ найден" : "ключ не найден";
    return `${index + 1}) ${connection.title}: ${runtimeLabel}, ${statusLabel}. ${connection.note}`;
  });

  if (focus === "railway") {
    const railway = connections.find((connection) => connection.id === "railway");
    if (!railway) return "Railway MCP: статус недоступен.";
    return [
      "Railway MCP:",
      `- runtime: ${railway.runtime}`,
      `- auth: ${railway.authHint}`,
      `- note: ${railway.note}`,
      buildRailwayDevOpsChecklist(railway.configured, railwayProbe),
    ].join("\n");
  }

  if (focus === "github") {
    const github = connections.find((connection) => connection.id === "github");
    if (!github) return "GitHub MCP: статус недоступен.";
    return [
      "GitHub MCP:",
      `- runtime: ${github.runtime}`,
      `- auth: ${github.authHint}`,
      `- note: ${github.note}`,
      "- policy: правки только в явно одобренном репозитории.",
    ].join("\n");
  }

  if (focus === "sandbox") {
    const sandbox = connections.find((connection) => connection.id === "sandbox");
    if (!sandbox) return "Sandbox Execution: статус недоступен.";
    return [
      "Sandbox Execution:",
      `- runtime: ${sandbox.runtime}`,
      `- auth: ${sandbox.authHint}`,
      `- note: ${sandbox.note}`,
      "- policy: использовать только как изолированный контур после отдельной live-интеграции.",
    ].join("\n");
  }

  const railway = connections.find((connection) => connection.id === "railway");
  return [
    `MCP runtime (${LLM_TOOL_RUNTIME_MODE}):`,
    ...detailLines,
    "",
    "Railway / DevOps summary:",
    buildRailwayDevOpsChecklist(Boolean(railway?.configured), railwayProbe),
  ].join("\n");
};

const buildMcpRuntimeContext = (connections: MpcConnectionStatus[]): string => {
  const summary = connections
    .map((connection) => {
      const auth = connection.configured ? "key-present" : "key-missing";
      return `${connection.title}: ${connection.runtime}/${auth}`;
    })
    .join("; ");
  return `MCP runtime (${LLM_TOOL_RUNTIME_MODE}): ${summary}.`;
};

const getPendingRailwayCommandFromRoom = async (roomKey: string): Promise<string | null> => {
  if (!isServerSupabaseConfigured) {
    return null;
  }

  try {
    const { data } = await supabase
      .from("room_state")
      .select("metadata")
      .eq("room_key", roomKey)
      .maybeSingle();

    const metadata = (data?.metadata ?? null) as Record<string, unknown> | null;
    if (!metadata || metadata.approvalSource !== "railway_executor") {
      return null;
    }

    if (metadata.waitingForApproval !== true) {
      return null;
    }

    const pendingMessage = metadata.pendingRailwayMessage;
    if (typeof pendingMessage !== "string" || pendingMessage.trim().length === 0) {
      return null;
    }

    return pendingMessage.trim();
  } catch {
    return null;
  }
};

const persistChatUsage = async (
  role: ChatAgentRole,
  model: string,
  promptTokens: number,
  completionTokens: number,
  officeId?: string | null
): Promise<{ agentId: string | null; aggregateTokens: number | null; deltaTokens: number } | null> => {
  if (!isServerSupabaseConfigured) {
    return null;
  }

  try {
    let agentQuery = supabase.from("agents").select("id").eq("role", role);
    if (officeId) {
      agentQuery = agentQuery.eq("office_id", officeId);
    }
    const { data: agent } = await agentQuery.maybeSingle();
    const totalTokens = promptTokens + completionTokens;
    const cost = Number(((totalTokens / 1000) * 0.001).toFixed(6));

    await supabase.from("token_logs").insert({
      agent_id: agent?.id ?? null,
      task_id: null,
      office_id: officeId ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      model,
      cost,
    });

    if (!agent?.id) {
      return {
        agentId: null,
        aggregateTokens: null,
        deltaTokens: totalTokens,
      };
    }

    let usageQuery = supabase
      .from("token_logs")
      .select("prompt_tokens, completion_tokens")
      .eq("agent_id", agent.id);
    if (officeId) {
      usageQuery = usageQuery.eq("office_id", officeId);
    }

    const { data: usageRows } = await usageQuery;

    const aggregateTotal = (usageRows ?? []).reduce((sum, row) => {
      return sum + Number(row.prompt_tokens ?? 0) + Number(row.completion_tokens ?? 0);
    }, 0);

    return {
      agentId: agent.id,
      aggregateTokens: aggregateTotal,
      deltaTokens: totalTokens,
    };
  } catch (error) {
    console.error(`[Usage] Failed to persist chat usage for ${role}:`, error);
    return null;
  }
};

const publishAgentResponseEvent = async ({
  roomKey,
  responder,
  agentName,
  targetRole,
  scope,
  message,
  clientMessageId,
  taskId,
  threadId,
  coordinator,
}: {
  roomKey: string;
  responder: ChatAgentRole;
  agentName: string;
  targetRole: ChatTargetRole;
  scope: TeamEventScope;
  message: string;
  clientMessageId?: string;
  taskId?: string | null;
  threadId?: string | null;
  coordinator?: string | null;
}) => {
  const normalizedMessage = repairTextForDisplay(message);
  const normalizedAgentName = repairTextForDisplay(agentName);
  await publishTeamEvent({
    roomKey,
    eventName: "chat.agent_response",
    scope,
    senderRole: responder,
    senderName: normalizedAgentName,
    targetRole: targetRole === "Auto" ? responder : (targetRole as ChatAgentRole | "All"),
    payload: {
      message: normalizedMessage,
      role: responder,
      agentName: normalizedAgentName,
      coordinator: coordinator ?? responder,
      clientMessageId: clientMessageId ?? null,
      source: "api",
      taskId: taskId ?? null,
      threadId: threadId ?? null,
    },
  });
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChatRequestBody;
    const message = body?.message?.trim();
    const officeId = body?.officeId?.trim() || null;
    const threadId = body?.threadId?.trim() || null;
    const roomKey = body?.roomKey?.trim() || buildOfficeRoomKey(officeId) || DEFAULT_ROOM_KEY;
    const senderName = repairTextForDisplay(body?.senderName?.trim() || "Администратор CIC");
    const requestedScope = body?.scope?.trim().toLowerCase();
    const clientMessageId = body?.clientMessageId?.trim();
    const selectedTaskId = body?.selectedTaskId?.trim() || null;
    const selectedTaskSummary = body?.selectedTaskSummary?.trim() || null;
    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const history = normalizeHistory(body.history);
    const roster = await getTeamRoster(officeId);
    const { roleSkills, skillCatalog, availableRoles, coordinatorRole, agentProfiles } =
      await loadRoleSkillContextFromDb(officeId);
    const roleDescriptions = Object.fromEntries(
      Object.entries(agentProfiles).map(([role, profile]) => [role, profile.roleMarkdown ?? ""])
    );
    const rosterMentionRole = detectRosterMentionRole(message, roster);
    const explicitTarget = rosterMentionRole ?? body.targetRole;
    const intent = await routeChatIntent(message, explicitTarget, {
      availableRoles,
      coordinatorRole,
      rosterLabels: roster,
      roleDescriptions,
      officeId,
    });
    const responder = intent.responderRole;
    const agentName = roster[responder] ?? roleLabel(responder);
    const roomCoordinatorRole = intent.coordinatorRole;
    const roomCoordinatorName = roster[roomCoordinatorRole] ?? roleLabel(roomCoordinatorRole);
    const operationsRole =
      availableRoles.find((role) =>
        /(devops|ops|sre|infra|platform)/i.test(role)
      ) ?? responder;
    const operationsName = roster[operationsRole] ?? roleLabel(operationsRole);
    const text = message.toLowerCase();
    const mcpConnections = resolveMcpConnectionStatus();
    const mcpFocus = detectMcpFocus(text);
    const scope = resolveChatScope(requestedScope, intent);
    const hasApproval = detectApproval(text);
    const wantsExecution = detectExecutionIntent(text, hasApproval);
    const currentRoomSnapshot = await readRoomSnapshot(roomKey);
    const threadTaskContext = await resolveThreadTaskContext(threadId, officeId);
    let contextTaskId =
      selectedTaskId ??
      threadTaskContext?.activeTaskId ??
      currentRoomSnapshot.pendingTaskId ??
      null;

    if (intent.is_actionable_task && !contextTaskId) {
      contextTaskId = await ensureActionableTaskContext({
        officeId,
        threadId,
        selectedTaskId,
        activeTaskId: threadTaskContext?.activeTaskId ?? null,
        responderRole: responder,
        initialMessage: message,
      });
      if (threadId && officeId && clientMessageId && contextTaskId) {
        await attachTaskIdToChatMessage(threadId, officeId, clientMessageId, contextTaskId);
      }
    }
    if (threadId && officeId && contextTaskId && threadTaskContext?.activeTaskId !== contextTaskId) {
      await bindThreadToTask(threadId, officeId, contextTaskId);
    }

    const initialMode =
      hasApproval
        ? "execution"
        : wantsExecution
          ? "approval"
          : hasActiveExecution(currentRoomSnapshot)
            ? "execution"
            : currentRoomSnapshot.mode === "approval" && currentRoomSnapshot.pendingTaskId
              ? "approval"
              : "discussion";
    const initialTaskStatus =
      hasApproval
        ? "in_progress"
        : wantsExecution
          ? "waiting_approval"
          : hasActiveExecution(currentRoomSnapshot)
            ? currentRoomSnapshot.taskStatus || "in_progress"
            : currentRoomSnapshot.mode === "approval" && currentRoomSnapshot.pendingTaskId
              ? "waiting_approval"
              : "pending";

    await patchRoomState({
      roomKey,
      mode: initialMode as "discussion" | "approval" | "execution",
      activeRole: roomCoordinatorRole,
      taskStatus: initialTaskStatus,
      metadata: {
        lastMessageAt: new Date().toISOString(),
        lastTargetRole: intent.targetRole,
        lastScope: scope,
        lastContextTaskId: contextTaskId,
      },
    });

    await publishTeamEvent({
      roomKey,
      eventName: "chat.user_message",
      scope,
      senderRole: "All",
      senderName,
      targetRole: intent.targetRole === "Auto" ? responder : (intent.targetRole as ChatAgentRole | "All"),
      payload: {
        message,
        clientMessageId: clientMessageId ?? null,
        taskId: contextTaskId,
        threadId,
      },
    });

    await logSystemEvent({
      scope: "agents.chat",
      event: "chat_message_received",
      metadata: {
        responder,
        targetRole: intent.targetRole,
        messageLength: message.length,
        scope,
      },
    });

    const mcpTemplateIntent = findTemplateByMessage(text);
    const mcpConnectCommand = parseMcpConnectCommand(message);

    const respondWithMcpMessage = async (
      responseMessage: string,
      eventName: string,
      metadata: Record<string, unknown>
    ) => {
      await patchRoomState({
        roomKey,
        mode: "discussion",
        activeRole: operationsRole,
        metadata: {
          lastMcpActionAt: new Date().toISOString(),
          lastMcpAction: eventName,
          ...metadata,
        },
      });

      await publishAgentResponseEvent({
        roomKey,
        responder: operationsRole,
        agentName: operationsName,
        targetRole: intent.targetRole,
        scope,
        message: responseMessage,
        clientMessageId,
        taskId: contextTaskId,
        threadId,
      });

      await logSystemEvent({
        scope: "agents.chat",
        event: eventName,
        metadata,
      });

      return NextResponse.json({
        role: operationsRole,
        agentName: operationsName,
        coordinator: roomCoordinatorRole,
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
        taskId: contextTaskId,
        message: responseMessage,
      });
    };

    if (mcpTemplateIntent && !mcpConnectCommand) {
      const missingKeys = getMissingEnvKeys(mcpTemplateIntent, {});
      if (missingKeys.length > 0) {
        return respondWithMcpMessage(
          buildMcpConnectionInstruction(mcpTemplateIntent, missingKeys),
          "chat_mcp_onboarding_requested",
          {
            requestedTemplate: mcpTemplateIntent.key,
            requiredEnv: missingKeys,
            officeId,
          }
        );
      }

      const provision = await provisionMcpServer({
        name: mcpTemplateIntent.key,
        type: mcpTemplateIntent.type,
        command: mcpTemplateIntent.command,
        url: mcpTemplateIntent.url,
      });

      const autoProvisionMessage = provision.success
        ? [
            `DevOps: MCP '${mcpTemplateIntent.key}' connected successfully.`,
            `Tools: ${provision.tools.length > 0 ? provision.tools.join(", ") : "no tools reported"}.`,
            "Connector is now registered in skills_catalog for the office team.",
          ].join("\n")
        : [
            `DevOps: MCP '${mcpTemplateIntent.key}' connection failed.`,
            `Reason: ${provision.error ?? "unknown_error"}`,
            "Check runtime command, network access, and required ENV keys.",
          ].join("\n");

      return respondWithMcpMessage(autoProvisionMessage, "chat_mcp_onboarding_autoprovision", {
        requestedTemplate: mcpTemplateIntent.key,
        success: provision.success,
        configId: provision.configId,
        toolsCount: provision.tools.length,
        officeId,
      });
    }

    if (mcpConnectCommand) {
      const missingKeys = getMissingEnvKeys(mcpConnectCommand.template, mcpConnectCommand.envVars);
      if (missingKeys.length > 0) {
        return respondWithMcpMessage(
          buildMcpConnectionInstruction(mcpConnectCommand.template, missingKeys),
          "chat_mcp_onboarding_missing_env",
          {
            requestedTemplate: mcpConnectCommand.template.key,
            missingEnv: missingKeys,
            officeId,
          }
        );
      }

      const provision = await provisionMcpServer({
        name: mcpConnectCommand.template.key,
        type: mcpConnectCommand.template.type,
        command: mcpConnectCommand.template.command,
        url: mcpConnectCommand.template.url,
        envVars: mcpConnectCommand.envVars,
      });

      const provisionMessage = provision.success
        ? [
            `DevOps: MCP '${mcpConnectCommand.template.key}' connected and activated.`,
            `Config ID: ${provision.configId ?? "n/a"}`,
            `Tools: ${provision.tools.length > 0 ? provision.tools.join(", ") : "no tools reported"}.`,
            "Entry was published to skills_catalog for all team members.",
          ].join("\n")
        : [
            `DevOps: MCP '${mcpConnectCommand.template.key}' failed validation.`,
            `Error: ${provision.error ?? "unknown_error"}`,
            "Fix credentials or launch command and retry /mcp-connect.",
          ].join("\n");

      return respondWithMcpMessage(provisionMessage, "chat_mcp_onboarding_submitted", {
        requestedTemplate: mcpConnectCommand.template.key,
        success: provision.success,
        configId: provision.configId,
        toolsCount: provision.tools.length,
        submittedEnvKeys: Object.keys(mcpConnectCommand.envVars),
        officeId,
      });
    }

    if (isMcpQuestion(text)) {
      const railwayProbe =
        mcpFocus === "railway" || mcpFocus === "all"
          ? await probeRailwayAccess(mcpConnections)
          : null;

      const mcpMessage = buildMcpCapabilitiesMessage(mcpConnections, mcpFocus, railwayProbe);
      await publishAgentResponseEvent({
        roomKey,
        responder,
        agentName,
        targetRole: intent.targetRole,
        scope,
        message: mcpMessage,
        clientMessageId,
        taskId: contextTaskId,
      });
      await logSystemEvent({
        scope: "agents.chat",
        event: "chat_mcp_capabilities_shared",
        metadata: {
          responder,
          focus: mcpFocus,
          railwayProbeMode: railwayProbe?.mode ?? null,
          railwayProbeSummary: railwayProbe?.summary ?? null,
          connections: mcpConnections.map((connection) => ({
            id: connection.id,
            configured: connection.configured,
          })),
        },
      });
      return NextResponse.json({
        role: responder,
        agentName,
        coordinator: roomCoordinatorRole,
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
        taskId: contextTaskId,
        message: mcpMessage,
      });
    }

    const parsedRailwayInCurrentMessage = parseRailwayCommand(message);
    const pendingRailwayCommand =
      hasApproval && !parsedRailwayInCurrentMessage
        ? await getPendingRailwayCommandFromRoom(roomKey)
        : null;
    const railwayExecutionInput = pendingRailwayCommand ?? message;
    const railwayExecution = await executeRailwayCommand(railwayExecutionInput, hasApproval);
    if (railwayExecution.handled) {
      const railwayResponder: ChatAgentRole = railwayExecution.requiresApproval
        ? roomCoordinatorRole
        : operationsRole;
      const railwayAgentName = roster[railwayResponder] ?? roleLabel(railwayResponder);
      const railwayMessage = [railwayExecution.summary, ...railwayExecution.details]
        .filter(Boolean)
        .join("\n");

      if (railwayExecution.requiresApproval) {
        await patchRoomState({
          roomKey,
          mode: "approval",
          taskStatus: "waiting_approval",
          activeRole: roomCoordinatorRole,
          metadata: {
            waitingForApproval: true,
            approvalSource: "railway_executor",
            railwayAction: railwayExecution.action,
            pendingRailwayMessage: railwayExecutionInput,
          },
        });
        await publishTeamEvent({
          roomKey,
          eventName: "workflow.approval_requested",
          scope,
          senderRole: roomCoordinatorRole,
          senderName: roomCoordinatorName,
          targetRole:
            intent.targetRole === "Auto"
              ? operationsRole
              : (intent.targetRole as ChatAgentRole | "All"),
          requiresAck: true,
          payload: {
            message: railwayMessage,
            sourceMessage: message,
            action: railwayExecution.action,
            clientMessageId: clientMessageId ?? null,
            taskId: contextTaskId,
          },
        });
      } else {
        const actionMutatesInfrastructure =
          railwayExecution.action === "create_service" ||
          railwayExecution.action === "deploy_service" ||
          railwayExecution.action === "set_variables";

        await patchRoomState({
          roomKey,
          mode: actionMutatesInfrastructure && railwayExecution.ok ? "execution" : "discussion",
          taskStatus:
            actionMutatesInfrastructure && railwayExecution.ok
              ? "in_progress"
              : railwayExecution.ok
                ? "pending"
                : "failed",
          activeRole: operationsRole,
          metadata: {
            waitingForApproval: false,
            pendingRailwayMessage: null,
            railwayAction: railwayExecution.action,
            railwayResult: railwayExecution.ok ? "ok" : "failed",
            railwayAt: new Date().toISOString(),
          },
        });
        await publishTeamEvent({
          roomKey,
          eventName: railwayExecution.ok ? "railway.action_completed" : "railway.action_failed",
          scope,
          senderRole: operationsRole,
          senderName: operationsName,
          targetRole:
            intent.targetRole === "Auto"
              ? operationsRole
              : (intent.targetRole as ChatAgentRole | "All"),
          payload: {
            action: railwayExecution.action,
            ok: railwayExecution.ok,
            summary: railwayExecution.summary,
            details: railwayExecution.details,
            clientMessageId: clientMessageId ?? null,
            taskId: contextTaskId,
          },
        });
      }

      await publishAgentResponseEvent({
        roomKey,
        responder: railwayResponder,
        agentName: railwayAgentName,
        targetRole: intent.targetRole,
        scope,
        message: railwayMessage,
        clientMessageId,
        taskId: contextTaskId,
        threadId,
      });

      await logSystemEvent({
        level: railwayExecution.ok ? "info" : "warn",
        scope: "agents.chat",
        event: "chat_railway_command_processed",
        metadata: {
          action: railwayExecution.action,
          ok: railwayExecution.ok,
          requiresApproval: railwayExecution.requiresApproval,
          targetRole: intent.targetRole,
          scope,
        },
      });

      return NextResponse.json({
        role: railwayResponder,
        agentName: railwayAgentName,
        coordinator: roomCoordinatorRole,
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
        taskId: contextTaskId,
        message: railwayMessage,
      });
    }

    if (hasApproval) {
      if (!isServerSupabaseConfigured) {
        const infoMessage =
          "PM: подтверждение получено, но Supabase не настроен. Автозапуск workflow недоступен в этой среде.";
        await publishAgentResponseEvent({
          roomKey,
          responder: roomCoordinatorRole,
          agentName: roomCoordinatorName,
          targetRole: intent.targetRole,
          scope,
          message: infoMessage,
          clientMessageId,
          taskId: contextTaskId,
          threadId,
        });
        return NextResponse.json({
          role: roomCoordinatorRole,
          agentName: roomCoordinatorName,
          coordinator: roomCoordinatorRole,
          targetRole: intent.targetRole,
          scope,
          clientMessageId: clientMessageId ?? null,
          taskId: contextTaskId,
          message: infoMessage,
        });
      }

      if (isShortApprovalOnlyMessage(message)) {
        const { data: activeRoomState } = await supabase
          .from("room_state")
          .select("mode, pending_task_id")
          .eq("room_key", roomKey)
          .maybeSingle();
        const mode = String(activeRoomState?.mode ?? "");
        const pendingTaskId = String(activeRoomState?.pending_task_id ?? "");
        if (mode === "execution" && pendingTaskId) {
          const alreadyRunningMessage =
            `PM: выполнение уже идет.\n` +
            `Task ID: ${pendingTaskId}\n` +
            "Статус: in_progress.";
          await publishAgentResponseEvent({
            roomKey,
            responder: roomCoordinatorRole,
            agentName: roomCoordinatorName,
            targetRole: intent.targetRole,
            scope,
            message: alreadyRunningMessage,
            clientMessageId,
            taskId: pendingTaskId,
            threadId,
          });
          return NextResponse.json({
            role: roomCoordinatorRole,
            agentName: roomCoordinatorName,
            coordinator: roomCoordinatorRole,
            targetRole: intent.targetRole,
            scope,
            clientMessageId: clientMessageId ?? null,
            taskId: pendingTaskId,
            message: alreadyRunningMessage,
          });
        }
      }

      const executionInput = resolveApprovedTaskInput(message, history, selectedTaskSummary).trim();
      const normalizedTargetRole = intent.targetRole === "Auto" ? "All" : intent.targetRole;

      try {
        const approvedAt = new Date().toISOString();
        let taskIdForExecution: string | null = null;
        let taskDescriptionForExecution = executionInput;

        if (selectedTaskId) {
          let existingTaskQuery = supabase
            .from("tasks")
            .select("id, description, status, metadata, office_id")
            .eq("id", selectedTaskId);
          if (officeId) {
            existingTaskQuery = existingTaskQuery.eq("office_id", officeId);
          }

          const { data: existingTask, error: existingTaskError } = await existingTaskQuery.maybeSingle();

          if (!existingTaskError && existingTask?.id) {
            const taskRow = existingTask as ChatTaskRow;
            const currentStatus = String(taskRow.status ?? "pending");
            if (currentStatus !== "done" && currentStatus !== "failed") {
              taskIdForExecution = taskRow.id;
              taskDescriptionForExecution = taskRow.description?.trim() || executionInput;
              let updateTaskQuery = supabase
                .from("tasks")
                .update({
                  status: "pending",
                  current_assignee: roomCoordinatorRole,
                  office_id: officeId ?? taskRow.office_id ?? null,
                  metadata: {
                    ...(taskRow.metadata ?? {}),
                    approved: true,
                    approved_at: approvedAt,
                    targetRole: normalizedTargetRole,
                    initiatedBy: "chat-context",
                    threadId,
                  },
                  updated_at: approvedAt,
                })
                .eq("id", taskRow.id);
              if (officeId ?? taskRow.office_id) {
                updateTaskQuery = updateTaskQuery.eq("office_id", officeId ?? taskRow.office_id ?? "");
              }
              await updateTaskQuery;
            }
          }
        }

        if (!taskIdForExecution) {
          const { data: task, error: taskError } = await supabase
            .from("tasks")
            .insert({
              title: createChatTaskTitle(executionInput),
              description: executionInput,
              status: "pending",
              office_id: officeId,
              current_assignee: roomCoordinatorRole,
              metadata: {
                approved: true,
                approved_at: approvedAt,
                targetRole: normalizedTargetRole,
                initiatedBy: "chat",
                threadId,
              },
            })
            .select("id")
            .single();

          if (taskError || !task?.id) {
            throw taskError ?? new Error("task_insert_failed");
          }

          taskIdForExecution = task.id as string;
        }
        if (threadId && officeId && taskIdForExecution) {
          await bindThreadToTask(threadId, officeId, taskIdForExecution);
        }

        await patchRoomState({
          roomKey,
          mode: "execution",
          taskStatus: "in_progress",
          activeRole: roomCoordinatorRole,
          pendingTaskId: taskIdForExecution,
          metadata: {
            executionQueuedBy: "chat",
            executionQueuedAt: approvedAt,
            targetRole: normalizedTargetRole,
            lastContextTaskId: taskIdForExecution,
            officeId,
          },
        });

        await publishTeamEvent({
          roomKey,
          eventName: "workflow.execution_queued",
          scope,
          senderRole: roomCoordinatorRole,
          senderName: roomCoordinatorName,
          targetRole: normalizedTargetRole as ChatAgentRole | "All",
          payload: {
            taskId: taskIdForExecution,
            threadId,
            targetRole: normalizedTargetRole,
            sourceMessage: taskDescriptionForExecution,
            clientMessageId: clientMessageId ?? null,
            officeId,
          },
        });

        const runUrl = new URL("/api/agents/run", req.url).toString();
        void fetch(runUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: taskIdForExecution,
            input: taskDescriptionForExecution,
            targetRole: normalizedTargetRole,
            approved: true,
            roomKey,
            officeId,
            threadId,
          }),
        }).catch(async (error: unknown) => {
          await logSystemEvent({
            level: "error",
            scope: "agents.chat",
            event: "chat_execution_start_failed",
            taskId: taskIdForExecution,
            metadata: {
              reason: error instanceof Error ? error.message : "run_api_unreachable",
            },
          });
        });

        const startedMessage =
          `PM: подтверждение получено. Выполнение запущено.\n` +
          `Task ID: ${taskIdForExecution}\n` +
          `Режим: execution\n` +
          `Цель: ${normalizedTargetRole}.`;

        await publishAgentResponseEvent({
          roomKey,
          responder: roomCoordinatorRole,
          agentName: roomCoordinatorName,
          targetRole: intent.targetRole,
          scope,
          message: startedMessage,
          clientMessageId,
          taskId: taskIdForExecution,
          threadId,
        });

        await logSystemEvent({
          scope: "agents.chat",
          event: "chat_execution_queued",
          taskId: taskIdForExecution,
          metadata: {
            targetRole: normalizedTargetRole,
            source: "chat",
            scope,
          },
        });

        return NextResponse.json({
          role: roomCoordinatorRole,
          agentName: roomCoordinatorName,
          coordinator: roomCoordinatorRole,
          targetRole: intent.targetRole,
          scope,
          clientMessageId: clientMessageId ?? null,
          taskId: taskIdForExecution,
          message: startedMessage,
        });
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : "chat_execution_queue_failed";
        await logSystemEvent({
          level: "error",
          scope: "agents.chat",
          event: "chat_execution_queue_failed",
          metadata: { reason },
        });
      }
    }

    if (!wantsExecution && !hasApproval && isGreetingMessage(text) && message.length < 80) {
      const greeting = buildFormalGreeting(agentName);
      await publishAgentResponseEvent({
        roomKey,
        responder,
        agentName,
        targetRole: intent.targetRole,
        scope,
        message: greeting,
        clientMessageId,
        taskId: contextTaskId,
        threadId,
      });
      return NextResponse.json({
        role: responder,
        agentName,
        coordinator: roomCoordinatorRole,
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
        taskId: contextTaskId,
        message: greeting,
      });
    }

    if (wantsExecution && !hasApproval) {
      const approvalMessage = buildApprovalRequest(intent.targetRole, roster);
      await patchRoomState({
        roomKey,
        mode: "approval",
        taskStatus: "waiting_approval",
        activeRole: roomCoordinatorRole,
        metadata: {
          waitingForApproval: true,
          approvalReason: "execution_marker_detected_without_explicit_approval",
        },
      });
      await publishTeamEvent({
        roomKey,
        eventName: "workflow.approval_requested",
        scope,
        senderRole: roomCoordinatorRole,
        senderName: roomCoordinatorName,
        targetRole: intent.targetRole === "Auto" ? responder : (intent.targetRole as ChatAgentRole | "All"),
        requiresAck: true,
        payload: {
          message: approvalMessage,
          sourceMessage: message,
          clientMessageId: clientMessageId ?? null,
          taskId: contextTaskId,
          threadId,
        },
      });
      await publishAgentResponseEvent({
        roomKey,
        responder: roomCoordinatorRole,
        agentName: roomCoordinatorName,
        targetRole: intent.targetRole,
        scope,
        message: approvalMessage,
        clientMessageId,
        taskId: contextTaskId,
        threadId,
      });
      await logSystemEvent({
        scope: "agents.chat",
        event: "chat_waiting_for_approval",
        metadata: { responder, targetRole: intent.targetRole },
      });
      return NextResponse.json({
        role: roomCoordinatorRole,
        agentName: roomCoordinatorName,
        coordinator: roomCoordinatorRole,
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
        taskId: contextTaskId,
        message: approvalMessage,
      });
    }

    if (intent.needsClarification && !intent.is_actionable_task) {
      const clarificationMessage = buildClarification(intent.targetRole);
      await patchRoomState({
        roomKey,
        mode: "discussion",
        activeRole: roomCoordinatorRole,
        taskStatus: "pending",
        metadata: { needsClarification: true },
      });
      await publishAgentResponseEvent({
        roomKey,
        responder: roomCoordinatorRole,
        agentName: roomCoordinatorName,
        targetRole: intent.targetRole,
        scope,
        message: clarificationMessage,
        clientMessageId,
        taskId: contextTaskId,
        threadId,
      });
      await logSystemEvent({
        scope: "agents.chat",
        event: "chat_clarification_requested",
        metadata: { responder, targetRole: intent.targetRole },
      });
      return NextResponse.json({
        role: roomCoordinatorRole,
        agentName: roomCoordinatorName,
        coordinator: roomCoordinatorRole,
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
        taskId: contextTaskId,
        message: clarificationMessage,
      });
    }

    const executionMode = hasApproval
      ? "Explicit approval for external execution is present."
      : "No explicit approval for external side effects. Drafts, plans, copy, and internal deliverables are allowed immediately.";
    const responderAgentId = await resolveResponderAgentId(responder, officeId);
    const agentContextBlock = await buildAgentContextPromptBlock(officeId, responder, responderAgentId);
    const roleSkillBlock = buildRoleSkillsPromptBlock(responder, roleSkills, skillCatalog);
    const teamSkillBlock = buildTeamSkillsPromptBlock(roleSkills);
    const taskContextBlock = contextTaskId
      ? [
        `Selected task context: ${contextTaskId}.`,
        selectedTaskSummary ? `Task summary: ${selectedTaskSummary}` : null,
        "Stay within this task unless the user explicitly switches context.",
      ]
        .filter(Boolean)
        .join("\n")
      : "No explicit task context selected.";

    const rosterSummary = Object.entries(roster)
      .map(([role, name]) => `${role} ${name}`)
      .join(", ");

    const promptHeader =
      `You are ${roleLabelRu(responder)} in Pixel Office CIC.\n` +
      `Team roster: ${rosterSummary}.\n` +
      "Communication flows through the active office context, but direct agent mention has priority.\n" +
      `${taskContextBlock}\n` +
      (agentContextBlock ? `${agentContextBlock}\n` : "") +
      `${buildMcpRuntimeContext(mcpConnections)}\n` +
      `${teamSkillBlock}\n` +
      `${roleSkillBlock}\n` +
      `${AUTONOMY_DIRECTIVE}\n` +
      `${executionMode}\n` +
      (intent.targetRole === "All"
        ? "This is a team-wide request. Produce the next useful draft or coordinated plan immediately."
        : `This request is explicitly addressed to role: ${roleLabelRu(responder)}.`) +
      "\nDelegation policy:\n" +
      "- If you finish your part and pass work to another agent, you MUST call the delegate_task tool before writing the handoff in text.\n" +
      "- If the task returns to the same role repeatedly, stop delegating and escalate to a human reviewer.\n" +
      "\nExecution policy:\n" +
      "- Drafts, copy, plans, analysis, code suggestions, and internal artifacts must be produced immediately when possible.\n" +
      "- Ask clarifying questions only when one critical parameter makes execution impossible.\n" +
      "- If information is incomplete, make reasonable assumptions and keep moving.\n" +
      "\nAnswer formally and in Russian with concrete next actions.\n" +
      TEAM_RULES;

    const modelMessages = [
      new SystemMessage(`${getAgentPrompt(responder, roleDescriptions[responder])}\n${promptHeader}`),
      ...history.map((item) =>
        item.role === "user" ? new HumanMessage(item.content) : new AIMessage(item.content)
      ),
      new HumanMessage(message),
    ];

    await setRoleTypingState(responder, true, roomKey, officeId);
    await patchPlayerStateByRole(responder, {
      roomKey,
      officeId,
      status: "typing",
      metadata: { reason: "chat_inference" },
    });

    let completion: AgentInvocationResult;
    try {
      completion = await withTimeout(
        invokeAgentModel(responder, modelMessages, {
          officeId,
          taskId: contextTaskId,
          threadId,
          roomKey,
        }),
        14000
      );
    } catch {
      completion = {
        content:
          "PM: Сеть нестабильна, продолжаем в fallback-режиме. Задача принята, начинаю выполнение по текущему описанию.",
        model: "fallback",
        promptTokens: 0,
        completionTokens: 0,
        executedTools: [],
        toolEvents: [],
      };
    }

    const rawReply = String(completion.content ?? "").trim();
    const normalizedRawReply = repairTextForDisplay(
      rawReply || "PM: запрос принят, продолжаем работу по задаче."
    );
    const hasMissingDelegateCall =
      CHAT_HANDOFF_INTENT_PATTERN.test(normalizedRawReply) &&
      !completion.executedTools.includes("delegate_task");
    const reply = hasMissingDelegateCall
      ? "SYSTEM ERROR: Task not delegated. You MUST call delegate_task tool to transfer ownership."
      : responder === "PM" && !hasApproval
        ? maybeSimplifyPmReply(normalizedRawReply)
        : normalizedRawReply;
    const usageSync = await persistChatUsage(
      responder,
      completion.model,
      completion.promptTokens,
      completion.completionTokens,
      officeId
    );

    if (usageSync?.aggregateTokens !== null) {
      await syncRoleTokenUsage(responder, usageSync.aggregateTokens, roomKey, officeId);
    }

    await setRoleTypingState(responder, false, roomKey, officeId);
    await patchPlayerStateByRole(responder, {
      roomKey,
      officeId,
      status: hasMissingDelegateCall ? "working" : hasApproval ? "working" : "waiting",
      metadata: {
        lastReplyAt: new Date().toISOString(),
        lastModel: completion.model,
        lastSystemError: hasMissingDelegateCall ? "delegate_task_required" : null,
      },
    });

    const finalRoomSnapshot = await readRoomSnapshot(roomKey);
    const finalMode =
      hasApproval || hasActiveExecution(finalRoomSnapshot)
        ? "execution"
        : finalRoomSnapshot.mode === "approval" && finalRoomSnapshot.pendingTaskId
          ? "approval"
          : "discussion";
    const finalTaskStatus =
      hasApproval || hasActiveExecution(finalRoomSnapshot)
        ? finalRoomSnapshot.taskStatus || "in_progress"
        : finalRoomSnapshot.mode === "approval" && finalRoomSnapshot.pendingTaskId
          ? "waiting_approval"
          : "pending";

    await patchRoomState({
      roomKey,
      mode: finalMode as "discussion" | "approval" | "execution",
      taskStatus: finalTaskStatus,
      activeRole: responder,
      pendingTaskId: contextTaskId,
      metadata: {
        lastResponder: responder,
        lastResponderName: agentName,
        lastResponseAt: new Date().toISOString(),
        lastSystemError: hasMissingDelegateCall ? "delegate_task_required" : null,
      },
    });

    if (hasMissingDelegateCall) {
      await publishTeamEvent({
        roomKey,
        eventName: "workflow.system_error",
        scope: "system",
        senderRole: responder,
        senderName: agentName,
        targetRole: responder,
        payload: {
          taskId: contextTaskId,
          threadId,
          role: responder,
          agentName,
          officeId,
          message: "Task not delegated. You MUST call delegate_task tool to transfer ownership.",
        },
      });
    }

    await publishAgentResponseEvent({
      roomKey,
      responder,
      agentName,
      targetRole: intent.targetRole,
      scope,
      message: reply,
      clientMessageId,
      taskId: contextTaskId,
      threadId,
    });

    await logSystemEvent({
      scope: "agents.chat",
      event: "chat_response_generated",
      metadata: {
        responder,
        targetRole: intent.targetRole,
        approved: hasApproval,
        model: completion.model,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        scope,
        threadId,
        taskId: contextTaskId,
        executedTools: completion.executedTools,
      },
    });

    return NextResponse.json({
      role: responder,
      agentName,
      coordinator: roomCoordinatorRole,
      targetRole: intent.targetRole,
      scope,
      clientMessageId: clientMessageId ?? null,
      taskId: contextTaskId,
      threadId: threadId ?? null,
      broadcast: intent.broadcast,
      message: reply,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      totalTokens: completion.promptTokens + completion.completionTokens,
      roleAgentId: usageSync?.agentId ?? null,
      roleTotalTokens: usageSync?.aggregateTokens ?? null,
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "chat failed";
    await logSystemEvent({
      level: "error",
      scope: "agents.chat",
      event: "chat_route_error",
      metadata: { reason },
    });
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}


