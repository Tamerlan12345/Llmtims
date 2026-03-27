import { NextRequest, NextResponse } from "next/server";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AGENT_PROMPTS, TEAM_RULES } from "@/lib/agents/prompts";
import { invokeAgentModel } from "@/lib/agents/tools";
import {
  routeChatIntent,
  roleLabel,
  roleLabelRu,
  type ChatAgentRole,
  type ChatTargetRole,
} from "@/lib/agents/chatRouter";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

interface ChatHistoryItem {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  message?: string;
  history?: ChatHistoryItem[];
  targetRole?: ChatTargetRole | string;
}

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
    PM: "PM",
    Developer: "Developer",
    QA: "QA",
    DevOps: "DevOps",
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

const buildClarification = (targetRole: ChatTargetRole): string => {
  const target =
    targetRole === "All" || targetRole === "Auto"
      ? "команды"
      : `роли ${roleLabelRu(targetRole as ChatAgentRole)}`;

  return (
    `Нужны уточнения для ${target}:\n` +
    "1) Какой конечный результат нужен?\n" +
    "2) Какой срок/приоритет?\n" +
    "3) Ограничения по стеку или инфраструктуре?\n" +
    "4) Делать задачу для всей команды или для конкретной роли?"
  );
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChatRequestBody;
    const message = body?.message?.trim();
    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const history = normalizeHistory(body.history);
    const intent = routeChatIntent(message, body.targetRole);
    const roster = await getTeamRoster();
    const responder = intent.responderRole;
    const agentName = roster[responder] ?? roleLabel(responder);

    if (intent.needsClarification) {
      return NextResponse.json({
        role: "PM",
        agentName: roster.PM,
        coordinator: "PM",
        targetRole: intent.targetRole,
        message: buildClarification(intent.targetRole),
      });
    }

    const promptHeader =
      `Ты ${roleLabelRu(responder)} в CentrasDEVTEAM.\n` +
      `PM в команде: ${roster.PM}. Developer: ${roster.Developer}. QA: ${roster.QA}. DevOps: ${roster.DevOps}.\n` +
      `Все коммуникации проходят через PM.\n` +
      (intent.targetRole === "All"
        ? "Это общая задача для всей команды: выдай скоординированный план по ролям."
        : `Задача адресована роли: ${roleLabelRu(responder)}.`) +
      "\nОтвечай на русском, четко и с конкретными next actions.\n" +
      TEAM_RULES;

    const modelMessages = [
      new SystemMessage(`${AGENT_PROMPTS[responder]}\n${promptHeader}`),
      ...history.map((item) =>
        item.role === "user" ? new HumanMessage(item.content) : new AIMessage(item.content)
      ),
      new HumanMessage(message),
    ];

    let completion;
    try {
      completion = await withTimeout(invokeAgentModel(responder, modelMessages), 14000);
    } catch {
      completion = {
        content:
          "PM: сеть нестабильна, продолжаем в fallback-режиме. Подтвердите цель, срок и ответственного, затем сразу стартуем.",
      };
    }

    const rawReply = String((completion as { content?: string }).content ?? "").trim();
    const reply = rawReply || "PM: запрос принят, продолжаем работу по задаче.";
    const coordinatorPrefix =
      responder === "PM" ? "" : `PM -> ${roleLabelRu(responder)}: `;

    return NextResponse.json({
      role: responder,
      agentName,
      coordinator: "PM",
      targetRole: intent.targetRole,
      broadcast: intent.broadcast,
      message: `${coordinatorPrefix}${reply}`,
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "chat failed";
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
