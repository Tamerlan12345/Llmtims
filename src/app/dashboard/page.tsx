"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { supabase, isMockMode } from "@/lib/supabase/client";
import OfficeHub from "@/components/OfficeHub";
import { TaskStatus } from "@/lib/office/engine";

/* в”Ђв”Ђв”Ђ Types в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
interface Agent {
  id: string;
  name: string;
  role: "PM" | "Developer" | "QA" | "DevOps" | string;
  status?: string;
  avatar_url?: string;
  is_active: boolean;
}

interface TokenLog {
  agent_id?: string | null;
  prompt_tokens?: number | string;
  completion_tokens?: number | string;
}

interface TaskRecord {
  id: string;
  status: TaskStatus;
}

type RoleTarget = "Auto" | "All" | "PM" | "Developer" | "QA" | "DevOps";
type TeamEventScope = "broadcast" | "targeted" | "system";
type ChatScope = "auto" | "broadcast" | "targeted";
type RoomMode = "discussion" | "approval" | "execution";

interface ChatMessage {
  id: string;
  sender: "user" | "agent";
  content: string;
  role?: string;
  agentName?: string;
  coordinator?: string;
  scope?: TeamEventScope;
  targetRole?: RoleTarget | null;
  clientMessageId?: string | null;
  createdAt?: string;
}

interface MentionOption {
  id: string;
  role: RoleTarget;
  label: string;
  handle: string;
  isOnline: boolean;
  status: string;
}

interface RoomStateRow {
  room_key: string;
  mode: RoomMode;
  task_status: TaskStatus;
  active_role: string | null;
  pending_task_id: string | null;
  revision: number;
}

interface PlayerStateRow {
  agent_id: string;
  role: string;
  status: string;
  is_online: boolean;
  typing_until?: string | null;
  tokens_total?: number | string;
}

interface TeamEventRow {
  id: string;
  room_key: string;
  event_name: string;
  scope: TeamEventScope;
  sender_role: string | null;
  sender_name: string | null;
  target_role: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

interface ApprovalDraft {
  taskId: string;
  input: string;
  targetRole: RoleTarget;
}

type ProcessTone = "info" | "run" | "ok" | "warn" | "error";

interface ProcessStep {
  id: string;
  label: string;
  detail: string;
  time: string;
  tone: ProcessTone;
}

/* в”Ђв”Ђв”Ђ Constants в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
const MOCK_AGENTS: Agent[] = [
  { id: "1", name: "Айгерім", role: "PM", is_active: true },
  { id: "2", name: "Алексей", role: "Developer", is_active: false },
  { id: "3", name: "Алуа", role: "QA", is_active: false },
  { id: "4", name: "Илья", role: "DevOps", is_active: false },
];

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const formatTokenCompact = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 50) return "<0.1к";
  const inK = value / 1000;
  if (value < 1000) return `${inK.toFixed(1)}к`;
  if (value < 10000) return `${inK.toFixed(1)}к`;
  return `${Math.round(inK)}к`;
};

const mentionHandleByRole: Record<Exclude<RoleTarget, "Auto" | "All">, string> = {
  PM: "pm",
  Developer: "developer",
  QA: "qa",
  DevOps: "devops",
};

const normalizeMentionValue = (value: string) => value.trim().toLowerCase();

const compactMentionValue = (value: string) => normalizeMentionValue(value).replace(/\s+/g, "");

const extractFirstName = (value: string) => normalizeMentionValue(value).split(/\s+/)[0] ?? "";

const matchMentionOption = (option: MentionOption, token: string) => {
  const normalizedToken = normalizeMentionValue(token);
  if (!normalizedToken) return false;

  return (
    option.handle.toLowerCase() === normalizedToken ||
    option.role.toLowerCase() === normalizedToken ||
    normalizeMentionValue(option.label) === normalizedToken ||
    compactMentionValue(option.label) === normalizedToken ||
    extractFirstName(option.label) === normalizedToken
  );
};

const roleTargetLabel: Record<RoleTarget, string> = {
  Auto:      "Авто (через PM)",
  All:       "Вся команда",
  PM:        "PM",
  Developer: "Developer",
  QA:        "QA",
  DevOps:    "DevOps",
};

const statusMeta: Record<string, { label: string; color: string }> = {
  pending:           { label: "Ожидание",          color: "#F59E0B" },
  in_progress:       { label: "В работе",          color: "#E8001E" },
  review:            { label: "Ревью",             color: "#F97316" },
  waiting_approval:  { label: "Ждет подтверждения", color: "#F97316" },
  done:              { label: "Готово",            color: "#10B981" },
  failed:            { label: "Сбой",              color: "#EF4444" },
};

const roomModeMeta: Record<RoomMode, { label: string; color: string }> = {
  discussion: { label: "Обсуждение", color: "#F59E0B" },
  approval: { label: "Подтверждение", color: "#F97316" },
  execution: { label: "Выполнение", color: "#E8001E" },
};

const scopeMeta: Record<TeamEventScope, string> = {
  broadcast: "Всем",
  targeted: "Адресно",
  system: "Система",
};

const processToneMeta: Record<ProcessTone, { color: string; border: string; background: string }> = {
  info: { color: "#FBCFE8", border: "rgba(244,114,182,0.28)", background: "rgba(76,5,25,0.32)" },
  run: { color: "#FED7AA", border: "rgba(251,146,60,0.34)", background: "rgba(66,24,6,0.32)" },
  ok: { color: "#A7F3D0", border: "rgba(16,185,129,0.34)", background: "rgba(4,39,28,0.35)" },
  warn: { color: "#FDE68A", border: "rgba(245,158,11,0.34)", background: "rgba(61,38,6,0.35)" },
  error: { color: "#FCA5A5", border: "rgba(239,68,68,0.34)", background: "rgba(68,12,12,0.35)" },
};

const DEFAULT_ROOM_KEY = "pixel-office-cic";

const isValidRoleTarget = (value: string | null | undefined): value is Exclude<RoleTarget, "Auto"> => {
  return value === "All" || value === "PM" || value === "Developer" || value === "QA" || value === "DevOps";
};

const normalizeRoleTarget = (value: string | null | undefined): RoleTarget | null => {
  if (!value) return null;
  if (isValidRoleTarget(value)) return value;
  return null;
};

const isTypingState = (status: string, typingUntil?: string | null): boolean => {
  if (status !== "typing") return false;
  if (!typingUntil) return true;
  return new Date(typingUntil).getTime() > Date.now();
};

const extractEventMessage = (payload: Record<string, unknown> | null): string | null => {
  if (!payload) return null;
  const value = payload.message;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
};

const extractClientMessageId = (payload: Record<string, unknown> | null): string | null => {
  if (!payload) return null;
  const value = payload.clientMessageId;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
};

/* в”Ђв”Ђв”Ђ SVG Icon helpers в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
const IconSend = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2L11 13"/>
    <path d="M22 2L15 22 11 13 2 9l20-7z"/>
  </svg>
);

const IconPlay = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>
);

const IconSpinner = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
);

const IconDot = ({ color }: { color: string }) => (
  <span className="relative flex h-2 w-2">
    <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ backgroundColor: color }} />
    <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
  </span>
);

const IconUser = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

/* в”Ђв”Ђв”Ђ Component в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
export default function DashboardPage() {
  const [mounted,              setMounted]              = useState(false);
  const [agents,               setAgents]               = useState<Agent[]>(isMockMode ? MOCK_AGENTS : []);
  const [totalTokens,          setTotalTokens]          = useState(0);
  const [agentTokenUsage,      setAgentTokenUsage]      = useState<Record<string, number>>({});
  const [roomMode,             setRoomMode]             = useState<RoomMode>("discussion");
  const [roomRevision,         setRoomRevision]         = useState(0);
  const [pendingTaskId,        setPendingTaskId]        = useState<string | null>(null);
  const [approvalDraft,        setApprovalDraft]        = useState<ApprovalDraft | null>(null);
  const [chatScope,            setChatScope]            = useState<ChatScope>("auto");
  const [typingRoles,          setTypingRoles]          = useState<string[]>([]);
  const [playerStateByRole,    setPlayerStateByRole]    = useState<Record<string, { status: string; isOnline: boolean }>>({});
  const [eventFeed,            setEventFeed]            = useState<string[]>([]);
  const [processFeed,          setProcessFeed]          = useState<ProcessStep[]>([]);
  const [activeMenuPanel,      setActiveMenuPanel]      = useState<"tools" | "events" | "mode" | "process" | null>(null);
  const [activeZone,           setActiveZone]           = useState<"office" | "task" | "chat" | null>(null);
  const [taskInput,            setTaskInput]            = useState("");
  const [taskTargetRole,       setTaskTargetRole]       = useState<RoleTarget>("All");
  const [isRunning,            setIsRunning]            = useState(false);
  const [taskStatus,           setTaskStatus]           = useState<TaskStatus>(isMockMode ? "in_progress" : "pending");
  const [chatInput,            setChatInput]            = useState("");
  const [chatTargetRole,       setChatTargetRole]       = useState<RoleTarget>("Auto");
  const [chatLoading,          setChatLoading]          = useState(false);
  const [showEnvComposer,      setShowEnvComposer]      = useState(false);
  const [envServiceName,       setEnvServiceName]       = useState("task-app");
  const [envKey,               setEnvKey]               = useState("");
  const [envValue,             setEnvValue]             = useState("");
  const [envDeployAfterSet,    setEnvDeployAfterSet]    = useState(true);
  const [chatMessages,         setChatMessages]         = useState<ChatMessage[]>([
    {
      id: "boot",
      sender: "agent",
      agentName: "PM",
      role: "PM",
      coordinator: "PM",
      content: "Центр управления активирован. Работаем в режиме обсуждения: сначала согласование, затем выполнение после подтверждения.",
    },
  ]);
  const [speakingAgentId,      setSpeakingAgentId]      = useState<string | null>(null);
  const [interactionTargetRole, setInteractionTargetRole] = useState<string | null>(null);
  const [isLoggingOut,         setIsLoggingOut]         = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenClientMessageIdsRef = useRef<Set<string>>(new Set());

  const activeAgent = useMemo(() => agents.find((a) => a.is_active), [agents]);
  const currentStatus = statusMeta[taskStatus] ?? { label: taskStatus, color: "#9CA3AF" };
  const currentRoomMode = roomModeMeta[roomMode];
  const typingLabel = useMemo(() => {
    if (typingRoles.length === 0) return null;
    if (typingRoles.length === 1) return `${typingRoles[0]} печатает...`;
    return `${typingRoles.join(", ")} печатают...`;
  }, [typingRoles]);

  const zoneHint = useMemo(() => {
    if (activeZone === "task") {
      return "Зона задач: сначала согласование, затем подтверждение запуска.";
    }
    if (activeZone === "chat") {
      return "Зона чата: адресные и общие сообщения, @упоминания берутся из базы сотрудников.";
    }
    if (activeZone === "office") {
      return "Зона офиса: статус ролей и токены синхронизируются через room/player state.";
    }
    return "Рабочий режим: обсуждение -> подтверждение -> выполнение.";
  }, [activeZone]);

  const mentionDirectory = useMemo<MentionOption[]>(() => {
    const rosterSource = agents.length > 0 ? agents : MOCK_AGENTS;
    return rosterSource
      .filter((agent) =>
        agent.role === "PM" ||
        agent.role === "Developer" ||
        agent.role === "QA" ||
        agent.role === "DevOps"
      )
      .map((agent) => ({
        id: agent.id,
        role: agent.role as RoleTarget,
        label: agent.name,
        handle: mentionHandleByRole[agent.role as Exclude<RoleTarget, "Auto" | "All">],
        isOnline: playerStateByRole[agent.role]?.isOnline ?? true,
        status: playerStateByRole[agent.role]?.status ?? "idle",
      }))
      .sort((left, right) => {
        if (left.isOnline !== right.isOnline) return left.isOnline ? -1 : 1;
        return left.label.localeCompare(right.label, "ru");
      });
  }, [agents, playerStateByRole]);

  const quickPrompts = useMemo(() => {
    const byRole = Object.fromEntries(
      mentionDirectory.map((entry) => [entry.role, entry.label])
    ) as Record<string, string>;

    return [
      `@${byRole.PM ?? "PM"} общий статус команды`,
      `@${byRole.Developer ?? "Developer"} нужна реализация auth модуля`,
      `@${byRole.QA ?? "QA"} проверь регрессию по чату`,
      `@${byRole.DevOps ?? "DevOps"} оцени риски деплоя`,
      "@all подготовьте план релиза",
    ];
  }, [mentionDirectory]);

  const mentionMatch = useMemo(() => {
    return chatInput.match(/(?:^|\s)@([^\s@]*)$/);
  }, [chatInput]);

  const mentionSuggestions = useMemo(() => {
    if (!mentionMatch) return [];
    const query = mentionMatch[1].trim().toLowerCase();
    return mentionDirectory
      .filter((option) => {
        if (!query) return true;
        return (
          option.label.toLowerCase().includes(query) ||
          compactMentionValue(option.label).includes(query) ||
          extractFirstName(option.label).includes(query) ||
          option.handle.toLowerCase().includes(query) ||
          option.role.toLowerCase().includes(query)
        );
      })
      .slice(0, 6);
  }, [mentionDirectory, mentionMatch]);

  const applyMention = (option: MentionOption) => {
    setChatTargetRole(option.role);
    setChatInput((previous) => {
      const match = previous.match(/(?:^|\s)@([^\s@]*)$/);
      if (!match || match.index === undefined) {
        return `${previous.trimEnd()} @${option.label} `;
      }

      const hasLeadingSpace = match[0].startsWith(" ");
      const replaceStart = match.index + (hasLeadingSpace ? 1 : 0);
      const prefix = previous.slice(0, replaceStart);
      return `${prefix}@${option.label} `;
    });
    window.requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  };

  const applyQuickPrompt = (prompt: string) => {
    setChatInput(prompt);
    const mention = prompt.match(/^@([^\s@]+)/)?.[1]?.toLowerCase();
    if (!mention) return;

    const matched = mentionDirectory.find((option) => matchMentionOption(option, mention));
    if (matched) {
      setChatTargetRole(matched.role);
    }
  };

  const resolveMentionTargetRole = (message: string): RoleTarget => {
    const mentionToken = message.match(/@([^\s@]+)/)?.[1]?.toLowerCase();
    if (!mentionToken) return chatTargetRole;
    if (mentionToken === "all") return "All";

    const byDirectory = mentionDirectory.find((option) =>
      matchMentionOption(option, mentionToken)
    );
    if (byDirectory) {
      return byDirectory.role;
    }

    if (mentionToken === "pm") return "PM";
    if (mentionToken === "developer" || mentionToken === "dev") return "Developer";
    if (mentionToken === "qa") return "QA";
    if (mentionToken === "devops" || mentionToken === "ops") return "DevOps";

    return chatTargetRole;
  };

  const appendChatMessage = (entry: ChatMessage) => {
    setChatMessages((previous) => {
      if (
        entry.clientMessageId &&
        previous.some(
          (item) =>
            item.clientMessageId === entry.clientMessageId &&
            item.sender === entry.sender &&
            item.content === entry.content
        )
      ) {
        return previous;
      }
      const next = [...previous, entry];
      return next.slice(-120);
    });
  };

  const appendEventFeed = (line: string) => {
    setEventFeed((previous) => [line, ...previous].slice(0, 20));
  };

  const formatProcessTime = (value?: string) => {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return "--:--";
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  };

  const appendProcessStep = (step: ProcessStep) => {
    setProcessFeed((previous) => {
      if (previous.some((item) => item.id === step.id)) return previous;
      return [step, ...previous].slice(0, 30);
    });
  };

  const buildProcessStepFromEvent = (eventRow: TeamEventRow): ProcessStep | null => {
    const payload = eventRow.payload ?? {};
    const message = extractEventMessage(payload);
    const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
    const stage = typeof payload.stage === "string" ? payload.stage : null;
    const nextStage = typeof payload.nextStage === "string" ? payload.nextStage : null;
    const sender = eventRow.sender_name ?? eventRow.sender_role ?? "Система";
    const shortTaskId = taskId ? ` · Task ${taskId.slice(0, 8)}` : "";
    const time = formatProcessTime(eventRow.created_at);

    if (eventRow.event_name === "workflow.approval_requested") {
      return {
        id: `proc-${eventRow.id}`,
        label: "Ожидание подтверждения",
        detail: message ?? `PM запросил подтверждение запуска${shortTaskId}.`,
        time,
        tone: "warn",
      };
    }

    if (eventRow.event_name === "workflow.execution_queued") {
      return {
        id: `proc-${eventRow.id}`,
        label: "Task в очереди",
        detail: `Запуск поставлен в очередь${shortTaskId}.`,
        time,
        tone: "run",
      };
    }

    if (eventRow.event_name === "task.execution_started") {
      return {
        id: `proc-${eventRow.id}`,
        label: "Выполнение начато",
        detail: `${sender} начал выполнение${shortTaskId}.`,
        time,
        tone: "run",
      };
    }

    if (eventRow.event_name === "task.execution_completed") {
      return {
        id: `proc-${eventRow.id}`,
        label: "Выполнение завершено",
        detail: `${sender} завершил задачу${shortTaskId}.`,
        time,
        tone: "ok",
      };
    }

    if (eventRow.event_name === "task.execution_failed") {
      const reason = typeof payload.reason === "string" ? payload.reason : "без указанной причины";
      return {
        id: `proc-${eventRow.id}`,
        label: "Ошибка выполнения",
        detail: `${sender}: ${reason}${shortTaskId}.`,
        time,
        tone: "error",
      };
    }

    if (eventRow.event_name === "workflow.stage_started") {
      return {
        id: `proc-${eventRow.id}`,
        label: `Этап ${stage ?? "?"} начат`,
        detail: `${sender} приступил к этапу${shortTaskId}.`,
        time,
        tone: "run",
      };
    }

    if (eventRow.event_name === "workflow.stage_completed") {
      return {
        id: `proc-${eventRow.id}`,
        label: `Этап ${stage ?? "?"} завершен`,
        detail: nextStage ? `Следующий этап: ${nextStage}${shortTaskId}.` : `${sender} завершил этап${shortTaskId}.`,
        time,
        tone: "ok",
      };
    }

    if (eventRow.event_name === "chat.agent_response" && message) {
      return {
        id: `proc-${eventRow.id}`,
        label: `Комментарий ИИ: ${sender}`,
        detail: message.slice(0, 160),
        time,
        tone: "info",
      };
    }

    return null;
  };

  const resolveScopeForRequest = (targetRole: RoleTarget): TeamEventScope => {
    if (chatScope === "broadcast") return "broadcast";
    if (chatScope === "targeted") return "targeted";
    return targetRole === "All" ? "broadcast" : "targeted";
  };

  const normalizeEnvKeyInput = (value: string) => {
    return value.toUpperCase().replace(/[^A-Z0-9_]/g, "");
  };

  const ensureManagedRailwayServiceName = (value: string) => {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!normalized) return "task-app";
    return normalized.startsWith("task-") ? normalized : `task-${normalized}`;
  };

  const buildRailwayEnvCommand = () => {
    const serviceName = ensureManagedRailwayServiceName(envServiceName);
    const key = normalizeEnvKeyInput(envKey);
    const value = envValue.trim();
    if (!key || !value) {
      return null;
    }
    const deploySuffix = envDeployAfterSet ? " deploy" : "";
    return `Railway env service=${serviceName} ${key}=${value}${deploySuffix}`;
  };

  const pushConsultantMessage = (content: string) => {
    const nowIso = new Date().toISOString();
    appendChatMessage({
      id: makeId(),
      sender: "agent",
      role: "PM",
      coordinator: "PM",
      agentName: "PM",
      scope: "system",
      targetRole: "DevOps",
      content,
      createdAt: nowIso,
    });
    appendProcessStep({
      id: `proc-consult-${Date.now()}`,
      label: "Комментарий ИИ: PM",
      detail: content.slice(0, 160),
      time: formatProcessTime(nowIso),
      tone: "info",
    });
  };

  const applyEnvCommandToChat = () => {
    const command = buildRailwayEnvCommand();
    if (!command) {
      pushConsultantMessage(
        "PM: Для ENV-запроса укажите и ключ, и значение. Пример: KEY=NODE_ENV, VALUE=production."
      );
      return;
    }
    setChatTargetRole("DevOps");
    setChatInput(command);
    window.requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  };

  const logout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.replace("/");
    }
  };

  /* в”Ђв”Ђв”Ђ Animation helper в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
  const activateRoleAnimation = (role?: string, forcedTargetRole?: string | null) => {
    const targetRole = forcedTargetRole ?? role;
    if (!targetRole) return;
    const speaker = agents.find((a) => a.role === role);
    if (speaker) {
      setAgents((prev) => prev.map((a) => ({ ...a, is_active: a.id === speaker.id })));
      setSpeakingAgentId(speaker.id);
      window.setTimeout(() => setSpeakingAgentId(null), 2600);
    }
    if (targetRole !== "PM" && targetRole !== "All" && targetRole !== "Auto") {
      setInteractionTargetRole(targetRole);
      window.setTimeout(() => setInteractionTargetRole(null), 3200);
    }
  };

  /* в”Ђв”Ђв”Ђ Create task в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
  const createTask = async (e: FormEvent) => {
    e.preventDefault();
    const normalizedInput = taskInput.trim();
    if (!normalizedInput || isRunning) return;
    setIsRunning(true);
    try {
      if (isMockMode) {
        const nowIso = new Date().toISOString();
        const draft: ApprovalDraft = {
          taskId: `mock-${Date.now()}`,
          input: normalizedInput,
          targetRole: taskTargetRole,
        };
        setRoomMode("approval");
        setTaskStatus("waiting_approval");
        setPendingTaskId(draft.taskId);
        setApprovalDraft(draft);
        appendChatMessage({
          id: makeId(),
          sender: "agent",
          role: "PM",
          agentName: "PM",
          coordinator: "PM",
          scope: "system",
          targetRole: taskTargetRole,
          content: `PM: задача принята (${roleTargetLabel[taskTargetRole]}). Подтвердите запуск, чтобы перейти к выполнению.`,
          createdAt: nowIso,
        });
        appendProcessStep({
          id: `proc-task-mock-${draft.taskId}`,
          label: "Task создан (demo)",
          detail: `${roleTargetLabel[taskTargetRole]} · ${normalizedInput.slice(0, 140)}`,
          time: formatProcessTime(nowIso),
          tone: "warn",
        });
        activateRoleAnimation("PM", taskTargetRole);
        setTaskInput("");
        return;
      }

      setTaskStatus("pending");

      const { data: task, error } = await supabase
        .from("tasks")
        .insert({
          title: "Pixel Office CIC task",
          description: normalizedInput,
          status: "pending",
          metadata: { targetRole: taskTargetRole, initiatedBy: "dashboard", approved: false },
        })
        .select()
        .single();

      if (error || !task?.id) throw error ?? new Error("task insert failed");
      const draft: ApprovalDraft = {
        taskId: task.id as string,
        input: normalizedInput,
        targetRole: taskTargetRole,
      };
      setApprovalDraft(draft);
      setPendingTaskId(draft.taskId);
      setRoomMode("approval");
      setTaskStatus("waiting_approval");
      appendProcessStep({
        id: `proc-task-${draft.taskId}`,
        label: "Task зарегистрирован",
        detail: `${roleTargetLabel[taskTargetRole]} · ${normalizedInput.slice(0, 140)}`,
        time: formatProcessTime(),
        tone: "warn",
      });

      const preflightResponse = await fetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: task.id,
          input: normalizedInput,
          targetRole: taskTargetRole,
          approved: false,
          roomKey: DEFAULT_ROOM_KEY,
        }),
      });
      if (!(preflightResponse.status === 409 || preflightResponse.ok)) {
        throw new Error("agents preflight request failed");
      }

      appendChatMessage({
        id: makeId(),
        sender: "agent",
        role: "PM",
        agentName: "PM",
        coordinator: "PM",
        scope: "system",
        targetRole: taskTargetRole,
        content: `PM: задача зарегистрирована для ${roleTargetLabel[taskTargetRole]}. Подтвердите запуск в панели подтверждения.`,
      });
      activateRoleAnimation("PM", taskTargetRole);
      setTaskInput("");
    } catch (err) {
      console.error(err);
      alert("Ошибка запуска задачи. Проверь логи/API.");
      setTaskStatus("failed");
    } finally {
      setIsRunning(false);
    }
  };

  const approveTaskExecution = async () => {
    if (!approvalDraft || isRunning) return;
    setIsRunning(true);
    try {
      if (isMockMode) {
        const nowIso = new Date().toISOString();
        setRoomMode("execution");
        setTaskStatus("in_progress");
        appendChatMessage({
          id: makeId(),
          sender: "agent",
          role: "PM",
          agentName: "PM",
          coordinator: "PM",
          scope: "system",
          targetRole: approvalDraft.targetRole,
          content: "PM: подтверждение принято. Команда переходит к выполнению.",
          createdAt: nowIso,
        });
        appendProcessStep({
          id: `proc-approve-mock-${approvalDraft.taskId}`,
          label: "Подтверждение получено",
          detail: `Запуск для ${roleTargetLabel[approvalDraft.targetRole]} подтвержден.`,
          time: formatProcessTime(nowIso),
          tone: "run",
        });
        activateRoleAnimation("PM", approvalDraft.targetRole);
        setApprovalDraft(null);
        setPendingTaskId(null);
        return;
      }

      const response = await fetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: approvalDraft.taskId,
          input: approvalDraft.input,
          targetRole: approvalDraft.targetRole,
          approved: true,
          roomKey: DEFAULT_ROOM_KEY,
        }),
      });
      if (!response.ok) throw new Error("approved run request failed");

      setRoomMode("execution");
      setTaskStatus("in_progress");
      appendProcessStep({
        id: `proc-approve-${approvalDraft.taskId}`,
        label: "Подтверждение получено",
        detail: `Task ${approvalDraft.taskId.slice(0, 8)} запущен.`,
        time: formatProcessTime(),
        tone: "run",
      });
      appendChatMessage({
        id: makeId(),
        sender: "agent",
        role: "PM",
        agentName: "PM",
        coordinator: "PM",
        scope: "system",
        targetRole: approvalDraft.targetRole,
        content: `PM: запуск подтвержден. Выполнение начато для ${roleTargetLabel[approvalDraft.targetRole]}.`,
      });
      activateRoleAnimation("PM", approvalDraft.targetRole);
      setApprovalDraft(null);
      setPendingTaskId(null);
    } catch (error) {
      console.error(error);
      alert("Не удалось запустить задачу после подтверждения.");
    } finally {
      setIsRunning(false);
    }
  };

  const keepDiscussionMode = async () => {
    if (!approvalDraft) return;
    if (!isMockMode) {
      await supabase
        .from("room_state")
        .update({
          mode: "discussion",
          task_status: "pending",
          pending_task_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("room_key", DEFAULT_ROOM_KEY);
    }
    setRoomMode("discussion");
    setTaskStatus("pending");
    appendProcessStep({
      id: `proc-discussion-${approvalDraft.taskId}-${Date.now()}`,
      label: "Возврат в обсуждение",
      detail: `Task ${approvalDraft.taskId.slice(0, 8)} оставлен без запуска.`,
      time: formatProcessTime(),
      tone: "info",
    });
    appendChatMessage({
      id: makeId(),
      sender: "agent",
      role: "PM",
      agentName: "PM",
      coordinator: "PM",
      scope: "system",
      targetRole: approvalDraft.targetRole,
      content: "PM: подтверждение отложено. Остаемся в режиме обсуждения.",
    });
    setApprovalDraft(null);
    setPendingTaskId(null);
  };

  /* в”Ђв”Ђв”Ђ Chat в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
  const sendMessageToAgents = async (rawMessage: string, preferredTargetRole: RoleTarget) => {
    const message = rawMessage.trim();
    if (!message || chatLoading) return;

    const hasMention = /@([^\s@]+)/.test(message);
    const resolvedTargetRole = hasMention
      ? resolveMentionTargetRole(message)
      : preferredTargetRole;
    const resolvedScope = resolveScopeForRequest(resolvedTargetRole);
    const clientMessageId = `chat-${makeId()}`;

    if (resolvedTargetRole !== chatTargetRole) {
      setChatTargetRole(resolvedTargetRole);
    }

    seenClientMessageIdsRef.current.add(`user:${clientMessageId}`);
    const userEntry: ChatMessage = {
      id: makeId(),
      sender: "user",
      content: message,
      scope: resolvedScope,
      targetRole: resolvedTargetRole,
      clientMessageId,
      createdAt: new Date().toISOString(),
    };
    appendChatMessage(userEntry);
    setChatLoading(true);

    try {
      const history = [...chatMessages, userEntry]
        .slice(-8)
        .map((m) => ({ role: m.sender === "user" ? "user" : "assistant", content: m.content }));

      const response = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history,
          targetRole: resolvedTargetRole,
          scope: resolvedScope,
          roomKey: DEFAULT_ROOM_KEY,
          senderName: "Администратор CIC",
          clientMessageId,
        }),
      });
      if (!response.ok) throw new Error("chat request failed");

      const data = (await response.json()) as {
        role?: string;
        agentName?: string;
        message?: string;
        coordinator?: string;
        targetRole?: string;
        scope?: TeamEventScope;
        clientMessageId?: string;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        roleAgentId?: string | null;
        roleTotalTokens?: number | null;
      };
      const responseClientMessageId = data.clientMessageId ?? clientMessageId;

      const promptTokens = Number(data.promptTokens ?? 0);
      const completionTokens = Number(data.completionTokens ?? 0);
      const responseTotalTokens = Number(
        data.totalTokens ?? (Number.isFinite(promptTokens + completionTokens) ? promptTokens + completionTokens : 0)
      );
      if (Number.isFinite(responseTotalTokens) && responseTotalTokens > 0) {
        setTotalTokens((previous) => previous + responseTotalTokens);

        let roleAgentId = typeof data.roleAgentId === "string" && data.roleAgentId.length > 0
          ? data.roleAgentId
          : null;

        if (!roleAgentId && data.role) {
          const matchedAgent = agents.find((agent) => agent.role === data.role);
          roleAgentId = matchedAgent?.id ?? null;
        }

        if (roleAgentId) {
          const roleTotalTokens = Number(data.roleTotalTokens ?? 0);
          setAgentTokenUsage((previous) => {
            const nextTotal =
              Number.isFinite(roleTotalTokens) && roleTotalTokens > 0
                ? roleTotalTokens
                : (previous[roleAgentId!] ?? 0) + responseTotalTokens;
            return {
              ...previous,
              [roleAgentId!]: nextTotal,
            };
          });
        }
      }

      seenClientMessageIdsRef.current.add(`agent:${responseClientMessageId}`);
      appendChatMessage({
        id: makeId(),
        sender: "agent",
        role: data.role,
        coordinator: data.coordinator,
        agentName: data.agentName ?? data.role ?? "Агент",
        content: data.message ?? "Нет ответа.",
        scope: data.scope ?? resolvedScope,
        targetRole: normalizeRoleTarget(data.targetRole),
        clientMessageId: responseClientMessageId,
        createdAt: new Date().toISOString(),
      });
      appendProcessStep({
        id: `proc-chat-${responseClientMessageId}`,
        label: `Комментарий ИИ: ${data.agentName ?? data.role ?? "Агент"}`,
        detail: (data.message ?? "Ответ получен").slice(0, 160),
        time: formatProcessTime(),
        tone: "info",
      });
      appendEventFeed(
        `[${scopeMeta[data.scope ?? resolvedScope]}] ${data.role ?? "PM"}: ${(
          data.message ?? "Ответ получен"
        ).slice(0, 90)}`
      );
      activateRoleAnimation(data.role, data.targetRole ?? resolvedTargetRole);
    } catch {
      appendProcessStep({
        id: `proc-chat-error-${Date.now()}`,
        label: "Ошибка чата",
        detail: "API чата временно недоступен.",
        time: formatProcessTime(),
        tone: "error",
      });
      appendChatMessage({
        id: makeId(),
        sender: "agent",
        role: "PM",
        coordinator: "PM",
        agentName: "Система",
        scope: "system",
        content: "Чат временно недоступен. Повтори запрос через несколько секунд.",
      });
    } finally {
      setChatLoading(false);
    }
  };

  const sendRailwayEnvCommand = async () => {
    const command = buildRailwayEnvCommand();
    if (!command) {
      pushConsultantMessage(
        "PM: Для ENV-запроса укажите service, ключ и значение. Пример: service=task-app, KEY=NODE_ENV, VALUE=production."
      );
      return;
    }
    setChatTargetRole("DevOps");
    await sendMessageToAgents(command, "DevOps");
    setEnvValue("");
  };

  const askAgents = async (e: FormEvent) => {
    e.preventDefault();
    const message = chatInput.trim();
    if (!message) return;
    setChatInput("");
    await sendMessageToAgents(message, chatTargetRole);
  };

  /* в”Ђв”Ђв”Ђ Data bootstrap в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted) return;
    if (isMockMode) return;

    const fetchTokenStats = async () => {
      const { data: logsData } = await supabase
        .from("token_logs")
        .select("agent_id, prompt_tokens, completion_tokens");

      if (!logsData) return;
      const tokenUsageByAgent: Record<string, number> = {};
      let nextTotalTokens = 0;

      for (const log of logsData as TokenLog[]) {
        const promptTokens = Number(log.prompt_tokens ?? 0);
        const completionTokens = Number(log.completion_tokens ?? 0);
        const rowTokens = promptTokens + completionTokens;
        nextTotalTokens += rowTokens;

        if (log.agent_id) {
          tokenUsageByAgent[log.agent_id] = (tokenUsageByAgent[log.agent_id] ?? 0) + rowTokens;
        }
      }

      setTotalTokens(nextTotalTokens);
      setAgentTokenUsage(tokenUsageByAgent);
    };

    const refreshPlayerState = async () => {
      const { data: playerRows } = await supabase
        .from("player_state")
        .select("agent_id, role, status, is_online, typing_until, tokens_total")
        .eq("room_key", DEFAULT_ROOM_KEY);

      if (!playerRows) return;
      const nextStateByRole: Record<string, { status: string; isOnline: boolean }> = {};
      const nextTypingRoles: string[] = [];
      const nextTokenUsage: Record<string, number> = {};

      for (const row of playerRows as PlayerStateRow[]) {
        nextStateByRole[row.role] = {
          status: row.status,
          isOnline: Boolean(row.is_online),
        };
        if (isTypingState(row.status, row.typing_until)) {
          nextTypingRoles.push(row.role);
        }
        const tokens = Number(row.tokens_total ?? 0);
        if (Number.isFinite(tokens) && tokens > 0) {
          nextTokenUsage[row.agent_id] = tokens;
        }
      }

      setPlayerStateByRole(nextStateByRole);
      setTypingRoles(nextTypingRoles);
      if (Object.keys(nextTokenUsage).length > 0) {
        setAgentTokenUsage((previous) => ({ ...previous, ...nextTokenUsage }));
      }
    };

    const handleTeamEvent = (eventRow: TeamEventRow) => {
      if (!eventRow?.id || seenEventIdsRef.current.has(eventRow.id)) return;
      seenEventIdsRef.current.add(eventRow.id);

      const payload = eventRow.payload ?? {};
      const message = extractEventMessage(payload);
      const clientMessageId = extractClientMessageId(payload);
      const userKey = clientMessageId ? `user:${clientMessageId}` : null;
      const agentKey = clientMessageId ? `agent:${clientMessageId}` : null;
      const knownUserMessage = Boolean(userKey && seenClientMessageIdsRef.current.has(userKey));
      const knownAgentMessage = Boolean(agentKey && seenClientMessageIdsRef.current.has(agentKey));
      const processStep = buildProcessStepFromEvent(eventRow);
      if (processStep) {
        appendProcessStep(processStep);
      }

      if (!knownUserMessage && eventRow.event_name === "chat.user_message" && message) {
        if (userKey) seenClientMessageIdsRef.current.add(userKey);
        appendChatMessage({
          id: `evt-${eventRow.id}`,
          sender: "user",
          content: message,
          scope: eventRow.scope,
          targetRole: normalizeRoleTarget(eventRow.target_role),
          clientMessageId,
          createdAt: eventRow.created_at,
        });
      }

      if (!knownAgentMessage && eventRow.event_name === "chat.agent_response" && message) {
        if (agentKey) seenClientMessageIdsRef.current.add(agentKey);
        const payloadRole = typeof payload.role === "string" ? payload.role : eventRow.sender_role ?? undefined;
        const payloadAgentName =
          typeof payload.agentName === "string"
            ? payload.agentName
            : eventRow.sender_name ?? payloadRole ?? "Агент";

        appendChatMessage({
          id: `evt-${eventRow.id}`,
          sender: "agent",
          role: payloadRole,
          coordinator: "PM",
          agentName: payloadAgentName,
          content: message,
          scope: eventRow.scope,
          targetRole: normalizeRoleTarget(eventRow.target_role),
          clientMessageId,
          createdAt: eventRow.created_at,
        });
        activateRoleAnimation(payloadRole, eventRow.target_role ?? undefined);
      }

      if (eventRow.event_name === "workflow.approval_requested" && message) {
        setRoomMode("approval");
        setTaskStatus("waiting_approval");
      }

      if (eventRow.event_name === "workflow.execution_queued") {
        setRoomMode("execution");
        setTaskStatus("in_progress");
        const payloadTaskId = typeof payload.taskId === "string" ? payload.taskId : null;
        if (payloadTaskId) {
          setPendingTaskId(payloadTaskId);
        }
        appendChatMessage({
          id: `evt-status-${eventRow.id}`,
          sender: "agent",
          role: "PM",
          agentName: eventRow.sender_name ?? "PM",
          coordinator: "PM",
          scope: "system",
          targetRole: normalizeRoleTarget(eventRow.target_role),
          content: payloadTaskId
            ? `PM: выполнение поставлено в очередь. Task ID: ${payloadTaskId}.`
            : "PM: выполнение поставлено в очередь.",
          createdAt: eventRow.created_at,
        });
      }

      if (eventRow.event_name === "task.execution_started") {
        setRoomMode("execution");
        setTaskStatus("in_progress");
        const payloadTaskId = typeof payload.taskId === "string" ? payload.taskId : null;
        if (payloadTaskId) {
          setPendingTaskId(payloadTaskId);
        }
        appendChatMessage({
          id: `evt-status-${eventRow.id}`,
          sender: "agent",
          role: "PM",
          agentName: eventRow.sender_name ?? "PM",
          coordinator: "PM",
          scope: "system",
          targetRole: normalizeRoleTarget(eventRow.target_role),
          content: payloadTaskId
            ? `PM: выполнение начато. Task ID: ${payloadTaskId}.`
            : "PM: выполнение начато.",
          createdAt: eventRow.created_at,
        });
      }

      if (eventRow.event_name === "task.execution_completed") {
        setRoomMode("discussion");
        setTaskStatus("done");
        setPendingTaskId(null);
        const payloadTaskId = typeof payload.taskId === "string" ? payload.taskId : null;
        appendChatMessage({
          id: `evt-status-${eventRow.id}`,
          sender: "agent",
          role: "DevOps",
          agentName: eventRow.sender_name ?? "DevOps",
          coordinator: "PM",
          scope: "system",
          targetRole: normalizeRoleTarget(eventRow.target_role),
          content: payloadTaskId
            ? `DevOps: выполнение завершено. Task ID: ${payloadTaskId}.`
            : "DevOps: выполнение завершено.",
          createdAt: eventRow.created_at,
        });
      }

      if (eventRow.event_name === "task.execution_failed") {
        setRoomMode("discussion");
        setTaskStatus("failed");
        const reason = typeof payload.reason === "string" ? payload.reason : null;
        appendChatMessage({
          id: `evt-status-${eventRow.id}`,
          sender: "agent",
          role: "PM",
          agentName: eventRow.sender_name ?? "PM",
          coordinator: "PM",
          scope: "system",
          targetRole: normalizeRoleTarget(eventRow.target_role),
          content: reason
            ? `PM: выполнение завершилось ошибкой. Причина: ${reason}.`
            : "PM: выполнение завершилось ошибкой.",
          createdAt: eventRow.created_at,
        });
      }

      if (eventRow.event_name.startsWith("task.execution_") || eventRow.event_name.startsWith("workflow.")) {
        const shortMessage = message
          ? message.slice(0, 90)
          : `${eventRow.event_name} (${eventRow.sender_role ?? "system"})`;
        appendEventFeed(`[${scopeMeta[eventRow.scope]}] ${shortMessage}`);
      }
    };

    const fetchData = async () => {
      const { data: agentsData } = await supabase.from("agents").select("*");
      if (agentsData) setAgents(agentsData);

      const { data: roomStateData } = await supabase
        .from("room_state")
        .select("room_key, mode, task_status, active_role, pending_task_id, revision")
        .eq("room_key", DEFAULT_ROOM_KEY)
        .maybeSingle();

      if (roomStateData) {
        const roomState = roomStateData as RoomStateRow;
        setRoomMode(roomState.mode);
        setTaskStatus(roomState.task_status);
        setPendingTaskId(roomState.pending_task_id);
        setRoomRevision(Number(roomState.revision ?? 0));
        if (roomState.active_role) {
          setAgents((previous) =>
            previous.map((agent) => ({
              ...agent,
              is_active: agent.role === roomState.active_role,
            }))
          );
        }
      }

      const { data: latestEvents } = await supabase
        .from("team_events")
        .select("id, event_name, scope, sender_role, payload, target_role, room_key, sender_name, created_at")
        .eq("room_key", DEFAULT_ROOM_KEY)
        .order("created_at", { ascending: false })
        .limit(8);

      if (latestEvents) {
        const eventRows = latestEvents as TeamEventRow[];
        const lines = eventRows.map((eventRow) => {
          const eventMessage = extractEventMessage(eventRow.payload);
          if (eventMessage) return `[${scopeMeta[eventRow.scope]}] ${eventMessage.slice(0, 90)}`;
          return `[${scopeMeta[eventRow.scope]}] ${eventRow.event_name}`;
        });
        setEventFeed(lines);

        const processRows = eventRows
          .map((eventRow) => buildProcessStepFromEvent(eventRow))
          .filter((item): item is ProcessStep => Boolean(item));
        if (processRows.length > 0) {
          setProcessFeed(processRows.slice(0, 30));
        }
      }

      await fetchTokenStats();
      await refreshPlayerState();

      const { data: latestTask } = await supabase
        .from("tasks").select("id, status").order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (latestTask?.status) setTaskStatus((latestTask as TaskRecord).status);
    };

    const refreshRuntimeSnapshot = async () => {
      const { data: agentsData } = await supabase.from("agents").select("*");
      if (agentsData) setAgents(agentsData);

      const { data: roomStateData } = await supabase
        .from("room_state")
        .select("room_key, mode, task_status, active_role, pending_task_id, revision")
        .eq("room_key", DEFAULT_ROOM_KEY)
        .maybeSingle();

      if (roomStateData) {
        const roomState = roomStateData as RoomStateRow;
        setRoomMode(roomState.mode);
        setTaskStatus(roomState.task_status);
        setPendingTaskId(roomState.pending_task_id);
        setRoomRevision(Number(roomState.revision ?? 0));
        if (roomState.active_role) {
          setAgents((previous) =>
            previous.map((agent) => ({
              ...agent,
              is_active: agent.role === roomState.active_role,
            }))
          );
        }
      }

      const { data: latestTask } = await supabase
        .from("tasks")
        .select("id, status")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latestTask?.status) setTaskStatus((latestTask as TaskRecord).status);

      await fetchTokenStats();
      await refreshPlayerState();
    };

    const pollTeamEvents = async () => {
      const { data: latestEvents } = await supabase
        .from("team_events")
        .select("id, event_name, scope, sender_role, payload, target_role, room_key, sender_name, created_at")
        .eq("room_key", DEFAULT_ROOM_KEY)
        .order("created_at", { ascending: false })
        .limit(20);

      if (!latestEvents) return;
      const ordered = [...(latestEvents as TeamEventRow[])].reverse();
      for (const eventRow of ordered) {
        handleTeamEvent(eventRow);
      }
    };

    fetchData();
    const pollTimer = window.setInterval(() => {
      void refreshRuntimeSnapshot();
      void pollTeamEvents();
    }, 2500);

    const agentsChannel = supabase.channel("agents-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "agents" }, (payload) => {
        setAgents((prev) => {
          if (payload.eventType === "INSERT") return [...prev, payload.new as Agent];
          if (payload.eventType === "DELETE") return prev.filter((a) => a.id !== (payload.old as Agent).id);
          return prev.map((a) => a.id === (payload.new as Agent).id ? (payload.new as Agent) : a);
        });
      })
      .subscribe();

    const tasksChannel = supabase.channel("tasks-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, (payload) => {
        if (payload.eventType === "DELETE") return;
        const nextStatus = (payload.new as TaskRecord)?.status;
        if (nextStatus) {
          setTaskStatus(nextStatus);
          if (nextStatus === "done" || nextStatus === "failed") {
            setApprovalDraft(null);
            setPendingTaskId(null);
          }
        }
      })
      .subscribe();

    const tokenLogsChannel = supabase
      .channel("token-logs-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "token_logs" }, () => {
        fetchTokenStats();
      })
      .subscribe();

    const roomStateChannel = supabase
      .channel("room-state-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_state", filter: `room_key=eq.${DEFAULT_ROOM_KEY}` },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const room = payload.new as RoomStateRow;
          if (!room) return;
          setRoomMode(room.mode);
          setTaskStatus(room.task_status);
          setPendingTaskId(room.pending_task_id);
          setRoomRevision(Number(room.revision ?? 0));
          if (room.active_role) {
            setAgents((previous) =>
              previous.map((agent) => ({
                ...agent,
                is_active: agent.role === room.active_role,
              }))
            );
          }
        }
      )
      .subscribe();

    const playerStateChannel = supabase
      .channel("player-state-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "player_state", filter: `room_key=eq.${DEFAULT_ROOM_KEY}` },
        () => {
          refreshPlayerState();
        }
      )
      .subscribe();

    const teamEventsChannel = supabase
      .channel("team-events-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "team_events", filter: `room_key=eq.${DEFAULT_ROOM_KEY}` },
        (payload) => {
          handleTeamEvent(payload.new as TeamEventRow);
        }
      )
      .subscribe();

    return () => {
      window.clearInterval(pollTimer);
      supabase.removeChannel(agentsChannel);
      supabase.removeChannel(tasksChannel);
      supabase.removeChannel(tokenLogsChannel);
      supabase.removeChannel(roomStateChannel);
      supabase.removeChannel(playerStateChannel);
      supabase.removeChannel(teamEventsChannel);
    };
  }, [mounted]);

  if (!mounted) return <div className="min-h-screen" style={{ background: "#0d0308" }} />;

  /* в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
  return (
    <main className="min-h-dvh text-white p-3 lg:p-5 overflow-hidden relative"
      style={{ fontFamily: '"Trebuchet MS", "Segoe UI", sans-serif' }}>

      {/* в”Ђв”Ђ Background atmosphere в”Ђв”Ђ */}
      <div className="fixed inset-0 -z-10"
        style={{
          background: "linear-gradient(160deg,#130208 0%,#0a0114 45%,#05010c 100%)",
        }}
      />
      <div className="fixed inset-0 -z-10 opacity-70"
        style={{
          background:
            "radial-gradient(circle at 8% 6%, rgba(232,0,30,0.28) 0%, transparent 35%)," +
            "radial-gradient(circle at 90% 12%, rgba(123,47,190,0.22) 0%, transparent 38%)," +
            "radial-gradient(circle at 50% 95%, rgba(42,63,219,0.14) 0%, transparent 40%)",
        }}
      />

      <div className="relative z-10 max-w-[1540px] mx-auto flex flex-col gap-4">

        {/* в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
            HEADER  вЂ” logos + status bar
        в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ */}
        <header
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-5 py-4 rounded-xl"
          style={{
            background: "rgba(10,3,7,0.82)",
            border: "1px solid rgba(194,21,90,0.30)",
            boxShadow: "0 0 0 1px rgba(232,0,30,0.08), inset 0 1px 0 rgba(255,255,255,0.04), 0 8px 32px rgba(0,0,0,0.55)",
            backdropFilter: "blur(20px)",
          }}
        >
          {/* Left: logos */}
          <div className="flex items-center gap-5">
            {/* Centras logo */}
            <div className="flex-shrink-0">
              <img
                src="/centras-logo.svg"
                alt="Centras Insurance"
                style={{ height: 44, width: "auto", filter: "drop-shadow(0 0 8px rgba(232,0,30,0.35))" }}
                draggable={false}
              />
            </div>

            {/* Divider */}
            <div
              style={{
                width: 1,
                height: 36,
                background: "linear-gradient(to bottom, transparent, rgba(194,21,90,0.6), transparent)",
              }}
            />

            {/* DevTeam logo */}
            <div className="flex-shrink-0">
              <img
                src="/devteam-logo.svg"
                alt="DevTeam"
                style={{ height: 38, width: "auto", filter: "drop-shadow(0 0 8px rgba(123,47,190,0.35))" }}
                draggable={false}
              />
            </div>

            {/* Workflow mode badge */}
            <div
              className="hidden md:flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em]"
              style={{
                background: "rgba(232,0,30,0.10)",
                border: "1px solid rgba(232,0,30,0.28)",
                borderRadius: 6,
                color: currentRoomMode.color,
              }}
            >
              <IconDot color={currentRoomMode.color} />
              {currentRoomMode.label}
            </div>
          </div>

          {/* Right: metrics */}
          <div className="flex flex-wrap items-center gap-3">
            {/* API Tokens */}
            <div
              className="px-3 py-2 rounded-lg text-right"
              style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(194,21,90,0.22)" }}
            >
              <div className="text-[9px] text-rose-100/60 uppercase tracking-widest">Токены API</div>
              <div className="text-sm font-mono text-rose-200 mt-0.5">{formatTokenCompact(totalTokens)}</div>
            </div>

            {/* Active role */}
            <div
              className="px-3 py-2 rounded-lg"
              style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(194,21,90,0.22)" }}
            >
              <div className="text-[9px] text-rose-100/60 uppercase tracking-widest">Активная роль</div>
              <div className="text-sm font-semibold text-rose-50 mt-0.5">
                {activeAgent?.role ?? "-"} · {activeAgent?.name ?? "Нет"}
              </div>
            </div>

            {/* Task status chip */}
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg"
              style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(194,21,90,0.22)" }}
            >
              <IconDot color={currentStatus.color} />
              <div>
                <div className="text-[9px] text-rose-100/60 uppercase tracking-widest">Статус задачи</div>
                <div className="text-sm font-semibold mt-0.5" style={{ color: currentStatus.color }}>
                  {currentStatus.label}
                </div>
              </div>
            </div>

            <div
              className="px-3 py-2 rounded-lg"
              style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(194,21,90,0.22)" }}
            >
              <div className="text-[9px] text-rose-100/60 uppercase tracking-widest">Ревизия комнаты</div>
              <div className="text-sm font-mono text-rose-100 mt-0.5">#{roomRevision}</div>
            </div>

            <button
              id="logout-btn"
              type="button"
              onClick={logout}
              disabled={isLoggingOut}
              className="px-3 py-2 rounded-lg text-xs uppercase tracking-[0.18em] transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none"
              style={{
                background: "rgba(0,0,0,0.45)",
                border: "1px solid rgba(194,21,90,0.34)",
                color: "rgba(255,220,228,0.88)",
              }}
            >
              {isLoggingOut ? "Выход..." : "Выйти"}
            </button>
          </div>
        </header>

        <section
          className="rounded-xl px-4 py-3"
          style={{
            background: "rgba(8,2,6,0.76)",
            border: "1px solid rgba(194,21,90,0.24)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveMenuPanel((previous) => (previous === "mode" ? null : "mode"))}
              className="px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] rounded-md"
              style={{
                background: activeMenuPanel === "mode" ? "rgba(194,21,90,0.26)" : "rgba(194,21,90,0.12)",
                border: "1px solid rgba(194,21,90,0.35)",
                color: "rgba(255,220,228,0.95)",
              }}
            >
              Режим
            </button>
            <button
              type="button"
              onClick={() => setActiveMenuPanel((previous) => (previous === "events" ? null : "events"))}
              className="px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] rounded-md"
              style={{
                background: activeMenuPanel === "events" ? "rgba(194,21,90,0.26)" : "rgba(194,21,90,0.12)",
                border: "1px solid rgba(194,21,90,0.35)",
                color: "rgba(255,220,228,0.95)",
              }}
            >
              События
            </button>
            <button
              type="button"
              onClick={() => setActiveMenuPanel((previous) => (previous === "process" ? null : "process"))}
              className="px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] rounded-md"
              style={{
                background: activeMenuPanel === "process" ? "rgba(194,21,90,0.26)" : "rgba(194,21,90,0.12)",
                border: "1px solid rgba(194,21,90,0.35)",
                color: "rgba(255,220,228,0.95)",
              }}
            >
              TASK/Процесс
            </button>
            <button
              type="button"
              onClick={() => setActiveMenuPanel((previous) => (previous === "tools" ? null : "tools"))}
              className="px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] rounded-md"
              style={{
                background: activeMenuPanel === "tools" ? "rgba(194,21,90,0.26)" : "rgba(194,21,90,0.12)",
                border: "1px solid rgba(194,21,90,0.35)",
                color: "rgba(255,220,228,0.95)",
              }}
            >
              PM/AI инструменты
            </button>
            <div className="ml-auto text-[11px] text-rose-100/70">
              {zoneHint}
            </div>
          </div>

          {activeMenuPanel === "mode" && (
            <div
              className="mt-3 rounded-lg px-3 py-2 text-xs"
              style={{ background: "rgba(0,0,0,0.42)", border: "1px solid rgba(194,21,90,0.24)" }}
            >
              Режим: <span style={{ color: currentRoomMode.color }}>{currentRoomMode.label}</span>. Текущий workflow:
              {" "}
              {"обсуждение -> подтверждение -> выполнение."}
            </div>
          )}

          {activeMenuPanel === "events" && (
            <div
              className="mt-3 rounded-lg px-3 py-2 text-xs space-y-1"
              style={{ background: "rgba(0,0,0,0.42)", border: "1px solid rgba(194,21,90,0.24)" }}
            >
              {eventFeed.length === 0 && <div className="text-rose-100/60">Событий пока нет.</div>}
              {eventFeed.map((line, index) => (
                <div key={`${line}-${index}`} className="text-rose-100/80">
                  {line}
                </div>
              ))}
            </div>
          )}

          {activeMenuPanel === "process" && (
            <div
              className="mt-3 rounded-lg px-3 py-3 text-xs space-y-2.5"
              style={{ background: "rgba(0,0,0,0.42)", border: "1px solid rgba(194,21,90,0.24)" }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="px-2 py-1 rounded-md text-[10px] uppercase tracking-[0.16em] text-rose-100/90"
                  style={{ background: "rgba(194,21,90,0.18)", border: "1px solid rgba(194,21,90,0.30)" }}>
                  Task: {pendingTaskId ?? approvalDraft?.taskId ?? "нет активного"}
                </div>
                <div className="px-2 py-1 rounded-md text-[10px] uppercase tracking-[0.16em] text-rose-100/90"
                  style={{ background: "rgba(194,21,90,0.10)", border: "1px solid rgba(194,21,90,0.24)" }}>
                  Режим: {currentRoomMode.label}
                </div>
                <div className="px-2 py-1 rounded-md text-[10px] uppercase tracking-[0.16em] text-rose-100/90"
                  style={{ background: "rgba(194,21,90,0.10)", border: "1px solid rgba(194,21,90,0.24)" }}>
                  Статус: {currentStatus.label}
                </div>
              </div>

              <div className="rounded-md px-2.5 py-2"
                style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(194,21,90,0.20)" }}>
                <div className="text-[10px] uppercase tracking-[0.17em] text-rose-100/55 mb-1.5">
                  Порядок работы
                </div>
                <div className="text-rose-100/85">
                  1) Обсуждение → 2) Подтверждение → 3) Выполнение
                </div>
              </div>

              <div className="space-y-1.5 max-h-[240px] overflow-y-auto pr-1">
                {processFeed.length === 0 && (
                  <div className="text-rose-100/60">Процесс пока не начат. После task и ответов ИИ здесь появятся шаги.</div>
                )}
                {processFeed.map((step) => {
                  const tone = processToneMeta[step.tone];
                  return (
                    <div
                      key={step.id}
                      className="rounded-md px-2.5 py-2"
                      style={{ border: `1px solid ${tone.border}`, background: tone.background }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold" style={{ color: tone.color }}>
                          {step.label}
                        </div>
                        <div className="text-[10px] text-rose-100/55">{step.time}</div>
                      </div>
                      <div className="mt-1 text-rose-100/78">{step.detail}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeMenuPanel === "tools" && (
            <div
              className="mt-3 rounded-lg px-3 py-2 text-xs space-y-1"
              style={{ background: "rgba(0,0,0,0.42)", border: "1px solid rgba(194,21,90,0.24)" }}
            >
              <div className="text-rose-100/85">MCP: GitHub, Railway, Sandbox (в рамках подтвержденной задачи).</div>
              <div className="text-rose-100/70">Существующие сервисы/репозитории не трогаем без явного одобрения.</div>
              <div className="text-rose-100/70">Если есть сомнение по порядку действий, сначала формальное уточнение.</div>
            </div>
          )}
        </section>

        {/* в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
            MAIN GRID: office | chat
        в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.95fr)_minmax(390px,1fr)]">

          {/* в”Ђв”Ђ Left column в”Ђв”Ђ */}
          <section
            className="flex flex-col gap-4"
            onMouseEnter={() => setActiveZone("task")}
          >

            {/* Task input bar */}
            <form
              id="task-form"
              onSubmit={createTask}
              className="flex flex-col sm:flex-row gap-2 p-3 rounded-xl"
              style={{
                background: "rgba(10,3,7,0.78)",
                border: "1px solid rgba(194,21,90,0.28)",
                backdropFilter: "blur(12px)",
              }}
            >
              {/* Text input */}
              <input
                id="task-input"
                type="text"
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                onFocus={() => setActiveZone("task")}
                placeholder="Поставь задачу команде - PM скоординирует всех..."
                disabled={isRunning}
                className="flex-1 min-w-0 bg-black/35 px-4 py-2.5 text-sm outline-none rounded-lg text-white placeholder:text-rose-100/30"
                style={{ border: "1px solid rgba(194,21,90,0.22)" }}
              />

              {/* Role select */}
              <select
                id="task-role-select"
                value={taskTargetRole}
                onChange={(e) => setTaskTargetRole(e.target.value as RoleTarget)}
                className="bg-black/40 px-3 py-2.5 text-sm outline-none rounded-lg text-rose-100 cursor-pointer"
                style={{ border: "1px solid rgba(194,21,90,0.28)", minWidth: 160 }}
              >
                {(Object.keys(roleTargetLabel) as RoleTarget[]).map((role) => (
                  <option key={role} value={role}>{roleTargetLabel[role]}</option>
                ))}
              </select>

              {/* Submit button */}
              <button
                id="task-submit-btn"
                type="submit"
                disabled={isRunning}
                className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold whitespace-nowrap transition-all duration-200 active:scale-95 disabled:opacity-50 disabled:pointer-events-none"
                style={{
                  background: isRunning
                    ? "rgba(100,80,90,0.4)"
                    : "linear-gradient(135deg,#E8001E 0%,#C2155A 50%,#7B2FBE 100%)",
                  border: isRunning ? "1px solid rgba(150,130,140,0.3)" : "1px solid rgba(232,0,30,0.5)",
                  color: "#fff",
                  boxShadow: isRunning ? "none" : "0 0 20px rgba(194,21,90,0.40)",
                }}
              >
                {isRunning ? <><IconSpinner /> Выполнение...</> : <><IconPlay /> Запустить задачу</>}
              </button>
            </form>

            {approvalDraft && (
              <div
                className="rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3"
                style={{
                  background: "rgba(249,115,22,0.12)",
                  border: "1px solid rgba(249,115,22,0.45)",
                }}
              >
                <div className="flex-1 text-xs text-rose-50/90">
                  <div className="uppercase tracking-[0.16em] text-[10px] text-orange-200 mb-1">
                    Подтверждение запуска
                  </div>
                  <div>
                    Задача для {roleTargetLabel[approvalDraft.targetRole]} ожидает подтверждения.
                    ID: <span className="font-mono">{pendingTaskId ?? approvalDraft.taskId}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={keepDiscussionMode}
                    className="px-3 py-2 rounded-lg text-xs uppercase tracking-[0.14em]"
                    style={{
                      background: "rgba(0,0,0,0.48)",
                      border: "1px solid rgba(194,21,90,0.34)",
                      color: "rgba(255,220,228,0.9)",
                    }}
                  >
                    Обсуждение
                  </button>
                  <button
                    type="button"
                    onClick={approveTaskExecution}
                    disabled={isRunning}
                    className="px-3 py-2 rounded-lg text-xs uppercase tracking-[0.14em] disabled:opacity-50"
                    style={{
                      background: "linear-gradient(135deg,#E8001E 0%,#C2155A 55%,#7B2FBE 100%)",
                      border: "1px solid rgba(232,0,30,0.5)",
                      color: "#fff",
                    }}
                  >
                    Подтвердить запуск
                  </button>
                </div>
              </div>
            )}

            {/* Pixel Office */}
            <div onMouseEnter={() => setActiveZone("office")}>
              <OfficeHub
                agents={agents}
                taskStatus={taskStatus}
                speakingAgentId={speakingAgentId}
                interactionTargetRole={interactionTargetRole}
                agentTokenUsage={agentTokenUsage}
              />
            </div>
          </section>

          {/* в”Ђв”Ђ Right column вЂ” Chat в”Ђв”Ђ */}
          <aside
            className="flex flex-col rounded-xl"
            onMouseEnter={() => setActiveZone("chat")}
            style={{
              background: "rgba(8,2,6,0.88)",
              border: "1px solid rgba(194,21,90,0.26)",
              backdropFilter: "blur(18px)",
              height: "calc(100vh - 178px)",
              minHeight: 620,
              maxHeight: 940,
            }}
          >
            {/* Chat header */}
            <div
              className="px-4 py-3 flex items-start justify-between gap-2"
              style={{ borderBottom: "1px solid rgba(194,21,90,0.18)" }}
            >
              <div>
                <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-rose-100">
                  Командный чат
                </h2>
                <p className="text-[11px] text-rose-100/55 mt-0.5">
                  Scoped-сообщения: адресно, broadcast, системные уведомления
                </p>
              </div>
              {/* Live indicator */}
              <div className="flex items-center gap-1.5 text-[10px] text-rose-100/60 mt-0.5">
                <IconDot color="#E8001E" />
                Live
              </div>
            </div>

            {/* Quick prompts */}
            <div
              className="px-4 py-3 space-y-2"
              style={{ borderBottom: "1px solid rgba(194,21,90,0.18)" }}
            >
              <div className="text-[9px] uppercase tracking-[0.2em] text-rose-100/55">
                Быстрые команды
              </div>
              <div className="flex flex-wrap gap-1.5">
                {quickPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    id={`quick-${prompt.slice(1, 8).replace(/\s/g, "-")}`}
                    onClick={() => applyQuickPrompt(prompt)}
                    className="text-[10px] px-2.5 py-1 rounded-md transition-all duration-150 active:scale-95"
                    style={{
                      background: "rgba(194,21,90,0.08)",
                      border: "1px solid rgba(194,21,90,0.25)",
                      color: "rgba(255,200,210,0.8)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "rgba(194,21,90,0.20)";
                      e.currentTarget.style.borderColor = "rgba(194,21,90,0.55)";
                      e.currentTarget.style.color = "#fff";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "rgba(194,21,90,0.08)";
                      e.currentTarget.style.borderColor = "rgba(194,21,90,0.25)";
                      e.currentTarget.style.color = "rgba(255,200,210,0.8)";
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>

            {/* Addressee selector */}
            <div
              className="px-4 py-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2"
              style={{ borderBottom: "1px solid rgba(194,21,90,0.18)" }}
            >
              <div>
                <label className="text-[9px] uppercase tracking-[0.2em] text-rose-100/55 block mb-1.5">
                  Кому адресовать
                </label>
                <select
                  id="chat-role-select"
                  value={chatTargetRole}
                  onChange={(e) => setChatTargetRole(e.target.value as RoleTarget)}
                  className="w-full bg-black/45 px-3 py-2 text-sm outline-none rounded-lg text-rose-100 cursor-pointer"
                  style={{ border: "1px solid rgba(194,21,90,0.26)" }}
                >
                  <option value="Auto">Авто (определит PM)</option>
                  <option value="All">Вся команда</option>
                  <option value="PM">PM</option>
                  <option value="Developer">Developer</option>
                  <option value="QA">QA</option>
                  <option value="DevOps">DevOps</option>
                </select>
              </div>
              <div>
                <label className="text-[9px] uppercase tracking-[0.2em] text-rose-100/55 block mb-1.5">
                  Scope
                </label>
                <select
                  id="chat-scope-select"
                  value={chatScope}
                  onChange={(e) => setChatScope(e.target.value as ChatScope)}
                  className="w-full bg-black/45 px-3 py-2 text-sm outline-none rounded-lg text-rose-100 cursor-pointer"
                  style={{ border: "1px solid rgba(194,21,90,0.26)" }}
                >
                  <option value="auto">Auto</option>
                  <option value="targeted">Targeted</option>
                  <option value="broadcast">Broadcast</option>
                </select>
              </div>
            </div>

            {/* Messages */}
            <div
              id="chat-messages"
              className="flex-1 overflow-y-auto p-4 space-y-3 chat-scroll"
            >
              {chatMessages.map((item) => (
                <div
                  key={item.id}
                  className={`flex ${item.sender === "user" ? "justify-end" : "justify-start"}`}
                >
                  {/* Agent icon */}
                  {item.sender === "agent" && (
                    <div
                      className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mr-2 mt-0.5"
                      style={{
                        background: "linear-gradient(135deg,#E8001E,#7B2FBE)",
                        boxShadow: "0 0 8px rgba(194,21,90,0.4)",
                      }}
                    >
                      <IconUser />
                    </div>
                  )}

                  <div
                    className="w-fit max-w-[82%] px-3 py-2.5 rounded-xl text-xs leading-relaxed"
                    style={
                      item.sender === "user"
                        ? {
                            background: "linear-gradient(135deg,rgba(232,0,30,0.25),rgba(123,47,190,0.18))",
                            border: "1px solid rgba(194,21,90,0.38)",
                            color: "#ffe8ec",
                          }
                        : {
                            background: "rgba(0,0,0,0.65)",
                            border: "1px solid rgba(194,21,90,0.20)",
                            color: "#fde8ec",
                          }
                    }
                  >
                    <div className="flex items-center flex-wrap gap-1.5 mb-1.5">
                      {item.sender === "agent" ? (
                        <div
                          className="text-[9px] uppercase tracking-[0.15em] font-semibold"
                          style={{
                            background: "linear-gradient(90deg,#E8001E,#7B2FBE)",
                            WebkitBackgroundClip: "text",
                            WebkitTextFillColor: "transparent",
                          }}
                        >
                          {item.coordinator === "PM" && item.role && item.role !== "PM"
                            ? `PM -> ${item.agentName ?? item.role}`
                            : (item.agentName ?? item.role ?? "Агент")}
                        </div>
                      ) : (
                        <div className="text-[9px] uppercase tracking-[0.15em] text-rose-100/75 font-semibold">
                          Администратор
                        </div>
                      )}
                      <div
                        className="px-1.5 py-0.5 rounded-md text-[9px] uppercase tracking-[0.14em]"
                        style={{ background: "rgba(194,21,90,0.18)", border: "1px solid rgba(194,21,90,0.28)" }}
                      >
                        {scopeMeta[item.scope ?? "targeted"]}
                      </div>
                      {item.targetRole && item.targetRole !== "Auto" && (
                        <div className="text-[9px] uppercase tracking-[0.14em] text-rose-100/65">
                          {roleTargetLabel[item.targetRole]}
                        </div>
                      )}
                    </div>
                    <span className="whitespace-pre-wrap">{item.content}</span>
                    {item.createdAt && (
                      <div className="mt-1 text-[9px] text-rose-100/45">
                        {new Date(item.createdAt).toLocaleTimeString("ru-RU", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {typingLabel && (
                <div
                  className="flex justify-start items-center gap-2 px-3 py-2.5 w-fit rounded-xl text-xs"
                  style={{
                    background: "rgba(0,0,0,0.55)",
                    border: "1px solid rgba(194,21,90,0.20)",
                    color: "rgba(255,220,230,0.7)",
                  }}
                >
                  <IconSpinner />
                  {typingLabel}
                </div>
              )}

              {chatLoading && (
                <div className="flex justify-start items-center gap-2 px-3 py-2.5 w-fit rounded-xl text-xs"
                  style={{ background: "rgba(0,0,0,0.55)", border: "1px solid rgba(194,21,90,0.20)", color: "rgba(255,220,230,0.7)" }}>
                  <IconSpinner />
                  PM координирует ответ...
                </div>
              )}
            </div>

            {/* Chat input */}
            <form
              id="chat-form"
              onSubmit={askAgents}
              className="p-3 flex flex-col gap-2"
              style={{ borderTop: "1px solid rgba(194,21,90,0.20)" }}
            >
              <div
                className="rounded-lg px-3 py-2.5"
                style={{
                  background: "rgba(0,0,0,0.48)",
                  border: "1px solid rgba(194,21,90,0.24)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-rose-100/65">
                    Railway ENV
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowEnvComposer((previous) => !previous)}
                    className="text-[10px] uppercase tracking-[0.16em] px-2 py-1 rounded-md"
                    style={{
                      background: "rgba(194,21,90,0.14)",
                      border: "1px solid rgba(194,21,90,0.32)",
                      color: "rgba(255,220,230,0.9)",
                    }}
                  >
                    {showEnvComposer ? "Скрыть" : "Показать"}
                  </button>
                </div>

                {showEnvComposer && (
                  <div className="mt-2.5 space-y-2.5">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <label className="text-[10px] text-rose-100/65">
                        Service
                        <input
                          type="text"
                          value={envServiceName}
                          onChange={(event) => setEnvServiceName(event.target.value)}
                          placeholder="task-app"
                          className="mt-1 w-full rounded-md bg-black/50 px-2.5 py-2 text-xs text-white outline-none"
                          style={{ border: "1px solid rgba(194,21,90,0.24)" }}
                        />
                      </label>
                      <label className="text-[10px] text-rose-100/65">
                        ENV Key
                        <input
                          type="text"
                          value={envKey}
                          onChange={(event) => setEnvKey(normalizeEnvKeyInput(event.target.value))}
                          placeholder="NODE_ENV"
                          className="mt-1 w-full rounded-md bg-black/50 px-2.5 py-2 text-xs text-white outline-none"
                          style={{ border: "1px solid rgba(194,21,90,0.24)" }}
                        />
                      </label>
                      <label className="text-[10px] text-rose-100/65">
                        ENV Value
                        <input
                          type="text"
                          value={envValue}
                          onChange={(event) => setEnvValue(event.target.value)}
                          placeholder="production"
                          className="mt-1 w-full rounded-md bg-black/50 px-2.5 py-2 text-xs text-white outline-none"
                          style={{ border: "1px solid rgba(194,21,90,0.24)" }}
                        />
                      </label>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label className="inline-flex items-center gap-2 text-[11px] text-rose-100/75">
                        <input
                          type="checkbox"
                          checked={envDeployAfterSet}
                          onChange={(event) => setEnvDeployAfterSet(event.target.checked)}
                          className="h-3.5 w-3.5 accent-rose-500"
                        />
                        Запустить deploy после установки
                      </label>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={applyEnvCommandToChat}
                          className="px-2.5 py-1.5 rounded-md text-[10px] uppercase tracking-[0.16em]"
                          style={{
                            background: "rgba(194,21,90,0.14)",
                            border: "1px solid rgba(194,21,90,0.32)",
                            color: "rgba(255,220,230,0.9)",
                          }}
                        >
                          Вставить в чат
                        </button>
                        <button
                          type="button"
                          onClick={sendRailwayEnvCommand}
                          disabled={chatLoading}
                          className="px-2.5 py-1.5 rounded-md text-[10px] uppercase tracking-[0.16em] disabled:opacity-50"
                          style={{
                            background: "linear-gradient(135deg,#E8001E 0%,#C2155A 55%,#7B2FBE 100%)",
                            border: "1px solid rgba(194,21,90,0.45)",
                            color: "#fff",
                          }}
                        >
                          Отправить в DevOps
                        </button>
                      </div>
                    </div>

                    <p className="text-[10px] text-rose-100/50">
                      Консультант PM подскажет формат, если не уверены. Можно просто спросить: "как лучше задать ENV для Railway?".
                    </p>
                  </div>
                )}
              </div>

              <textarea
                id="chat-input"
                ref={chatInputRef}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onFocus={() => setActiveZone("chat")}
                placeholder="Напиши запрос. Пример: '@Алуа проверь регрессию чата'"
                disabled={chatLoading}
                className="min-h-[80px] max-h-[120px] resize-y w-full bg-black/50 px-4 py-3 text-sm outline-none rounded-lg text-white placeholder:text-rose-100/30"
                style={{ border: "1px solid rgba(194,21,90,0.22)" }}
                onKeyDown={(e) => {
                  if (e.key === "Tab" && mentionSuggestions.length > 0) {
                    e.preventDefault();
                    applyMention(mentionSuggestions[0]);
                    return;
                  }

                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    askAgents(e as unknown as FormEvent);
                  }
                }}
              />
              {mentionSuggestions.length > 0 && (
                <div
                  className="rounded-lg px-2 py-2"
                  style={{
                    background: "rgba(0,0,0,0.58)",
                    border: "1px solid rgba(194,21,90,0.28)",
                  }}
                >
                  <div className="px-2 pb-1 text-[10px] uppercase tracking-[0.2em] text-rose-100/55">
                    Сотрудники
                  </div>
                  <div className="space-y-1">
                    {mentionSuggestions.map((option) => (
                      <button
                        key={`${option.id}-${option.role}`}
                        type="button"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          applyMention(option);
                        }}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-rose-50/90 transition-colors"
                        style={{ background: "rgba(194,21,90,0.10)" }}
                      >
                        <span className="flex items-center gap-1.5">
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: option.isOnline ? "#10B981" : "#64748B" }}
                          />
                          @{option.label}
                        </span>
                        <span className="text-right">
                          <span className="block text-[10px] uppercase tracking-[0.16em] text-rose-100/60">
                            {roleTargetLabel[option.role]}
                          </span>
                          <span className="block text-[9px] text-rose-100/45">
                            {option.status}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                id="chat-send-btn"
                type="submit"
                disabled={chatLoading}
                className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 active:scale-95 disabled:opacity-50 disabled:pointer-events-none"
                style={{
                  background: chatLoading
                    ? "rgba(100,80,90,0.35)"
                    : "linear-gradient(135deg,#E8001E 0%,#C2155A 55%,#7B2FBE 100%)",
                  border: "1px solid rgba(194,21,90,0.45)",
                  color: "#fff",
                  boxShadow: chatLoading ? "none" : "0 0 18px rgba(194,21,90,0.35)",
                }}
              >
                {chatLoading ? <><IconSpinner /> Отправка...</> : <><IconSend /> Отправить сообщение</>}
              </button>
              <div className="text-center text-[9px] text-rose-100/30">
                Enter - отправить, Shift + Enter - новая строка, Tab - выбрать @подсказку
              </div>
            </form>
          </aside>
        </div>
      </div>
    </main>
  );
}


