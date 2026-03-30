import { NextRequest, NextResponse } from "next/server";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AGENT_PROMPTS, TEAM_RULES } from "@/lib/agents/prompts";
import { invokeAgentModel, type AgentInvocationResult } from "@/lib/agents/tools";
import { logSystemEvent } from "@/lib/agents/persistence";
import {
  routeChatIntent,
  roleLabel,
  roleLabelRu,
  type ChatAgentRole,
  type ChatTargetRole,
} from "@/lib/agents/chatRouter";
import { loadServerEnv } from "@/lib/config/serverEnv";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

loadServerEnv();

interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  message?: string;
  history?: ChatHistoryItem[];
  targetRole?: ChatTargetRole | string;
}

const APPROVAL_MARKERS = [
  "подтверждаю",
  "утверждаю",
  "approve",
  "go",
  "начинай",
  "запускай",
  "можно выполнять",
];

const EXECUTION_MARKERS = [
  "сделай",
  "выполни",
  "реализуй",
  "почини",
  "запусти",
  "деплой",
  "исправь",
  "нужно сделать",
  "надо сделать",
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
};

const hasAnyEnvKey = (...keys: string[]) => keys.some((key) => Boolean(process.env[key]));

const resolveMcpConnectionStatus = (): MpcConnectionStatus[] => {
  const githubConfigured = hasAnyEnvKey(
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_APP_ID",
    "GITHUB_PRIVATE_KEY"
  );
  const railwayConfigured = hasAnyEnvKey("RAILWAY_TOKEN", "RAILWAY_API_TOKEN");

  return [
    {
      id: "github",
      title: "GitHub MCP",
      configured: githubConfigured,
      authHint: githubConfigured ? "ключ найден в окружении" : "ключ не найден в окружении",
      policy:
        "Правки только в репозитории, который вы явно указали и одобрили. При необходимости создаем новый репозиторий по вашему названию.",
    },
    {
      id: "railway",
      title: "Railway MCP",
      configured: railwayConfigured,
      authHint: railwayConfigured ? "ключ найден в окружении" : "ключ не найден в окружении",
      policy:
        "Существующие сервисы read-only. Изменяем только сервисы, созданные под задачу после согласования.",
    },
    {
      id: "sandbox",
      title: "Sandbox Execution",
      configured: true,
      authHint: "доступен в текущем runtime",
      policy:
        "Проверки и тесты выполняем в изоляции. Не ломаем действующие проекты, под задачу используем отдельный контейнер/ветку.",
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
    PM: "Айгерім",
    Developer: "Алексей",
    QA: "Алуа",
    DevOps: "Илья",
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
  const hasInfoIntent = text.includes("?") || MCP_INFO_MARKERS.some((marker) => text.includes(marker));
  return hasMcpDomainKeyword && hasInfoIntent;
};

const buildClarification = (targetRole: ChatTargetRole): string => {
  const target =
    targetRole === "All" || targetRole === "Auto"
      ? "команды"
      : `роли ${roleLabelRu(targetRole as ChatAgentRole)}`;

  return (
    `Нужны уточнения для ${target}:\n` +
    "1) Какой конечный результат нужен?\n" +
    "2) Какой срок и приоритет?\n" +
    "3) Есть ли ограничения по стеку или инфраструктуре?\n" +
    "4) Оставляем обсуждение или запускаем выполнение после подтверждения?"
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
    'Для старта выполнения напишите: "подтверждаю запуск".'
  );
};

const buildFormalGreeting = (responderName: string): string => {
  return `Здравствуйте. На связи ${responderName}. Готов(а) к формальному обсуждению задачи.`;
};

const buildMcpCapabilitiesMessage = (connections: MpcConnectionStatus[]): string => {
  const detailLines = connections.map((connection, index) => {
    return (
      `${index + 1}) ${connection.title} - ` +
      `${connection.configured ? "доступен" : "требует настройку доступа"} (${connection.authHint}).\n` +
      `   Политика: ${connection.policy}`
    );
  });

  return ["Доступные MCP и правила работы:", ...detailLines].join("\n");
};

const buildMcpRuntimeContext = (connections: MpcConnectionStatus[]): string => {
  const summary = connections
    .map((connection) => `${connection.title}: ${connection.configured ? "ключ есть" : "ключ не настроен"}`)
    .join("; ");
  return `MCP runtime: ${summary}.`;
};

const persistChatUsage = async (
  role: ChatAgentRole,
  model: string,
  promptTokens: number,
  completionTokens: number
) => {
  if (!isServerSupabaseConfigured) {
    return;
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
  } catch (error) {
    console.error(`[Usage] Failed to persist chat usage for ${role}:`, error);
  }
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChatRequestBody;
    const message = body?.message?.trim();
    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const history = normalizeHistory(body.history);
    const roster = await getTeamRoster();
    const rosterMentionRole = detectRosterMentionRole(message, roster);
    const explicitTarget = rosterMentionRole ?? body.targetRole;
    const intent = routeChatIntent(message, explicitTarget);
    const responder = intent.responderRole;
    const agentName = roster[responder] ?? roleLabel(responder);
    const mcpConnections = resolveMcpConnectionStatus();
    const text = message.toLowerCase();
    const hasApproval = hasMarker(text, APPROVAL_MARKERS);
    const wantsExecution = hasMarker(text, EXECUTION_MARKERS);

    await logSystemEvent({
      scope: "agents.chat",
      event: "chat_message_received",
      metadata: {
        responder,
        targetRole: intent.targetRole,
        messageLength: message.length,
      },
    });

    if (isMcpQuestion(text)) {
      const mcpMessage = buildMcpCapabilitiesMessage(mcpConnections);
      await logSystemEvent({
        scope: "agents.chat",
        event: "chat_mcp_capabilities_shared",
        metadata: {
          responder,
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
        message: mcpMessage,
      });
    }

    if (!wantsExecution && !hasApproval && isGreetingMessage(text) && message.length < 80) {
      const greeting = buildFormalGreeting(agentName);
      return NextResponse.json({
        role: responder,
        agentName,
        coordinator: "PM",
        targetRole: intent.targetRole,
        message: greeting,
      });
    }

    if (wantsExecution && !hasApproval) {
      const approvalMessage = buildApprovalRequest(intent.targetRole, roster);
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
        message: approvalMessage,
      });
    }

    if (intent.needsClarification) {
      const clarificationMessage = buildClarification(intent.targetRole);
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
        message: clarificationMessage,
      });
    }

    const executionMode = hasApproval
      ? "Пользователь подтвердил запуск. Можно переходить к выполнению."
      : "Подтверждения запуска нет. Только обсуждение, анализ и план без утверждения выполнения.";

    const promptHeader =
      `Ты ${roleLabelRu(responder)} в Pixel Office CIC.\n` +
      `Команда: PM ${roster.PM}, Developer ${roster.Developer}, QA ${roster.QA}, DevOps ${roster.DevOps}.\n` +
      "Коммуникации проходят через PM.\n" +
      `${buildMcpRuntimeContext(mcpConnections)}\n` +
      executionMode +
      "\n" +
      (intent.targetRole === "All"
        ? "Это общая задача для всей команды: дай скоординированный план по ролям."
        : `Задача адресована роли: ${roleLabelRu(responder)}.`) +
      "\nОтвечай формально и на русском, четко, с конкретными next actions.\n" +
      TEAM_RULES;

    const modelMessages = [
      new SystemMessage(`${AGENT_PROMPTS[responder]}\n${promptHeader}`),
      ...history.map((item) =>
        item.role === "user" ? new HumanMessage(item.content) : new AIMessage(item.content)
      ),
      new HumanMessage(message),
    ];

    let completion: AgentInvocationResult;
    try {
      completion = await withTimeout(invokeAgentModel(responder, modelMessages), 14000);
    } catch {
      completion = {
        content:
          "PM: сеть нестабильна, продолжаем в fallback-режиме. Уточните цель и подтвердите запуск, затем начнем.",
        model: "fallback",
        promptTokens: 0,
        completionTokens: 0,
      };
    }

    const rawReply = String(completion.content ?? "").trim();
    const reply = rawReply || "PM: запрос принят, продолжаем работу по задаче.";
    await persistChatUsage(
      responder,
      completion.model,
      completion.promptTokens,
      completion.completionTokens
    );

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
      },
    });

    return NextResponse.json({
      role: responder,
      agentName,
      coordinator: "PM",
      targetRole: intent.targetRole,
      broadcast: intent.broadcast,
      message: reply,
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
