import { NextRequest, NextResponse } from "next/server";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AGENT_PROMPTS, TEAM_RULES } from "@/lib/agents/prompts";
import { invokeAgentModel, type AgentInvocationResult } from "@/lib/agents/tools";
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
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import {
  DEFAULT_ROOM_KEY,
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
  senderName?: string;
  clientMessageId?: string;
}

const APPROVAL_MARKERS = [
  "подтверждаю",
  "утверждаю",
  "approve",
  "начинай",
  "запускай",
  "можно выполнять",
  "подтверждаю запуск",
  "вперед",
  "делайте",
  "начинайте",
  "поехали",
  "go ahead",
];

const EXECUTION_MARKERS = [
  "запусти выполнение",
  "запускай выполнение",
  "старт выполнения",
  "начать выполнение",
  "выполняй задачу",
  "start execution",
  "start run",
  "run execution",
  "execute now",
  "launch execution",
  "/execute",
  "/run",
  "/start",
];
const CONSULTATION_MARKERS = [
  "как",
  "что",
  "почему",
  "зачем",
  "подскажи",
  "объясни",
  "расскажи",
  "пример",
  "можно ли",
  "нужно ли",
  "help",
  "explain",
  "clarify",
  "recommend",
  "how",
  "what",
  "why",
];

const GREETING_MARKERS = ["привет", "здравствуйте", "добрый день", "добрый вечер", "hello", "hi"];
const MCP_MARKERS = ["mcp", "railway", "github", "sandbox", "контейнер", "коннектор"];
const MCP_INFO_MARKERS = [
  "какие",
  "какой",
  "что доступно",
  "какие доступны",
  "подскажи",
  "список",
  "доступ",
  "configured",
  "доступы",
];
const MCP_AUDIT_MARKERS = [
  "проверь",
  "проверка",
  "статус",
  "настроен",
  "настроено",
  "настройка",
  "подключ",
  "включ",
  "девопс",
  "devops",
];
const roleHandleByRole: Record<ChatAgentRole, string> = {
  PM: "pm",
  Developer: "developer",
  QA: "qa",
  DevOps: "devops",
};

type MpcConnectionStatus = {
  id: "github" | "railway" | "sandbox";
  title: string;
  configured: boolean;
  authHint: string;
  policy: string;
  configuredKey: string | null;
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
  const githubConfigured = Boolean(githubConfiguredKey);
  const railwayConfigured = Boolean(railwayConfiguredKey);

  return [
    {
      id: "github",
      title: "GitHub MCP",
      configured: githubConfigured,
      authHint: githubConfigured
        ? `РєР»СЋС‡ РЅР°Р№РґРµРЅ РІ РѕРєСЂСѓР¶РµРЅРёРё (${githubConfiguredKey})`
        : "РєР»СЋС‡ РЅРµ РЅР°Р№РґРµРЅ РІ РѕРєСЂСѓР¶РµРЅРёРё",
      policy:
        "РџСЂР°РІРєРё С‚РѕР»СЊРєРѕ РІ СЂРµРїРѕР·РёС‚РѕСЂРёРё, РєРѕС‚РѕСЂС‹Р№ РІС‹ СЏРІРЅРѕ СѓРєР°Р·Р°Р»Рё Рё РѕРґРѕР±СЂРёР»Рё. РџСЂРё РЅРµРѕР±С…РѕРґРёРјРѕСЃС‚Рё СЃРѕР·РґР°РµРј РЅРѕРІС‹Р№ СЂРµРїРѕР·РёС‚РѕСЂРёР№ РїРѕ РІР°С€РµРјСѓ РЅР°Р·РІР°РЅРёСЋ.",
      configuredKey: githubConfiguredKey,
    },
    {
      id: "railway",
      title: "Railway MCP",
      configured: railwayConfigured,
      authHint: railwayConfigured
        ? `РєР»СЋС‡ РЅР°Р№РґРµРЅ РІ РѕРєСЂСѓР¶РµРЅРёРё (${railwayConfiguredKey})`
        : "РєР»СЋС‡ РЅРµ РЅР°Р№РґРµРЅ РІ РѕРєСЂСѓР¶РµРЅРёРё",
      policy:
        "РЎСѓС‰РµСЃС‚РІСѓСЋС‰РёРµ СЃРµСЂРІРёСЃС‹ read-only. РР·РјРµРЅСЏРµРј С‚РѕР»СЊРєРѕ СЃРµСЂРІРёСЃС‹, СЃРѕР·РґР°РЅРЅС‹Рµ РїРѕРґ Р·Р°РґР°С‡Сѓ РїРѕСЃР»Рµ СЃРѕРіР»Р°СЃРѕРІР°РЅРёСЏ.",
      configuredKey: railwayConfiguredKey,
    },
    {
      id: "sandbox",
      title: "Sandbox Execution",
      configured: true,
      authHint: "РґРѕСЃС‚СѓРїРµРЅ РІ С‚РµРєСѓС‰РµРј runtime",
      policy:
        "РџСЂРѕРІРµСЂРєРё Рё С‚РµСЃС‚С‹ РІС‹РїРѕР»РЅСЏРµРј РІ РёР·РѕР»СЏС†РёРё. РќРµ Р»РѕРјР°РµРј РґРµР№СЃС‚РІСѓСЋС‰РёРµ РїСЂРѕРµРєС‚С‹, РїРѕРґ Р·Р°РґР°С‡Сѓ РёСЃРїРѕР»СЊР·СѓРµРј РѕС‚РґРµР»СЊРЅС‹Р№ РєРѕРЅС‚РµР№РЅРµСЂ/РІРµС‚РєСѓ.",
      configuredKey: null,
    },
  ];
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

const getTeamRoster = async () => {
  const defaults: Record<ChatAgentRole, string> = {
    PM: "РђР№РіРµСЂС–Рј",
    Developer: "РђР»РµРєСЃРµР№",
    QA: "РђР»СѓР°",
    DevOps: "РР»СЊСЏ",
  };

  if (!isServerSupabaseConfigured) {
    return defaults;
  }

  try {
    const { data } = await supabase.from("agents").select("name, role").in("role", [
      "PM",
      "Developer",
      "QA",
      "DevOps",
    ]);
    for (const item of data ?? []) {
      const role = item.role as ChatAgentRole;
      defaults[role] = item.name;
    }
  } catch {
    return defaults;
  }

  return defaults;
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

const isShortApprovalOnlyMessage = (text: string): boolean => {
  const normalized = stripPunctuation(text.toLowerCase());
  if (!normalized) return false;
  if (normalized.length > 32) return false;
  const words = normalized.split(" ").filter(Boolean);
  if (words.length > 4) return false;
  return hasMarker(normalized, APPROVAL_MARKERS);
};

const resolveApprovedTaskInput = (message: string, history: ChatHistoryItem[]): string => {
  if (!isShortApprovalOnlyMessage(message)) return message;

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
  if (!short) return "Chat task";
  return `Chat task: ${short}`;
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
        mention === roleHandleByRole[role] ||
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
  const hasGithub = text.includes("github") || text.includes("РіРёС‚С…Р°Р±") || text.includes("СЂРµРїРѕР·РёС‚РѕСЂ");
  const hasRailway = text.includes("railway") || text.includes("СЂРµР№Р»РІРµР№");
  const hasSandbox = text.includes("sandbox") || text.includes("РїРµСЃРѕС‡РЅРёС†");

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
      ? "РєРѕРјР°РЅРґС‹"
      : `СЂРѕР»Рё ${roleLabelRu(targetRole as ChatAgentRole)}`;

  return (
    `Короткое уточнение для ${target}:\n` +
    "1) Что обязательно должно быть в первой версии?\n" +
    "2) Делаем сразу MVP и потом улучшаем итерациями?\n" +
    "Если не хотите уточнять детали, напишите: «делайте на ваше усмотрение», и команда начнет с базового варианта без лишних вопросов."
  );
};

const buildApprovalRequest = (
  targetRole: ChatTargetRole,
  roster: Record<ChatAgentRole, string>
): string => {
  const destination =
    targetRole === "All"
      ? "РІСЃРµР№ РєРѕРјР°РЅРґС‹"
      : targetRole === "Auto"
        ? "PM"
        : `${roleLabelRu(targetRole as ChatAgentRole)} (${roster[targetRole as ChatAgentRole]})`;

  return (
    `РџСЂРёРЅСЏС‚Рѕ. Р—Р°РїСЂРѕСЃ РЅР°РїСЂР°РІР»РµРЅ РґР»СЏ ${destination}.\n` +
    "РЎРЅР°С‡Р°Р»Р° РѕР±СЃСѓР¶РґР°РµРј Рё СЃРѕРіР»Р°СЃСѓРµРј РїРѕРґС…РѕРґ.\n" +
    'Р”Р»СЏ СЃС‚Р°СЂС‚Р° РІС‹РїРѕР»РЅРµРЅРёСЏ РЅР°РїРёС€РёС‚Рµ: "РїРѕРґС‚РІРµСЂР¶РґР°СЋ Р·Р°РїСѓСЃРє".'
  );
};

const buildFormalGreeting = (responderName: string): string => {
  return `Р—РґСЂР°РІСЃС‚РІСѓР№С‚Рµ. РќР° СЃРІСЏР·Рё ${responderName}. Р“РѕС‚РѕРІ(Р°) Рє С„РѕСЂРјР°Р»СЊРЅРѕРјСѓ РѕР±СЃСѓР¶РґРµРЅРёСЋ Р·Р°РґР°С‡Рё.`;
};

const PM_OVERQUESTION_MARKERS = [
  "бюджет",
  "срок",
  "дедлайн",
  "целевая аудитория",
  "контент",
  "примеры сайтов",
  "логотип",
  "фотографии",
  "пример",
];

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
    "1) PM фиксирует структуру сайта и стиль.\n" +
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
      summary: "РљР»СЋС‡ Railway РЅРµ РЅР°Р№РґРµРЅ РІ ENV.",
      details: [
        "Р”РѕР±Р°РІСЊС‚Рµ RAILWAY_TOKEN РёР»Рё RAILWAY_API_TOKEN (РїРѕРґРґРµСЂР¶РёРІР°РµС‚СЃСЏ RAILWAY_API_KEY).",
      ],
    };
  }

  const token = process.env[railway.configuredKey];
  if (!token) {
    return {
      mode: "no_token",
      summary: `РџРµСЂРµРјРµРЅРЅР°СЏ ${railway.configuredKey} СѓРєР°Р·Р°РЅР°, РЅРѕ Р·РЅР°С‡РµРЅРёРµ РїСѓСЃС‚РѕРµ.`,
      details: ["РџСЂРѕРІРµСЂСЊС‚Рµ ENV Рё РїРµСЂРµР·Р°РїСѓСЃС‚РёС‚Рµ СЃРµСЂРІРёСЃ."],
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
      summary: "Railway user-token РІР°Р»РёРґРµРЅ (query me РїСЂРѕС…РѕРґРёС‚).",
      details: [
        "РњРѕР¶РЅРѕ СЂР°Р±РѕС‚Р°С‚СЊ С‡РµСЂРµР· account scope.",
        "РЎР»РµРґСѓСЋС‰РёР№ С€Р°Рі: СЃРѕР·РґР°РІР°С‚СЊ РѕС‚РґРµР»СЊРЅС‹Р№ environment/service РїРѕРґ Р·Р°РґР°С‡Сѓ.",
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
        summary: "Railway project-token РІР°Р»РёРґРµРЅ (project scope РґРѕСЃС‚СѓРїРµРЅ).",
        details: [
          `РџСЂРѕРµРєС‚: ${projectNode.id}`,
          "РњРѕР¶РЅРѕ СЃРѕР·РґР°РІР°С‚СЊ/РјРµРЅСЏС‚СЊ СЃРµСЂРІРёСЃС‹ С‚РѕР»СЊРєРѕ РІ СЂР°РјРєР°С… СѓРєР°Р·Р°РЅРЅРѕРіРѕ РїСЂРѕРµРєС‚Р°.",
        ],
      };
    }
  }

  const lowerError = String(meProbe.error ?? "").toLowerCase();
  if (lowerError.includes("unauthorized") || lowerError.includes("not authorized")) {
    return {
      mode: "token_present_unverified",
      summary:
        "РўРѕРєРµРЅ РµСЃС‚СЊ, РЅРѕ query me РЅРµ РїСЂРѕС€РµР» (РІРѕР·РјРѕР¶РµРЅ project-token СЂРµР¶РёРј РёР»Рё РЅРµРІР°Р»РёРґРЅС‹Р№ С‚РѕРєРµРЅ).",
      details: [
        "Р•СЃР»Рё СЌС‚Рѕ project-token: Р·Р°РґР°Р№С‚Рµ RAILWAY_PROJECT_ID Рё РїРѕРІС‚РѕСЂРёС‚Рµ project-scope probe.",
        "Р•СЃР»Рё СЌС‚Рѕ user-token: РїРµСЂРµРІС‹РїСѓСЃС‚РёС‚Рµ С‚РѕРєРµРЅ Рё РїСЂРѕРІРµСЂСЊС‚Рµ whoami/me.",
      ],
    };
  }

  return {
    mode: "token_invalid",
    summary: "Railway С‚РѕРєРµРЅ РЅРµ РїСЂРѕС€РµР» РїСЂРѕРІРµСЂРєСѓ.",
    details: [
      `РћС€РёР±РєР° probe: ${meProbe.error ?? "unknown"}`,
      "РџСЂРѕРІРµСЂСЊС‚Рµ С‚РѕРєРµРЅ/РїСЂР°РІР°/СЃРµС‚РµРІРѕР№ РґРѕСЃС‚СѓРї РІ runtime.",
    ],
  };
};

const RAILWAY_OBSERVED_FAILURES = [
  "railway --version -> 'railway' is not recognized (CLI РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚ РІ runtime)",
  "railway whoami -> Unauthorized (С‚РѕРєРµРЅ РЅРµ РїСЂРёРЅСЏС‚ Railway CLI)",
  "GraphQL me -> Not Authorized (С‚РѕРєРµРЅ РІ ENV РЅРµ СЂР°РІРµРЅ РІР°Р»РёРґРЅРѕР№ Р°РІС‚РѕСЂРёР·Р°С†РёРё Railway API)",
];

const buildRailwayDevOpsChecklist = (
  configured: boolean,
  probe: RailwayProbeResult | null = null
): string => {
  const probeSummary = probe ? `Railway probe: ${probe.summary}` : "Railway probe: РЅРµ РІС‹РїРѕР»РЅСЏР»СЃСЏ.";
  const probeDetails = probe?.details?.length
    ? probe.details.map((item, index) => `${index + 1}) ${item}`)
    : [];

  if (configured) {
    return [
      "Р“РѕС‚РѕРІРЅРѕСЃС‚СЊ DevOps: РєР»СЋС‡ РЅР°Р№РґРµРЅ РІ ENV, РЅРѕ РїРµСЂРµРґ СЂР°Р±РѕС‚РѕР№ РѕР±СЏР·Р°С‚РµР»РµРЅ preflight.",
      probeSummary,
      ...probeDetails,
      "Preflight (РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Р№):",
      "1) РџСЂРѕРІРµСЂРёС‚СЊ CLI: `railway --version`. Р•СЃР»Рё РєРѕРјР°РЅРґР° РЅРµ РЅР°Р№РґРµРЅР°, СѓСЃС‚Р°РЅРѕРІРёС‚СЊ CLI РІ runtime (РёР»Рё РёСЃРїРѕР»СЊР·РѕРІР°С‚СЊ API-Р°РґР°РїС‚РµСЂ).",
      "2) РџСЂРѕРІРµСЂРёС‚СЊ Р°РІС‚РѕСЂРёР·Р°С†РёСЋ: `railway whoami`.",
      "3) РџСЂРѕРІРµСЂРёС‚СЊ API-РґРѕСЃС‚СѓРї РІ РґРІСѓС… СЂРµР¶РёРјР°С…:",
      "   - user token: GraphQL `query { me { id } }`",
      "   - project token: GraphQL `query($id:String!){ project(id:$id){ id } }` + `RAILWAY_PROJECT_ID`",
      "4) Р•СЃР»Рё `Unauthorized/Not Authorized` -> РІС‹РїСѓСЃС‚РёС‚СЊ РЅРѕРІС‹Р№ С‚РѕРєРµРЅ СЃ РїСЂР°РІР°РјРё РЅСѓР¶РЅРѕРіРѕ workspace.",
      "РСЃРїРѕР»РЅРµРЅРёРµ (С‚РѕР»СЊРєРѕ РїРѕСЃР»Рµ preflight):",
      "5) РЎРѕР·РґР°С‚СЊ РѕС‚РґРµР»СЊРЅС‹Р№ environment/service РїРѕРґ Р·Р°РґР°С‡Сѓ (РёР·РѕР»РёСЂРѕРІР°РЅРЅРѕ).",
      "6) Р”РµР№СЃС‚РІСѓСЋС‰РёРµ production-СЃРµСЂРІРёСЃС‹ РЅРµ РјРµРЅСЏС‚СЊ (read-only).",
      "7) Р”РµРїР»РѕР№/С‚РµСЃС‚С‹ Р·Р°РїСѓСЃРєР°С‚СЊ С‚РѕР»СЊРєРѕ РїРѕСЃР»Рµ РїРѕРґС‚РІРµСЂР¶РґРµРЅРёСЏ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ.",
      "РќР°Р±Р»СЋРґР°РµРјС‹Рµ РѕС€РёР±РєРё (РёР· Р»РѕРіРѕРІ):",
      ...RAILWAY_OBSERVED_FAILURES.map((item, index) => `${index + 1}) ${item}`),
    ].join("\n");
  }

  return [
    "Р“РѕС‚РѕРІРЅРѕСЃС‚СЊ DevOps: РїРѕРєР° РЅРµ РіРѕС‚РѕРІРѕ Рє РІС‹РїРѕР»РЅРµРЅРёСЋ Р·Р°РґР°С‡.",
    probeSummary,
    ...probeDetails,
    "Р‘Р»РѕРєРµСЂС‹ Рё РёСЃРїСЂР°РІР»РµРЅРёРµ:",
    "1) Р”РѕР±Р°РІРёС‚СЊ С‚РѕРєРµРЅ РІ ENV: `RAILWAY_TOKEN` РёР»Рё `RAILWAY_API_TOKEN` (РїРѕРґРґРµСЂР¶РёРІР°РµС‚СЃСЏ Рё `RAILWAY_API_KEY`).",
    "2) Р”Р»СЏ CLI СЃРѕРІРјРµСЃС‚РёРјРѕСЃС‚Рё РїСЂРѕРґСѓР±Р»РёСЂРѕРІР°С‚СЊ С‚РѕРєРµРЅ РІ `RAILWAY_TOKEN`.",
    "3) РЈСЃС‚Р°РЅРѕРІРёС‚СЊ Railway CLI РІ runtime Рё РїСЂРѕРІРµСЂРёС‚СЊ `railway --version`.",
    "4) РџСЂРѕРІРµСЂРёС‚СЊ Р°РІС‚РѕСЂРёР·Р°С†РёСЋ: `railway whoami`.",
    "5) РџСЂРѕРІРµСЂРёС‚СЊ API-РґРѕСЃС‚СѓРї: GraphQL `query { me { id } }`.",
    "6) РџСЂРё `Unauthorized/Not Authorized` Р·Р°РјРµРЅРёС‚СЊ С‚РѕРєРµРЅ РЅР° РІР°Р»РёРґРЅС‹Р№ СЃ РїСЂР°РІР°РјРё workspace.",
    "РџРѕСЃР»Рµ СЂР°Р·Р±Р»РѕРєРёСЂРѕРІРєРё:",
    "7) Р Р°Р±РѕС‚Р°С‚СЊ С‚РѕР»СЊРєРѕ РІ РѕС‚РґРµР»СЊРЅРѕРј environment/service РїРѕРґ Р·Р°РґР°С‡Сѓ.",
    "8) РЎСѓС‰РµСЃС‚РІСѓСЋС‰РёРµ СЃРµСЂРІРёСЃС‹ РґРµСЂР¶Р°С‚СЊ read-only Р±РµР· СЏРІРЅРѕРіРѕ РѕРґРѕР±СЂРµРЅРёСЏ.",
    "РќР°Р±Р»СЋРґР°РµРјС‹Рµ РѕС€РёР±РєРё (РёР· Р»РѕРіРѕРІ):",
    ...RAILWAY_OBSERVED_FAILURES.map((item, index) => `${index + 1}) ${item}`),
  ].join("\n");
};

const buildMcpCapabilitiesMessage = (
  connections: MpcConnectionStatus[],
  focus: McpFocus,
  railwayProbe: RailwayProbeResult | null = null
): string => {
  const selected = focus === "all" ? connections : connections.filter((connection) => connection.id === focus);
  const detailLines = selected.map((connection, index) => {
    return (
      `${index + 1}) ${connection.title} - ` +
      `${connection.configured ? "РґРѕСЃС‚СѓРїРµРЅ" : "С‚СЂРµР±СѓРµС‚ РЅР°СЃС‚СЂРѕР№РєСѓ РґРѕСЃС‚СѓРїР°"} (${connection.authHint}).\n` +
      `   РџРѕР»РёС‚РёРєР°: ${connection.policy}`
    );
  });

  if (focus === "railway") {
    const railway = connections.find((connection) => connection.id === "railway");
    if (!railway) return "Railway MCP: СЃС‚Р°С‚СѓСЃ РЅРµРґРѕСЃС‚СѓРїРµРЅ.";
    return [
      "Railway MCP: С‚РѕС‡РЅС‹Р№ СЃС‚Р°С‚СѓСЃ Рё РїРѕСЂСЏРґРѕРє СЂР°Р±РѕС‚С‹",
      `РЎС‚Р°С‚СѓСЃ: ${railway.configured ? "РґРѕСЃС‚СѓРїРµРЅ" : "С‚СЂРµР±СѓРµС‚ РЅР°СЃС‚СЂРѕР№РєСѓ"} (${railway.authHint}).`,
      `РџРѕР»РёС‚РёРєР°: ${railway.policy}`,
      buildRailwayDevOpsChecklist(railway.configured, railwayProbe),
    ].join("\n");
  }

  if (focus === "github") {
    const github = connections.find((connection) => connection.id === "github");
    if (!github) return "GitHub MCP: СЃС‚Р°С‚СѓСЃ РЅРµРґРѕСЃС‚СѓРїРµРЅ.";
    return [
      "GitHub MCP: С‚РѕС‡РЅС‹Р№ СЃС‚Р°С‚СѓСЃ Рё РїРѕСЂСЏРґРѕРє СЂР°Р±РѕС‚С‹",
      `РЎС‚Р°С‚СѓСЃ: ${github.configured ? "РґРѕСЃС‚СѓРїРµРЅ" : "С‚СЂРµР±СѓРµС‚ РЅР°СЃС‚СЂРѕР№РєСѓ"} (${github.authHint}).`,
      `РџРѕР»РёС‚РёРєР°: ${github.policy}`,
      "Р“РѕС‚РѕРІРЅРѕСЃС‚СЊ DevOps/Developer: РїСЂР°РІРєРё С‚РѕР»СЊРєРѕ РІ СЏРІРЅРѕ РѕРґРѕР±СЂРµРЅРЅРѕРј СЂРµРїРѕР·РёС‚РѕСЂРёРё.",
    ].join("\n");
  }

  if (focus === "sandbox") {
    const sandbox = connections.find((connection) => connection.id === "sandbox");
    if (!sandbox) return "Sandbox Execution: СЃС‚Р°С‚СѓСЃ РЅРµРґРѕСЃС‚СѓРїРµРЅ.";
    return [
      "Sandbox Execution: С‚РѕС‡РЅС‹Р№ СЃС‚Р°С‚СѓСЃ Рё РїРѕСЂСЏРґРѕРє СЂР°Р±РѕС‚С‹",
      `РЎС‚Р°С‚СѓСЃ: ${sandbox.configured ? "РґРѕСЃС‚СѓРїРµРЅ" : "С‚СЂРµР±СѓРµС‚ РЅР°СЃС‚СЂРѕР№РєСѓ"} (${sandbox.authHint}).`,
      `РџРѕР»РёС‚РёРєР°: ${sandbox.policy}`,
      "Р“РѕС‚РѕРІРЅРѕСЃС‚СЊ DevOps: РїСЂРѕРІРµСЂРєРё Рё С‚РµСЃС‚С‹ Р·Р°РїСѓСЃРєР°СЋС‚СЃСЏ РІ РёР·РѕР»СЏС†РёРё.",
    ].join("\n");
  }

  const railway = connections.find((connection) => connection.id === "railway");
  return [
    "Р”РѕСЃС‚СѓРїРЅС‹Рµ MCP Рё РїСЂР°РІРёР»Р° СЂР°Р±РѕС‚С‹:",
    ...detailLines,
    "",
    "Р“РѕС‚РѕРІРЅРѕСЃС‚СЊ DevOps РїРѕ Railway:",
    buildRailwayDevOpsChecklist(Boolean(railway?.configured), railwayProbe),
  ].join("\n");
};

const buildMcpRuntimeContext = (connections: MpcConnectionStatus[]): string => {
  const summary = connections
    .map((connection) => `${connection.title}: ${connection.configured ? "РєР»СЋС‡ РµСЃС‚СЊ" : "РєР»СЋС‡ РЅРµ РЅР°СЃС‚СЂРѕРµРЅ"}`)
    .join("; ");
  return `MCP runtime: ${summary}.`;
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
  completionTokens: number
): Promise<{ agentId: string | null; aggregateTokens: number | null; deltaTokens: number } | null> => {
  if (!isServerSupabaseConfigured) {
    return null;
  }

  try {
    const { data: agent } = await supabase.from("agents").select("id").eq("role", role).maybeSingle();
    const totalTokens = promptTokens + completionTokens;
    const cost = Number(((totalTokens / 1000) * 0.001).toFixed(6));

    await supabase.from("token_logs").insert({
      agent_id: agent?.id ?? null,
      task_id: null,
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

    const { data: usageRows } = await supabase
      .from("token_logs")
      .select("prompt_tokens, completion_tokens")
      .eq("agent_id", agent.id);

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
}: {
  roomKey: string;
  responder: ChatAgentRole;
  agentName: string;
  targetRole: ChatTargetRole;
  scope: TeamEventScope;
  message: string;
  clientMessageId?: string;
}) => {
  await publishTeamEvent({
    roomKey,
    eventName: "chat.agent_response",
    scope,
    senderRole: responder,
    senderName: agentName,
    targetRole: targetRole === "Auto" ? responder : (targetRole as ChatAgentRole | "All"),
    payload: {
      message,
      role: responder,
      agentName,
      coordinator: "PM",
      clientMessageId: clientMessageId ?? null,
      source: "api",
    },
  });
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChatRequestBody;
    const message = body?.message?.trim();
    const roomKey = body?.roomKey?.trim() || DEFAULT_ROOM_KEY;
    const senderName = body?.senderName?.trim() || "РђРґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ CIC";
    const requestedScope = body?.scope?.trim().toLowerCase();
    const clientMessageId = body?.clientMessageId?.trim();
    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const history = normalizeHistory(body.history);
    const roster = await getTeamRoster();
    const { roleSkills, skillCatalog } = await loadRoleSkillContextFromDb();
    const rosterMentionRole = detectRosterMentionRole(message, roster);
    const explicitTarget = rosterMentionRole ?? body.targetRole;
    const intent = routeChatIntent(message, explicitTarget);
    const responder = intent.responderRole;
    const agentName = roster[responder] ?? roleLabel(responder);
    const text = message.toLowerCase();
    const mcpConnections = resolveMcpConnectionStatus();
    const mcpFocus = detectMcpFocus(text);
    const scope = resolveChatScope(requestedScope, intent);
    const hasApproval = hasMarker(text, APPROVAL_MARKERS);
    const wantsExecution = detectExecutionIntent(text, hasApproval);
    const currentRoomSnapshot = await readRoomSnapshot(roomKey);

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
      activeRole: "PM",
      taskStatus: initialTaskStatus,
      metadata: {
        lastMessageAt: new Date().toISOString(),
        lastTargetRole: intent.targetRole,
        lastScope: scope,
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
        coordinator: "PM",
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
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
      const railwayResponder: ChatAgentRole = railwayExecution.requiresApproval ? "PM" : "DevOps";
      const railwayAgentName = roster[railwayResponder] ?? roleLabel(railwayResponder);
      const railwayMessage = [railwayExecution.summary, ...railwayExecution.details]
        .filter(Boolean)
        .join("\n");

      if (railwayExecution.requiresApproval) {
        await patchRoomState({
          roomKey,
          mode: "approval",
          taskStatus: "waiting_approval",
          activeRole: "PM",
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
          senderRole: "PM",
          senderName: roster.PM,
          targetRole: intent.targetRole === "Auto" ? "DevOps" : (intent.targetRole as ChatAgentRole | "All"),
          requiresAck: true,
          payload: {
            message: railwayMessage,
            sourceMessage: message,
            action: railwayExecution.action,
            clientMessageId: clientMessageId ?? null,
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
          activeRole: "DevOps",
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
          senderRole: "DevOps",
          senderName: roster.DevOps,
          targetRole: intent.targetRole === "Auto" ? "DevOps" : (intent.targetRole as ChatAgentRole | "All"),
          payload: {
            action: railwayExecution.action,
            ok: railwayExecution.ok,
            summary: railwayExecution.summary,
            details: railwayExecution.details,
            clientMessageId: clientMessageId ?? null,
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
        coordinator: "PM",
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
        message: railwayMessage,
      });
    }

    if (hasApproval) {
      if (!isServerSupabaseConfigured) {
        const infoMessage =
          "PM: подтверждение получено, но Supabase не настроен. Автозапуск workflow недоступен в этой среде.";
        await publishAgentResponseEvent({
          roomKey,
          responder: "PM",
          agentName: roster.PM,
          targetRole: intent.targetRole,
          scope,
          message: infoMessage,
          clientMessageId,
        });
        return NextResponse.json({
          role: "PM",
          agentName: roster.PM,
          coordinator: "PM",
          targetRole: intent.targetRole,
          scope,
          clientMessageId: clientMessageId ?? null,
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
            responder: "PM",
            agentName: roster.PM,
            targetRole: intent.targetRole,
            scope,
            message: alreadyRunningMessage,
            clientMessageId,
          });
          return NextResponse.json({
            role: "PM",
            agentName: roster.PM,
            coordinator: "PM",
            targetRole: intent.targetRole,
            scope,
            clientMessageId: clientMessageId ?? null,
            message: alreadyRunningMessage,
          });
        }
      }

      const executionInput = resolveApprovedTaskInput(message, history).trim();
      const normalizedTargetRole = intent.targetRole === "Auto" ? "All" : intent.targetRole;

      try {
        const { data: task, error: taskError } = await supabase
          .from("tasks")
          .insert({
            title: createChatTaskTitle(executionInput),
            description: executionInput,
            status: "pending",
            metadata: {
              approved: true,
              approved_at: new Date().toISOString(),
              targetRole: normalizedTargetRole,
              initiatedBy: "chat",
            },
          })
          .select("id")
          .single();

        if (taskError || !task?.id) {
          throw taskError ?? new Error("task_insert_failed");
        }

        await patchRoomState({
          roomKey,
          mode: "execution",
          taskStatus: "in_progress",
          activeRole: "PM",
          pendingTaskId: task.id as string,
          metadata: {
            executionQueuedBy: "chat",
            executionQueuedAt: new Date().toISOString(),
            targetRole: normalizedTargetRole,
          },
        });

        await publishTeamEvent({
          roomKey,
          eventName: "workflow.execution_queued",
          scope,
          senderRole: "PM",
          senderName: roster.PM,
          targetRole: normalizedTargetRole as ChatAgentRole | "All",
          payload: {
            taskId: task.id,
            targetRole: normalizedTargetRole,
            sourceMessage: executionInput,
            clientMessageId: clientMessageId ?? null,
          },
        });

        const runUrl = new URL("/api/agents/run", req.url).toString();
        void fetch(runUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: task.id,
            input: executionInput,
            targetRole: normalizedTargetRole,
            approved: true,
            roomKey,
          }),
        }).catch(async (error: unknown) => {
          await logSystemEvent({
            level: "error",
            scope: "agents.chat",
            event: "chat_execution_start_failed",
            taskId: task.id as string,
            metadata: {
              reason: error instanceof Error ? error.message : "run_api_unreachable",
            },
          });
        });

        const startedMessage =
          `PM: подтверждение получено. Выполнение запущено.\n` +
          `Task ID: ${task.id}\n` +
          `Режим: execution\n` +
          `Цель: ${normalizedTargetRole}.`;

        await publishAgentResponseEvent({
          roomKey,
          responder: "PM",
          agentName: roster.PM,
          targetRole: intent.targetRole,
          scope,
          message: startedMessage,
          clientMessageId,
        });

        await logSystemEvent({
          scope: "agents.chat",
          event: "chat_execution_queued",
          taskId: task.id as string,
          metadata: {
            targetRole: normalizedTargetRole,
            source: "chat",
            scope,
          },
        });

        return NextResponse.json({
          role: "PM",
          agentName: roster.PM,
          coordinator: "PM",
          targetRole: intent.targetRole,
          scope,
          clientMessageId: clientMessageId ?? null,
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
      });
      return NextResponse.json({
        role: responder,
        agentName,
        coordinator: "PM",
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
        message: greeting,
      });
    }

    if (wantsExecution && !hasApproval) {
      const approvalMessage = buildApprovalRequest(intent.targetRole, roster);
      await patchRoomState({
        roomKey,
        mode: "approval",
        taskStatus: "waiting_approval",
        activeRole: "PM",
        metadata: {
          waitingForApproval: true,
          approvalReason: "execution_marker_detected_without_explicit_approval",
        },
      });
      await publishTeamEvent({
        roomKey,
        eventName: "workflow.approval_requested",
        scope,
        senderRole: "PM",
        senderName: roster.PM,
        targetRole: intent.targetRole === "Auto" ? responder : (intent.targetRole as ChatAgentRole | "All"),
        requiresAck: true,
        payload: {
          message: approvalMessage,
          sourceMessage: message,
          clientMessageId: clientMessageId ?? null,
        },
      });
      await publishAgentResponseEvent({
        roomKey,
        responder: "PM",
        agentName: roster.PM,
        targetRole: intent.targetRole,
        scope,
        message: approvalMessage,
        clientMessageId,
      });
      await logSystemEvent({
        scope: "agents.chat",
        event: "chat_waiting_for_approval",
        metadata: { responder, targetRole: intent.targetRole },
      });
      return NextResponse.json({
        role: "PM",
        agentName: roster.PM,
        coordinator: "PM",
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
        message: approvalMessage,
      });
    }

    if (intent.needsClarification) {
      const clarificationMessage = buildClarification(intent.targetRole);
      await patchRoomState({
        roomKey,
        mode: "discussion",
        activeRole: "PM",
        taskStatus: "pending",
        metadata: { needsClarification: true },
      });
      await publishAgentResponseEvent({
        roomKey,
        responder: "PM",
        agentName: roster.PM,
        targetRole: intent.targetRole,
        scope,
        message: clarificationMessage,
        clientMessageId,
      });
      await logSystemEvent({
        scope: "agents.chat",
        event: "chat_clarification_requested",
        metadata: { responder, targetRole: intent.targetRole },
      });
      return NextResponse.json({
        role: "PM",
        agentName: roster.PM,
        coordinator: "PM",
        targetRole: intent.targetRole,
        scope,
        clientMessageId: clientMessageId ?? null,
        message: clarificationMessage,
      });
    }

    const executionMode = hasApproval
      ? "User explicitly approved execution. Execution phase is allowed."
      : "No explicit execution approval. Discussion, analysis, and planning only.";
    const roleSkillBlock = buildRoleSkillsPromptBlock(responder, roleSkills, skillCatalog);
    const teamSkillBlock = buildTeamSkillsPromptBlock(roleSkills);

    const promptHeader =
      `You are ${roleLabelRu(responder)} in Pixel Office CIC.\n` +
      `Team roster: PM ${roster.PM}, Developer ${roster.Developer}, QA ${roster.QA}, DevOps ${roster.DevOps}.\n` +
      "Communication flow goes through PM.\n" +
      `${buildMcpRuntimeContext(mcpConnections)}\n` +
      `${teamSkillBlock}\n` +
      `${roleSkillBlock}\n` +
      executionMode +
      "\n" +
      (intent.targetRole === "All"
        ? "This is a team-wide request. Return a coordinated plan by role."
        : `This request is addressed to role: ${roleLabelRu(responder)}.`) +
      "\nConsultant mode: if user asks clarifications, explain simply with short examples. Execute only after explicit approval.\n" +
      "\nPM behavior policy:\n" +
      "- Ask at most 1-2 critical clarifying questions only when truly blocking.\n" +
      "- Do not ask about budget, deadlines, business economics, or target audience unless user explicitly asks for that analysis.\n" +
      "- If request is clear enough, proceed with assumptions and provide a concrete build plan immediately.\n" +
      "- Prefer action-oriented next steps over long questionnaires.\n" +
      "- If user says 'на ваше усмотрение' / 'вперед' / 'делайте', treat it as permission to proceed with MVP assumptions.\n" +
      "\nAnswer formally and in Russian with concrete next actions.\n" +
      TEAM_RULES;

    const modelMessages = [
      new SystemMessage(`${AGENT_PROMPTS[responder]}\n${promptHeader}`),
      ...history.map((item) =>
        item.role === "user" ? new HumanMessage(item.content) : new AIMessage(item.content)
      ),
      new HumanMessage(message),
    ];

    await setRoleTypingState(responder, true, roomKey);
    await patchPlayerStateByRole(responder, {
      roomKey,
      status: "typing",
      metadata: { reason: "chat_inference" },
    });

    let completion: AgentInvocationResult;
    try {
      completion = await withTimeout(invokeAgentModel(responder, modelMessages), 14000);
    } catch {
      completion = {
        content:
          "PM: СЃРµС‚СЊ РЅРµСЃС‚Р°Р±РёР»СЊРЅР°, РїСЂРѕРґРѕР»Р¶Р°РµРј РІ fallback-СЂРµР¶РёРјРµ. РЈС‚РѕС‡РЅРёС‚Рµ С†РµР»СЊ Рё РїРѕРґС‚РІРµСЂРґРёС‚Рµ Р·Р°РїСѓСЃРє, Р·Р°С‚РµРј РЅР°С‡РЅРµРј.",
        model: "fallback",
        promptTokens: 0,
        completionTokens: 0,
      };
    }

    const rawReply = String(completion.content ?? "").trim();
    const normalizedRawReply =
      rawReply || "PM: Р·Р°РїСЂРѕСЃ РїСЂРёРЅСЏС‚, РїСЂРѕРґРѕР»Р¶Р°РµРј СЂР°Р±РѕС‚Сѓ РїРѕ Р·Р°РґР°С‡Рµ.";
    const reply =
      responder === "PM" && !hasApproval ? maybeSimplifyPmReply(normalizedRawReply) : normalizedRawReply;
    const usageSync = await persistChatUsage(
      responder,
      completion.model,
      completion.promptTokens,
      completion.completionTokens
    );

    if (usageSync?.aggregateTokens !== null) {
      await syncRoleTokenUsage(responder, usageSync.aggregateTokens, roomKey);
    }

    await setRoleTypingState(responder, false, roomKey);
    await patchPlayerStateByRole(responder, {
      roomKey,
      status: hasApproval ? "working" : "waiting",
      metadata: {
        lastReplyAt: new Date().toISOString(),
        lastModel: completion.model,
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
      metadata: {
        lastResponder: responder,
        lastResponderName: agentName,
        lastResponseAt: new Date().toISOString(),
      },
    });

    await publishAgentResponseEvent({
      roomKey,
      responder,
      agentName,
      targetRole: intent.targetRole,
      scope,
      message: reply,
      clientMessageId,
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
      },
    });

    return NextResponse.json({
      role: responder,
      agentName,
      coordinator: "PM",
      targetRole: intent.targetRole,
      scope,
      clientMessageId: clientMessageId ?? null,
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


