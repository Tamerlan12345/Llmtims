"use client";

import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { supabase, isMockMode } from "@/lib/supabase/client";
import OfficeHub from "@/components/OfficeHub";
import OfficeKanbanBoard from "@/components/dashboard/OfficeKanbanBoard";
import TeamTemplatesPanel, {
  type DashboardTeamTemplate,
} from "@/components/dashboard/TeamTemplatesPanel";
import { TaskStatus } from "@/lib/office/engine";
import { buildOfficeRoomKey, type OfficeSummary } from "@/lib/offices/utils";
import HireModal from "@/components/dashboard/HireModal";
import ChatPanel from "@/components/dashboard/ChatPanel";
import TaskPanel from "@/components/dashboard/TaskPanel";
import ConsolePanel from "@/components/dashboard/ConsolePanel";
import HeaderStats from "@/components/dashboard/HeaderStats";

import { 
  IconLayout, 
  IconSearch, 
  IconPlus, 
  IconActivity, 
  IconBriefcase, 
  IconHistory, 
  IconSend, 
  IconSpinner, 
  IconUser,
  IconSettings
} from "@/components/icons";


/* ──── Types ─────────────────────────────────────────────────────────────── */
interface Agent {
  id: string;
  name: string;
  role: string;
  status?: string;
  avatar_url?: string;
  is_active: boolean;
  skills?: string[];
  role_md?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface TokenLog {
  agent_id?: string | null;
  prompt_tokens?: number | string;
  completion_tokens?: number | string;
}

interface TaskRecord {
  id: string;
  status: TaskStatus;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  workflow_mode?: "autonomous" | "manual" | null;
  manual_workflow_roles?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  office_id?: string | null;
}

interface SessionPayload {
  authenticated?: boolean;
  activeOffice?: { id?: string | null; name?: string | null } | null;
  offices?: OfficeSummary[];
}

type RoleTarget = string;
type WorkflowMode = "autonomous" | "manual";
type WorkflowRole = string;
type TeamEventScope = "broadcast" | "targeted" | "system";
type ChatScope = "auto" | "broadcast" | "targeted";
type RoomMode = "discussion" | "approval" | "execution";
type ActivityCategory = "task" | "chat" | "devops" | "mcp" | "system";
type ChatTimelineMode = "selected" | "all";
type ActivityFilter = "all" | ActivityCategory;
type DashboardLeftView = "office" | "kanban";

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
  taskId?: string | null;
  category?: ActivityCategory;
}

interface SkillCatalogItem {
  id: string;
  name: string;
  description: string | null;
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
  metadata?: { currentAction?: string; [key: string]: unknown };
}

interface PlayerStateRow {
  agent_id: string;
  role: string;
  status: string;
  is_online: boolean;
  typing_until?: string | null;
  tokens_total?: number | string;
}

interface AgentRuntimeStateRow {
  agent_id: string;
  status: string;
  current_action?: string | null;
  current_skill?: string | null;
  current_target_x?: number | null;
  current_target_y?: number | null;
  metadata?: Record<string, unknown> | null;
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
  workflowMode?: WorkflowMode;
  manualWorkflowRoles?: WorkflowRole[];
}

type ProcessTone = "info" | "run" | "ok" | "warn" | "error";

interface ProcessStep {
  id: string;
  label: string;
  detail: string;
  time: string;
  tone: ProcessTone;
  taskId?: string | null;
  category?: ActivityCategory;
}

interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  targetRole: RoleTarget | null;
  workflowMode?: WorkflowMode;
  manualWorkflowRoles?: WorkflowRole[];
  createdAt: string | null;
  updatedAt: string | null;
  source: "database" | "local";
}

/* ──── Constants ────────────────────────────────────────────────────────────── */
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

const parseStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0)
    )
  );
};

const splitChatTraceContent = (
  content: string
): {
  visible: string;
  hidden: string;
} => {
  const lines = String(content ?? "").split(/\r?\n/);
  const hiddenLines: string[] = [];
  const visibleLines: string[] = [];

  for (const line of lines) {
    const normalized = line.trim();
    if (/^\[(thought|tool execution)\]/i.test(normalized)) {
      hiddenLines.push(line);
      continue;
    }
    visibleLines.push(line);
  }

  return {
    visible: visibleLines.join("\n").trim(),
    hidden: hiddenLines.join("\n").trim(),
  };
};

const DOWNLOADABLE_FILE_URL_PATTERN = /\.(pdf|mp4|xlsx|xls|csv|docx?|zip|jpe?g|png|webp)(\?|#|$)/i;

const normalizeDownloadName = (value: string) => {
  const normalized = value.replace(/📥/g, "").trim();
  return normalized.length > 0 ? normalized : "artifact";
};

const isDownloadableLink = (url: string, label: string) => {
  return label.includes("📥") || DOWNLOADABLE_FILE_URL_PATTERN.test(url.toLowerCase());
};

const renderChatMarkdownContent = (content: string): ReactNode => {
  const source = String(content ?? "");
  if (!source.trim()) return null;

  const markdownTokenPattern = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)/g;
  const tokens: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null = markdownTokenPattern.exec(source);

  while (match) {
    if (match.index > cursor) {
      tokens.push(source.slice(cursor, match.index));
    }

    const [fullMatch, imageAlt, imageSrc, linkText, linkHref] = match;
    const key = `chat-md-${match.index}-${fullMatch.length}`;

    if (imageSrc) {
      const src = String(imageSrc).trim();
      const alt = String(imageAlt ?? "Изображение").trim() || "Изображение";
      tokens.push(
        <img
          key={key}
          src={src}
          alt={alt}
          className="max-w-full h-auto rounded-lg shadow-sm border mt-2 max-h-64 object-contain"
        />
      );
    } else if (linkHref) {
      const url = String(linkHref).trim();
      const text = String(linkText ?? "").trim() || url;
      const downloadable = isDownloadableLink(url, text);

      if (downloadable) {
        tokens.push(
          <a
            key={key}
            href={url}
            download={normalizeDownloadName(text)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 mt-2 bg-blue-600 text-white rounded-lg shadow hover:bg-blue-700 transition-colors no-underline text-sm font-medium"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            {text}
          </a>
        );
      } else {
        tokens.push(
          <a
            key={key}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:underline"
          >
            {text}
          </a>
        );
      }
    }

    cursor = match.index + fullMatch.length;
    match = markdownTokenPattern.exec(source);
  }

  if (cursor < source.length) {
    tokens.push(source.slice(cursor));
  }

  return <div className="whitespace-pre-wrap break-words">{tokens}</div>;
};

const mentionHandleByRole: Record<string, string> = {
  PM: "pm",
  Developer: "developer",
  QA: "qa",
  DevOps: "devops",
};

const getMentionHandle = (role: string) => {
  return mentionHandleByRole[role] ?? role.trim().toLowerCase().replace(/\s+/g, "");
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

const roleTargetLabel: Record<string, string> = {
  Auto: "Авто (через PM)",
  All: "Вся команда",
  PM: "PM",
  Developer: "Developer",
  QA: "QA",
  DevOps: "DevOps",
};

const getRoleTargetLabel = (value: string) => roleTargetLabel[value] ?? value;

const DASHBOARD_VIEW_OPTIONS: Array<{ value: DashboardLeftView; label: string }> = [
  { value: "office", label: "🏢 Офис" },
  { value: "kanban", label: "📋 Канбан" },
];

const statusMeta: Record<string, { label: string; color: string }> = {
  pending: { label: "Ожидание", color: "#F59E0B" },
  in_progress: { label: "В работе", color: "#E8001E" },
  review: { label: "Ревью", color: "#F97316" },
  waiting_approval: { label: "Ждет подтверждения", color: "#F97316" },
  done: { label: "Готово", color: "#10B981" },
  failed: { label: "Сбой", color: "#EF4444" },
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

const TASK_CARD_LIMIT = 12;

const MCP_ACTIVITY_MARKERS = ["mcp", "railway", "github", "sandbox", "env", "token", "connector"];
const DEVOPS_ACTIVITY_MARKERS = ["deploy", "release", "infra", "rollback", "build", "log", "монитор", "деплой", "релиз", "окружен"];

const normalizeRoleTarget = (value: string | null | undefined): RoleTarget | null => {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

const normalizeWorkflowMode = (value: unknown): WorkflowMode => {
  return value === "manual" ? "manual" : "autonomous";
};

const normalizeWorkflowRoles = (value: unknown): WorkflowRole[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((role): role is string => typeof role === "string")
        .map((role) => role.trim())
        .filter((role) => role.length > 0)
    )
  );
};

const formatTaskShortId = (taskId: string) => taskId.slice(0, 8);

const buildTaskTitle = (description?: string | null, taskId?: string) => {
  const normalized = (description ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return taskId ? `Task ${formatTaskShortId(taskId)}` : "Новая задача";
  }
  if (normalized.length <= 56) return normalized;
  return `${normalized.slice(0, 56).trim()}…`;
};

const normalizeTaskMetadataTargetRole = (metadata?: Record<string, unknown> | null): RoleTarget | null => {
  const value = typeof metadata?.targetRole === "string" ? metadata.targetRole : null;
  return normalizeRoleTarget(value);
};

const normalizeTaskWorkflowMode = (task: TaskRecord): WorkflowMode => {
  return normalizeWorkflowMode(task.workflow_mode ?? task.metadata?.workflowMode);
};

const normalizeTaskWorkflowRoles = (task: TaskRecord): WorkflowRole[] => {
  return normalizeWorkflowRoles(task.manual_workflow_roles ?? task.metadata?.manualWorkflowRoles);
};

const isTaskHidden = (metadata?: Record<string, unknown> | null) => metadata?.hidden === true;

const compareTaskItems = (left: TaskItem, right: TaskItem) => {
  const leftStamp = left.updatedAt ?? left.createdAt ?? "";
  const rightStamp = right.updatedAt ?? right.createdAt ?? "";
  if (leftStamp !== rightStamp) {
    return rightStamp.localeCompare(leftStamp);
  }
  return right.id.localeCompare(left.id);
};

const toTaskItem = (
  task: TaskRecord,
  source: TaskItem["source"] = "database"
): TaskItem | null => {
  if (isTaskHidden(task.metadata)) return null;

  const description = (task.description ?? "").trim();
  return {
    id: task.id,
    title: buildTaskTitle(description, task.id),
    description,
    status: task.status,
    targetRole: normalizeTaskMetadataTargetRole(task.metadata),
    workflowMode: normalizeTaskWorkflowMode(task),
    manualWorkflowRoles: normalizeTaskWorkflowRoles(task),
    createdAt: task.created_at ?? null,
    updatedAt: task.updated_at ?? null,
    source,
  };
};

const mergeTaskItems = (current: TaskItem[], incoming: TaskItem[]) => {
  const nextMap = new Map<string, TaskItem>();

  for (const item of current) {
    nextMap.set(item.id, item);
  }

  for (const item of incoming) {
    const previous = nextMap.get(item.id);
    nextMap.set(item.id, {
      ...previous,
      ...item,
      targetRole: item.targetRole ?? previous?.targetRole ?? null,
      workflowMode: item.workflowMode ?? previous?.workflowMode ?? "autonomous",
      manualWorkflowRoles:
        item.manualWorkflowRoles ?? previous?.manualWorkflowRoles ?? [],
    });
  }

  return Array.from(nextMap.values()).sort(compareTaskItems).slice(0, TASK_CARD_LIMIT);
};

const normalizeTaskIdValue = (value: unknown): string | null => {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

const detectActivityCategory = (
  content: string,
  role?: string | null,
  scope?: TeamEventScope,
  eventName?: string | null
): ActivityCategory => {
  const normalized = content.toLowerCase();
  if (eventName?.startsWith("task.") || eventName?.startsWith("workflow.")) return "task";
  if (scope === "system") return "system";
  if (role === "DevOps") return "devops";
  if (MCP_ACTIVITY_MARKERS.some((marker) => normalized.includes(marker))) return "mcp";
  if (DEVOPS_ACTIVITY_MARKERS.some((marker) => normalized.includes(marker))) return "devops";
  return "chat";
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

/* ──── Component ──────────────────────────────────────────────────────────── */
export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const [activeOfficeId, setActiveOfficeId] = useState<string | null>(isMockMode ? "mock-office" : null);
  const [activeOfficeName, setActiveOfficeName] = useState<string>(isMockMode ? "Digital Pixel Office" : "Loading office...");
  const [availableOffices, setAvailableOffices] = useState<OfficeSummary[]>([]);
  const [agents, setAgents] = useState<Agent[]>(isMockMode ? MOCK_AGENTS : []);
  const [totalTokens, setTotalTokens] = useState(0);
  const [agentTokenUsage, setAgentTokenUsage] = useState<Record<string, number>>({});
  const [roomMode, setRoomMode] = useState<RoomMode>("discussion");
  const [roomRevision, setRoomRevision] = useState(0);
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [taskItems, setTaskItems] = useState<TaskItem[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [chatTimelineMode, setChatTimelineMode] = useState<ChatTimelineMode>("all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [isTaskDeleting, setIsTaskDeleting] = useState<string | null>(null);
  const [currentAgentThought, setCurrentAgentThought] = useState<string | null>(null);
  const [approvalDraft, setApprovalDraft] = useState<ApprovalDraft | null>(null);
  const [activeView, setActiveView] = useState<DashboardLeftView>("office");
  const [chatScope, setChatScope] = useState<ChatScope>("auto");
  const [typingRoles, setTypingRoles] = useState<string[]>([]);
  const [playerStateByRole, setPlayerStateByRole] = useState<Record<string, { status: string; isOnline: boolean }>>({});
  const [agentRuntimeStateById, setAgentRuntimeStateById] = useState<Record<string, AgentRuntimeStateRow>>({});
  const [eventFeed, setEventFeed] = useState<string[]>([]);
  const [processFeed, setProcessFeed] = useState<ProcessStep[]>([]);
  const [isDashboardCollapsed, setIsDashboardCollapsed] = useState(false);
  const [activeZone, setActiveZone] = useState<"office" | "task" | "chat" | null>(null);
  const [taskInput, setTaskInput] = useState("");
  const [taskTargetRole, setTaskTargetRole] = useState<RoleTarget>("All");
  const [taskWorkflowMode, setTaskWorkflowMode] = useState<WorkflowMode>("autonomous");
  const [manualWorkflowRoles, setManualWorkflowRoles] = useState<WorkflowRole[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [taskStatus, setTaskStatus] = useState<TaskStatus>(isMockMode ? "in_progress" : "pending");
  const [teamTemplates, setTeamTemplates] = useState<DashboardTeamTemplate[]>([]);
  const [isTemplatesLoading, setIsTemplatesLoading] = useState(false);
  const [isTemplateSaving, setIsTemplateSaving] = useState(false);
  const [isHiringTemplateId, setIsHiringTemplateId] = useState<string | null>(null);
  const [skillsCatalog, setSkillsCatalog] = useState<SkillCatalogItem[]>([]);
  const [isCreateOfficeOpen, setIsCreateOfficeOpen] = useState(false);
  const [newOfficeName, setNewOfficeName] = useState("");
  const [newOfficeTemplateId, setNewOfficeTemplateId] = useState("");
  const [isCreatingOffice, setIsCreatingOffice] = useState(false);
  const [isHireAgentOpen, setIsHireAgentOpen] = useState(false);
  const [hireRoleName, setHireRoleName] = useState("");
  const [hireDisplayName, setHireDisplayName] = useState("");
  const [hireRoleMarkdown, setHireRoleMarkdown] = useState("");
  const [hireSkillNames, setHireSkillNames] = useState<string[]>([]);
  const [isHiringAgent, setIsHiringAgent] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatTargetRole, setChatTargetRole] = useState<RoleTarget>("Auto");
  const [chatLoading, setChatLoading] = useState(false);
  const [showEnvComposer, setShowEnvComposer] = useState(false);
  const [envServiceName, setEnvServiceName] = useState("task-app");
  const [envKey, setEnvKey] = useState("");
  const [envValue, setEnvValue] = useState("");
  const [envDeployAfterSet, setEnvDeployAfterSet] = useState(true);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "boot",
      sender: "agent",
      agentName: "Система",
      role: "System",
      content: "Командный центр на связи. Опишите задачу, и агенты приступят к работе.",
    },
  ]);
  const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);
  const [interactionTargetRole, setInteractionTargetRole] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenClientMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingTaskIdRef = useRef<string | null>(null);
  const activeRoomKey = useMemo(() => buildOfficeRoomKey(activeOfficeId), [activeOfficeId]);

  const hydrateAgentsWithSkills = async (rows: unknown[]): Promise<Agent[]> => {
    const baseAgents = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const value = row as Record<string, unknown>;
        const id = typeof value.id === "string" ? value.id : "";
        const role = typeof value.role === "string" ? value.role : "";
        if (!id || !role) return null;
        return {
          id,
          name: typeof value.name === "string" && value.name.trim().length > 0 ? value.name : role,
          role,
          status: typeof value.status === "string" ? value.status : undefined,
          avatar_url: typeof value.avatar_url === "string" ? value.avatar_url : undefined,
          is_active: Boolean(value.is_active),
          skills: parseStringList(value.skills),
          role_md: typeof value.role_md === "string" ? value.role_md : null,
          metadata:
            value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
              ? (value.metadata as Record<string, unknown>)
              : null,
        } as Agent;
      })
      .filter((agent): agent is Agent => Boolean(agent));

    if (baseAgents.length === 0 || isMockMode) {
      return baseAgents;
    }

    try {
      const agentIds = baseAgents.map((agent) => agent.id);
      const { data: installedSkills } = await supabase
        .from("agent_skills")
        .select("agent_id, skill_id")
        .in("agent_id", agentIds)
        .eq("is_enabled", true);

      const skillIds = Array.from(
        new Set(
          (installedSkills ?? [])
            .map((row) => (typeof row.skill_id === "string" ? row.skill_id : ""))
            .filter((value) => value.length > 0)
        )
      );

      if (skillIds.length === 0) {
        return baseAgents;
      }

      const { data: skillRows } = await supabase
        .from("skills_catalog")
        .select("id, name")
        .in("id", skillIds)
        .eq("is_active", true);

      const skillNameById = new Map<string, string>();
      for (const skill of skillRows ?? []) {
        if (typeof skill.id === "string" && typeof skill.name === "string") {
          skillNameById.set(skill.id, skill.name);
        }
      }

      const skillsByAgentId = new Map<string, string[]>();
      for (const row of installedSkills ?? []) {
        if (typeof row.agent_id !== "string" || typeof row.skill_id !== "string") continue;
        const skillName = skillNameById.get(row.skill_id);
        if (!skillName) continue;
        const current = skillsByAgentId.get(row.agent_id) ?? [];
        current.push(skillName);
        skillsByAgentId.set(row.agent_id, current);
      }

      return baseAgents.map((agent) => ({
        ...agent,
        skills: Array.from(new Set([...(agent.skills ?? []), ...(skillsByAgentId.get(agent.id) ?? [])])),
      }));
    } catch {
      return baseAgents;
    }
  };

  useEffect(() => {
    pendingTaskIdRef.current = pendingTaskId;
  }, [pendingTaskId]);

  useEffect(() => {
    if (isMockMode) return;

    let cancelled = false;
    const loadOfficeContext = async () => {
      try {
        const response = await fetch("/api/auth/session", { method: "GET" });
        const payload = (await response.json()) as SessionPayload;
        if (cancelled) return;

        const offices = Array.isArray(payload.offices) ? payload.offices : [];
        const nextOfficeId = payload.activeOffice?.id ?? offices[0]?.id ?? null;
        const nextOfficeName =
          payload.activeOffice?.name ??
          offices[0]?.name ??
          "Digital Pixel Office";

        setAvailableOffices(offices);
        setActiveOfficeId(nextOfficeId);
        setActiveOfficeName(nextOfficeName);
      } catch {
        if (!cancelled) {
          setAvailableOffices([]);
          setActiveOfficeId(null);
          setActiveOfficeName("Digital Pixel Office");
        }
      }
    };

    void loadOfficeContext();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isMockMode) {
      setTeamTemplates([]);
      return;
    }

    let cancelled = false;
    const loadTeamTemplates = async () => {
      setIsTemplatesLoading(true);
      try {
        const response = await fetch("/api/team-templates", { method: "GET" });
        const payload = (await response.json()) as { templates?: DashboardTeamTemplate[] };
        if (!response.ok || cancelled) return;
        setTeamTemplates(Array.isArray(payload.templates) ? payload.templates : []);
      } catch {
        if (!cancelled) {
          setTeamTemplates([]);
        }
      } finally {
        if (!cancelled) {
          setIsTemplatesLoading(false);
        }
      }
    };

    void loadTeamTemplates();
    return () => {
      cancelled = true;
    };
  }, [activeOfficeId]);

  useEffect(() => {
    if (isMockMode) {
      setSkillsCatalog([]);
      return;
    }

    let cancelled = false;
    const loadSkillCatalog = async () => {
      try {
        const { data, error } = await supabase
          .from("skills_catalog")
          .select("id, name, description")
          .eq("is_active", true)
          .order("name", { ascending: true });

        if (cancelled) return;
        if (error) throw error;

        const skills = (Array.isArray(data) ? data : [])
          .map((row) => {
            const id = typeof row.id === "string" ? row.id : "";
            const name = typeof row.name === "string" ? row.name.trim() : "";
            if (!id || !name) return null;
            return {
              id,
              name,
              description: typeof row.description === "string" ? row.description : null,
            } satisfies SkillCatalogItem;
          })
          .filter((item): item is SkillCatalogItem => Boolean(item));

        setSkillsCatalog(skills);
      } catch {
        if (!cancelled) {
          setSkillsCatalog([]);
        }
      }
    };

    void loadSkillCatalog();
    return () => {
      cancelled = true;
    };
  }, [activeOfficeId]);

  const workflowRoleOptions = useMemo(
    () =>
      Array.from(
        new Set(
          agents
            .map((agent) => (typeof agent.role === "string" ? agent.role.trim() : ""))
            .filter((role) => role.length > 0)
        )
      ),
    [agents]
  );
  const coordinatorRole = useMemo(() => {
    const normalizedRoles = workflowRoleOptions;
    const explicitCoordinator = normalizedRoles.find((role) => {
      const lowered = role.toLowerCase();
      return (
        lowered.includes("pm") ||
        lowered.includes("ceo") ||
        lowered.includes("manager") ||
        lowered.includes("lead") ||
        lowered.includes("owner") ||
        lowered.includes("expert")
      );
    });
    return explicitCoordinator ?? normalizedRoles[0] ?? "PM";
  }, [workflowRoleOptions]);
  const operationsRole = useMemo(() => {
    const explicitOps = workflowRoleOptions.find((role) => {
      const lowered = role.toLowerCase();
      return (
        lowered.includes("devops") ||
        lowered.includes("ops") ||
        lowered.includes("sre") ||
        lowered.includes("infra") ||
        lowered.includes("platform")
      );
    });
    return explicitOps ?? workflowRoleOptions[workflowRoleOptions.length - 1] ?? coordinatorRole;
  }, [coordinatorRole, workflowRoleOptions]);
  const selectedTask = useMemo(
    () => taskItems.find((task) => task.id === selectedTaskId) ?? null,
    [taskItems, selectedTaskId]
  );

  const visibleChatMessages = useMemo(() => {
    if (chatTimelineMode === "all" || !selectedTaskId) {
      return chatMessages;
    }
    return chatMessages.filter((message) => message.taskId === selectedTaskId);
  }, [chatMessages, chatTimelineMode, selectedTaskId]);

  const typingLabel = useMemo(() => {
    if (typingRoles.length === 0) return null;
    if (typingRoles.length === 1) return `${typingRoles[0]} печатает...`;
    return `${typingRoles.join(", ")} печатают...`;
  }, [typingRoles]);

  useEffect(() => {
    if (pendingTaskId && !selectedTaskId) {
      setSelectedTaskId(pendingTaskId);
    }
  }, [pendingTaskId, selectedTaskId]);

  const mentionDirectory = useMemo<MentionOption[]>(() => {
    const rosterSource = agents.length > 0 ? agents : MOCK_AGENTS;
    return rosterSource
      .filter((agent) => typeof agent.role === "string" && agent.role.trim().length > 0)
      .map((agent) => ({
        id: agent.id,
        role: agent.role as RoleTarget,
        label: agent.name,
        handle: getMentionHandle(agent.role),
        isOnline: playerStateByRole[agent.role]?.isOnline ?? true,
        status: playerStateByRole[agent.role]?.status ?? "idle",
      }))
      .sort((left, right) => {
        if (left.isOnline !== right.isOnline) return left.isOnline ? -1 : 1;
        return left.label.localeCompare(right.label, "ru");
      });
  }, [agents, playerStateByRole]);

  const resolveMentionTargetRole = (message: string): RoleTarget => {
    const mentionToken = message.match(/@([^\s@]+)/)?.[1]?.toLowerCase();
    if (!mentionToken) return chatTargetRole;
    if (mentionToken === "all") return "All";
    const byDirectory = mentionDirectory.find((option) => matchMentionOption(option, mentionToken));
    return byDirectory ? byDirectory.role : chatTargetRole;
  };

  const appendChatMessage = (entry: ChatMessage) => {
    const normalizedEntry: ChatMessage = {
      ...entry,
      category: entry.category ?? detectActivityCategory(entry.content, entry.role, entry.scope),
      taskId: entry.taskId ?? null,
    };

    setChatMessages((previous) => {
      if (
        normalizedEntry.clientMessageId &&
        previous.some(
          (item) =>
            item.clientMessageId === normalizedEntry.clientMessageId &&
            item.sender === normalizedEntry.sender &&
            item.content === normalizedEntry.content
        )
      ) {
        return previous;
      }
      return [...previous, normalizedEntry].slice(-120);
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
    const normalizedStep: ProcessStep = {
      ...step,
      category: step.category ?? detectActivityCategory(`${step.label} ${step.detail}`),
      taskId: step.taskId ?? null,
    };

    setProcessFeed((previous) => {
      if (previous.some((item) => item.id === normalizedStep.id)) return previous;
      return [normalizedStep, ...previous].slice(0, 30);
    });
  };

  const upsertTaskItems = (items: TaskItem[]) => {
    if (items.length === 0) return;
    setTaskItems((previous) => mergeTaskItems(previous, items));
  };

  const upsertTaskRecord = (task: TaskRecord, source: TaskItem["source"] = "database") => {
    const normalized = toTaskItem(task, source);
    if (!normalized) {
      setTaskItems((previous) => previous.filter((item) => item.id !== task.id));
      if (selectedTaskId === task.id) setSelectedTaskId(null);
      return;
    }
    upsertTaskItems([normalized]);
  };

  const removeTaskFromDashboard = (taskId: string) => {
    setTaskItems((previous) => previous.filter((item) => item.id !== taskId));
    if (selectedTaskId === taskId) setSelectedTaskId(null);
  };

  const createOffice = async () => {
    const normalizedName = newOfficeName.trim();
    if (!normalizedName || isCreatingOffice) return;
    setIsCreatingOffice(true);
    try {
      if (isMockMode) {
        const mockOffice = { id: `mock-${Date.now()}`, name: normalizedName, accessRole: "owner" as const };
        setAvailableOffices((prev) => [mockOffice, ...prev]);
        setActiveOfficeId(mockOffice.id);
        setActiveOfficeName(mockOffice.name);
      } else {
        const res = await fetch("/api/offices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: normalizedName }),
        });
        const data = await res.json();
        if (data.office) {
           setAvailableOffices(prev => [data.office, ...prev]);
           setActiveOfficeId(data.office.id);
           setActiveOfficeName(data.office.name);
        }
      }
      setIsCreateOfficeOpen(false);
      setNewOfficeName("");
    } catch (e) {
      console.error(e);
    } finally {
      setIsCreatingOffice(false);
    }
  };

  const buildProcessStepFromEvent = (eventRow: TeamEventRow): ProcessStep | null => {
    const payload = eventRow.payload ?? {};
    const message = extractEventMessage(payload);
    const taskId = normalizeTaskIdValue(payload.taskId);
    const sender = eventRow.sender_name ?? eventRow.sender_role ?? "Система";
    const time = formatProcessTime(eventRow.created_at);
    const category = detectActivityCategory(message ?? eventRow.event_name, eventRow.sender_role, eventRow.scope, eventRow.event_name);

    if (eventRow.event_name === "workflow.approval_requested") {
      return { id: `proc-${eventRow.id}`, label: "Ожидание подтверждения", detail: message ?? "Требуется запуск проекта.", time, tone: "warn", taskId, category };
    }
    if (eventRow.event_name === "task.execution_started") {
      return { id: `proc-${eventRow.id}`, label: "Выполнение начато", detail: `${sender} приступил к работе.`, time, tone: "run", taskId, category };
    }
    if (eventRow.event_name === "task.execution_completed") {
      return { id: `proc-${eventRow.id}`, label: "Выполнение завершено", detail: `${sender} закончил задачу.`, time, tone: "ok", taskId, category };
    }
    if (eventRow.event_name === "chat.agent_response" && message) {
      return { id: `proc-${eventRow.id}`, label: `ИИ: ${sender}`, detail: message.slice(0, 100) + "...", time, tone: "info", taskId, category };
    }
    return null;
  };

  const activateRoleAnimation = (role?: string, forcedTargetRole?: string | null) => {
    const speaker = agents.find((a) => a.role === role);
    if (speaker) {
      setAgents((prev) => prev.map((a) => ({ ...a, is_active: a.id === speaker.id })));
      setSpeakingAgentId(speaker.id);
      window.setTimeout(() => setSpeakingAgentId(null), 2600);
    }
  };

  const resolveScopeForRequest = (targetRole: RoleTarget): TeamEventScope => {
    if (chatScope === "broadcast") return "broadcast";
    if (chatScope === "targeted") return "targeted";
    return targetRole === "All" ? "broadcast" : "targeted";
  };

  const sendMessageToAgents = async (rawMessage: string, preferredTargetRole: RoleTarget) => {
    const message = rawMessage.trim();
    if (!message || chatLoading) return;
    const resolvedTargetRole = /@([^\s@]+)/.test(message) ? resolveMentionTargetRole(message) : preferredTargetRole;
    const resolvedScope = resolveScopeForRequest(resolvedTargetRole);
    const clientMessageId = `chat-${makeId()}`;
    const contextTaskId = selectedTaskId ?? pendingTaskId ?? approvalDraft?.taskId ?? null;

    const userEntry: ChatMessage = {
      id: makeId(), sender: "user", content: message, scope: resolvedScope, targetRole: resolvedTargetRole,
      clientMessageId, createdAt: new Date().toISOString(), taskId: contextTaskId,
    };
    appendChatMessage(userEntry);
    setChatLoading(true);

    try {
      const res = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message, targetRole: resolvedTargetRole, scope: resolvedScope,
          roomKey: activeRoomKey, officeId: activeOfficeId, clientMessageId,
          selectedTaskId: contextTaskId, history: chatMessages.slice(-5).map(m => ({ role: m.sender === "user" ? "user" : "assistant", content: m.content }))
        }),
      });
      const data = await res.json();
      appendChatMessage({
        id: makeId(), sender: "agent", role: data.role, agentName: data.agentName ?? data.role,
        content: data.message ?? "Нет ответа.", scope: data.scope ?? resolvedScope,
        targetRole: normalizeRoleTarget(data.targetRole), clientMessageId: data.clientMessageId,
        createdAt: new Date().toISOString(), taskId: data.taskId ?? contextTaskId,
      });
      activateRoleAnimation(data.role, data.targetRole);
    } catch {
       console.error("Chat error");
    } finally {
      setChatLoading(false);
    }
  };

  const askAgents = (e: FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    const msg = chatInput;
    setChatInput("");
    sendMessageToAgents(msg, chatTargetRole);
  };

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted || isMockMode || !activeOfficeId) return;

    const refreshData = async () => {
      const { data: agentsData } = await supabase.from("agents").select("*").eq("office_id", activeOfficeId);
      if (agentsData) setAgents(await hydrateAgentsWithSkills(agentsData));

      const { data: roomData } = await supabase.from("room_state").select("*").eq("room_key", activeRoomKey).maybeSingle();
      if (roomData) {
        setRoomMode(roomData.mode);
        setTaskStatus(roomData.task_status);
        setPendingTaskId(roomData.pending_task_id);
      }

      const { data: tasksData } = await supabase.from("tasks").select("*").eq("office_id", activeOfficeId).order("updated_at", { ascending: false }).limit(TASK_CARD_LIMIT);
      if (tasksData) setTaskItems((tasksData as TaskRecord[]).map(t => toTaskItem(t)).filter((t): t is TaskItem => !!t));

      const { data: playerRows } = await supabase.from("player_state").select("*").eq("room_key", activeRoomKey);
      if (playerRows) {
        const st: Record<string, any> = {};
        const ty: string[] = [];
        for (const r of playerRows as PlayerStateRow[]) {
          st[r.role] = { status: r.status, isOnline: r.is_online };
          if (isTypingState(r.status, r.typing_until)) ty.push(r.role);
        }
        setPlayerStateByRole(st);
        setTypingRoles(ty);
      }
    };

    refreshData();
    const timer = setInterval(refreshData, 5000);
    return () => clearInterval(timer);
  }, [activeOfficeId, activeRoomKey, mounted]);

  if (!mounted) return null;

  return (
    <main className="fixed inset-0 bg-[#0d0308] text-rose-50 overflow-hidden flex flex-col selection:bg-red-500/30">
      {/* Background FX */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-30">
        <div className="absolute -top-[20%] -left-[10%] w-[60%] h-[60%] bg-red-900/20 blur-[120px] rounded-full" />
        <div className="absolute -bottom-[20%] -right-[10%] w-[60%] h-[60%] bg-violet-900/10 blur-[120px] rounded-full" />
      </div>

      <div className="relative z-20 p-6 flex flex-col gap-6 h-full overflow-hidden">
        <HeaderStats 
          offices={availableOffices}
          activeOfficeId={activeOfficeId}
          onOfficeChange={(id) => {
            const office = availableOffices.find(o => o.id === id);
            if (office) {
              setActiveOfficeId(office.id);
              setActiveOfficeName(office.name);
            }
          }}
          onAddOffice={() => setIsCreateOfficeOpen(true)}
          stats={{
            agentsCount: agents.length,
            activeTasks: taskItems.filter(t => t.status !== "done").length,
            completedTasks: taskItems.filter(t => t.status === "done").length,
            eventsToday: processFeed.length,
          }}
        />

        <div className="flex flex-1 gap-6 min-h-0 overflow-hidden">
          {/* Dashboard Left Rail */}
          <aside className="w-[320px] flex flex-col gap-6 shrink-0 h-full overflow-hidden">
            <div className="flex-1 min-h-0">
               <TaskPanel 
                 tasks={taskItems as any}
                 selectedTaskId={selectedTaskId}
                 onSelectTask={setSelectedTaskId}
               />
            </div>
            <div className="h-[300px]">
               <ConsolePanel feed={processFeed as any} />
            </div>
          </aside>

          {/* Main Visualizing View */}
          <section className="flex-1 min-w-0 relative flex flex-col glass-card border-none bg-black/20 overflow-hidden rounded-3xl">
            <div className="absolute inset-0 z-0">
               <OfficeHub 
                 officeId={activeOfficeId} 
                 onAgentClick={(id) => console.log("Agent", id)} 
               />
            </div>

            <div className="absolute top-4 right-4 z-10 flex gap-2">
               {DASHBOARD_VIEW_OPTIONS.map(opt => (
                 <button 
                   key={opt.value}
                   onClick={() => setActiveView(opt.value)}
                   className={`px-4 py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest border transition-all ${
                     activeView === opt.value 
                      ? "bg-red-600/20 border-red-500/50 text-red-50 shadow-[0_0_15px_rgba(232,0,30,0.2)]" 
                      : "bg-black/40 border-red-200/10 text-rose-100/40 hover:text-rose-100/70 hover:bg-black/60"
                   }`}
                 >
                   {opt.label}
                 </button>
               ))}
               <button 
                 onClick={() => setIsHireAgentOpen(true)}
                 className="p-2.5 rounded-xl border border-red-200/10 bg-red-600/20 text-red-500 hover:scale-110 active:scale-95 transition-all shadow-lg shadow-red-900/20"
               >
                 <IconPlus />
               </button>
            </div>
            
            {activeView === "kanban" && (
              <div className="absolute inset-0 z-10 bg-black/80 backdrop-blur-xl overflow-auto p-8">
                 <OfficeKanbanBoard
                   tasks={taskItems as any}
                   officeName={activeOfficeName}
                   onTaskClick={(id) => {
                     setSelectedTaskId(id);
                     setActiveView("office");
                   }}
                 />
              </div>
            )}
          </section>

          {/* OperChat Command Panel */}
          <aside className="w-[400px] flex flex-col shrink-0 h-full overflow-hidden">
            <ChatPanel 
              messages={visibleChatMessages as any}
              agents={agents as any}
              activeOfficeId={activeOfficeId}
              activeOfficeName={activeOfficeName}
              loading={chatLoading}
              typingLabel={typingLabel}
              onSendMessage={(content) => {
                 setChatInput(content);
                 // We trigger askAgents via a ref or by calling it directly 
                 // Here we simulate the submit
                 sendMessageToAgents(content, chatTargetRole);
              }}
            />
          </aside>
        </div>
      </div>

      {/* Hire Construct Modal */}
      <HireModal
        isOpen={isHireAgentOpen}
        onClose={() => setIsHireAgentOpen(false)}
        officeId={activeOfficeId}
        onSuccess={(agent) => {
          appendProcessStep({
            id: makeId(),
            label: "Сотрудник нанят",
            detail: `${agent.name} (${agent.role}) добавлен в офис.`,
            time: formatProcessTime(),
            tone: "ok",
            category: "system",
          });
        }}
      />

      {/* Location Creator */}
      {isCreateOfficeOpen && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
           <div className="w-full max-w-md glass-card bg-[#0e0708] p-8 space-y-6 rounded-3xl border border-red-500/20">
              <h2 className="text-xl font-bold text-red-50">Создать департамент</h2>
              <input 
                value={newOfficeName} 
                onChange={e => setNewOfficeName(e.target.value)}
                placeholder="Имя департамента..."
                className="w-full bg-black/40 border border-red-200/20 rounded-xl px-4 py-3 text-white outline-none focus:border-red-500/50"
              />
              <div className="flex gap-4 pt-2">
                 <button onClick={() => setIsCreateOfficeOpen(false)} className="flex-1 py-3 text-rose-100/50 hover:bg-white/5 rounded-xl font-bold transition-all">Отмена</button>
                 <button onClick={createOffice} disabled={!newOfficeName.trim() || isCreatingOffice} className="flex-1 py-3 bg-red-600 rounded-xl font-bold text-white shadow-lg shadow-red-900/40 hover:bg-red-500 active:scale-95 transition-all">
                    {isCreatingOffice ? "Создание..." : "Создать"}
                 </button>
              </div>
           </div>
        </div>
      )}
    </main>
  );
}
