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

/* в”Ђв”Ђв”Ђ Types в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
interface Agent {
  id: string;
  name: string;
  role: "PM" | "Developer" | "QA" | "DevOps" | string;
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
  metadata?: { currentAction?: string;[key: string]: unknown };
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

const workflowModeLabel: Record<WorkflowMode, string> = {
  autonomous: "CEO / автономно",
  manual: "Ручной граф",
};

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
const ACTIVITY_FILTER_OPTIONS: Array<{ value: ActivityFilter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "task", label: "Task" },
  { value: "devops", label: "DevOps" },
  { value: "mcp", label: "MCP" },
  { value: "system", label: "System" },
];

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

/* в”Ђв”Ђв”Ђ SVG Icon helpers в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
const IconSend = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2L11 13" />
    <path d="M22 2L15 22 11 13 2 9l20-7z" />
  </svg>
);

const IconPlay = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const IconSpinner = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
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
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

/* в”Ђв”Ђв”Ђ Component в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
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
      agentName: "PM",
      role: "PM",
      coordinator: "PM",
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

  const activeAgent = useMemo(() => agents.find((a) => a.is_active), [agents]);
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
  const currentStatus = statusMeta[taskStatus] ?? { label: taskStatus, color: "#9CA3AF" };
  const currentRoomMode = roomModeMeta[roomMode];
  const selectedTask = useMemo(
    () => taskItems.find((task) => task.id === selectedTaskId) ?? null,
    [taskItems, selectedTaskId]
  );
  const taskActivityStats = useMemo(() => {
    const stats: Record<string, { logs: number; messages: number }> = {};

    for (const step of processFeed) {
      if (!step.taskId) continue;
      stats[step.taskId] = stats[step.taskId] ?? { logs: 0, messages: 0 };
      stats[step.taskId].logs += 1;
    }

    for (const message of chatMessages) {
      if (!message.taskId) continue;
      stats[message.taskId] = stats[message.taskId] ?? { logs: 0, messages: 0 };
      stats[message.taskId].messages += 1;
    }

    return stats;
  }, [chatMessages, processFeed]);
  const selectedTaskStats = selectedTask
    ? taskActivityStats[selectedTask.id] ?? { logs: 0, messages: 0 }
    : { logs: 0, messages: 0 };
  const manualWorkflowPreview = useMemo(() => {
    return manualWorkflowRoles.length > 0 ? manualWorkflowRoles.join(" -> ") : "Выберите хотя бы одну роль";
  }, [manualWorkflowRoles]);
  const visibleProcessFeed = useMemo(() => {
    return processFeed.filter((step) => {
      if (selectedTaskId && step.taskId && step.taskId !== selectedTaskId) return false;
      if (selectedTaskId && chatTimelineMode === "selected" && !step.taskId) return false;
      if (activityFilter !== "all" && step.category !== activityFilter) return false;
      return true;
    });
  }, [activityFilter, chatTimelineMode, processFeed, selectedTaskId]);
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
    if (manualWorkflowRoles.length > 0) return;
    const suggestedRoles = workflowRoleOptions.filter((role) => role !== coordinatorRole);
    if (suggestedRoles.length === 0) return;
    setManualWorkflowRoles(suggestedRoles.slice(0, Math.min(3, suggestedRoles.length)));
  }, [coordinatorRole, manualWorkflowRoles.length, workflowRoleOptions]);

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

    return chatTargetRole;
  };

  const appendChatMessage = (entry: ChatMessage) => {
    const normalizedEntry: ChatMessage = {
      ...entry,
      category:
        entry.category ??
        detectActivityCategory(entry.content, entry.role, entry.scope),
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
      const next = [...previous, normalizedEntry];
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
      if (selectedTaskId === task.id) {
        setSelectedTaskId((previous) => (previous === task.id ? null : previous));
      }
      return;
    }

    upsertTaskItems([normalized]);
  };

  const removeTaskFromDashboard = (taskId: string) => {
    setTaskItems((previous) => previous.filter((item) => item.id !== taskId));
    setSelectedTaskId((previous) => (previous === taskId ? null : previous));
  };

  const toggleManualWorkflowRole = (role: WorkflowRole) => {
    setManualWorkflowRoles((previous) => {
      if (previous.includes(role)) {
        if (previous.length === 1) {
          return previous;
        }
        return previous.filter((item) => item !== role);
      }
      return [...previous, role];
    });
  };

  const moveTaskBetweenBoardColumns = async (taskId: string, nextStatus: TaskStatus) => {
    const task = taskItems.find((item) => item.id === taskId);
    if (!task || task.status === nextStatus) return;

    upsertTaskItems([
      {
        ...task,
        status: nextStatus,
        updatedAt: new Date().toISOString(),
      },
    ]);

      appendProcessStep({
        id: `proc-move-${taskId}-${nextStatus}-${Date.now()}`,
        label: "Обновление Kanban",
        detail: `${task.title} перемещена в колонку ${statusMeta[nextStatus]?.label ?? nextStatus}.`,
        time: formatProcessTime(),
        tone: nextStatus === "failed" ? "error" : nextStatus === "done" ? "ok" : "info",
        taskId,
      category: "task",
    });

    if (isMockMode) return;

    if (
      task.workflowMode === "manual" &&
      task.status === "review" &&
      (nextStatus === "done" || nextStatus === "failed")
    ) {
      await fetch("/api/agents/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId,
          officeId: activeOfficeId,
          roomKey: activeRoomKey,
          action: nextStatus === "failed" ? "reject" : "approve",
        }),
      });
      return;
    }

    let taskMoveQuery = supabase
      .from("tasks")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("id", taskId);
    if (activeOfficeId) {
      taskMoveQuery = taskMoveQuery.eq("office_id", activeOfficeId);
    }
    await taskMoveQuery;
  };

  const saveCurrentTeamAsTemplate = async (name: string, description: string) => {
    if (isTemplateSaving) return;
    if (!isMockMode && !activeOfficeId) {
      alert("Office context is still loading. Please try again in a moment.");
      return;
    }

    setIsTemplateSaving(true);
    try {
      if (isMockMode) {
        setTeamTemplates((previous) => [
          {
            id: `template-${Date.now()}`,
            name,
            description,
            rolesJson: agents
              .filter((agent) =>
                agent.role === "PM" ||
                agent.role === "Developer" ||
                agent.role === "QA" ||
                agent.role === "DevOps"
              )
              .map((agent) => ({
                roleKey: String(agent.role).toLowerCase(),
                displayName: agent.name,
                runtimeRole: agent.role as "PM" | "Developer" | "QA" | "DevOps",
                skills: [],
              })),
          },
          ...previous,
        ]);
        return;
      }

      const response = await fetch("/api/team-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          officeId: activeOfficeId,
          name,
          description,
        }),
      });
      const payload = (await response.json()) as { template?: DashboardTeamTemplate; error?: string };
      if (!response.ok || !payload.template) {
        throw new Error(payload.error ?? "template_save_failed");
      }

      setTeamTemplates((previous) => [payload.template!, ...previous]);
      appendProcessStep({
        id: `proc-template-save-${payload.template.id}`,
        label: "Пресет сохранен",
        detail: `${payload.template.name} теперь доступен для найма в другие офисы.`,
        time: formatProcessTime(),
        tone: "ok",
        category: "system",
      });
    } catch (error) {
      console.error(error);
      alert("Failed to save the current room as a reusable template.");
    } finally {
      setIsTemplateSaving(false);
    }
  };

  const hireTeamTemplate = async (templateId: string) => {
    if (isHiringTemplateId) return;
    if (!isMockMode && !activeOfficeId) {
      alert("Office context is still loading. Please try again in a moment.");
      return;
    }

    setIsHiringTemplateId(templateId);
    try {
      if (isMockMode) {
        const template = teamTemplates.find((item) => item.id === templateId);
        if (!template) return;
        setAgents((previous) => {
          const next = [...previous];
          for (const role of template.rolesJson) {
            if (next.some((agent) => agent.role === role.runtimeRole)) continue;
            next.push({
              id: `mock-agent-${role.runtimeRole}-${Date.now()}`,
              name: role.displayName,
              role: role.runtimeRole,
              is_active: false,
            });
          }
          return next;
        });
        return;
      }

      const response = await fetch("/api/team-templates/hire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          officeId: activeOfficeId,
          templateId,
        }),
      });
      const payload = (await response.json()) as {
        success?: boolean;
        templateName?: string;
        createdAgents?: number;
        error?: string;
      };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? "template_hire_failed");
      }

      appendProcessStep({
        id: `proc-template-hire-${templateId}-${Date.now()}`,
        label: "Пресет нанят",
        detail: `${payload.templateName ?? "Пресет"} подключен к ${activeOfficeName}. Новых агентов: ${payload.createdAgents ?? 0}.`,
        time: formatProcessTime(),
        tone: "ok",
        category: "system",
      });
    } catch (error) {
      console.error(error);
      alert("Failed to hire the selected template into this office.");
    } finally {
      setIsHiringTemplateId(null);
    }
  };

  const buildProcessStepFromEvent = (eventRow: TeamEventRow): ProcessStep | null => {
    const payload = eventRow.payload ?? {};
    const message = extractEventMessage(payload);
    const taskId = normalizeTaskIdValue(payload.taskId);
    const stage = typeof payload.stage === "string" ? payload.stage : null;
    const nextStage = typeof payload.nextStage === "string" ? payload.nextStage : null;
    const sender = eventRow.sender_name ?? eventRow.sender_role ?? "Система";
    const shortTaskId = taskId ? ` · Task ${taskId.slice(0, 8)}` : "";
    const time = formatProcessTime(eventRow.created_at);
    const category = detectActivityCategory(message ?? eventRow.event_name, eventRow.sender_role, eventRow.scope, eventRow.event_name);

    if (eventRow.event_name === "workflow.approval_requested") {
      return {
        id: `proc-${eventRow.id}`,
        label: "Ожидание подтверждения",
        detail: message ?? `PM запросил подтверждение запуска${shortTaskId}.`,
        time,
        tone: "warn",
        taskId,
        category,
      };
    }

    if (eventRow.event_name === "workflow.execution_queued") {
      return {
        id: `proc-${eventRow.id}`,
        label: "Task в очереди",
        detail: `Запуск поставлен в очередь${shortTaskId}.`,
        time,
        tone: "run",
        taskId,
        category,
      };
    }

    if (eventRow.event_name === "task.execution_started") {
      return {
        id: `proc-${eventRow.id}`,
        label: "Выполнение начато",
        detail: `${sender} начал выполнение${shortTaskId}.`,
        time,
        tone: "run",
        taskId,
        category,
      };
    }

    if (eventRow.event_name === "task.execution_completed") {
      return {
        id: `proc-${eventRow.id}`,
        label: "Выполнение завершено",
        detail: `${sender} завершил задачу${shortTaskId}.`,
        time,
        tone: "ok",
        taskId,
        category,
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
        taskId,
        category,
      };
    }

    if (eventRow.event_name === "workflow.stage_started") {
      return {
        id: `proc-${eventRow.id}`,
        label: `Этап ${stage ?? "?"} начат`,
        detail: `${sender} приступил к этапу${shortTaskId}.`,
        time,
        tone: "run",
        taskId,
        category,
      };
    }

    if (eventRow.event_name === "workflow.stage_completed") {
      return {
        id: `proc-${eventRow.id}`,
        label: `Этап ${stage ?? "?"} завершен`,
        detail: nextStage ? `Следующий этап: ${nextStage}${shortTaskId}.` : `${sender} завершил этап${shortTaskId}.`,
        time,
        tone: "ok",
        taskId,
        category,
      };
    }

    if (eventRow.event_name === "chat.agent_response" && message) {
      return {
        id: `proc-${eventRow.id}`,
        label: `Комментарий ИИ: ${sender}`,
        detail: message.slice(0, 160),
        time,
        tone: "info",
        taskId,
        category,
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
    const contextTaskId = selectedTaskId ?? pendingTaskId ?? approvalDraft?.taskId ?? null;
    appendChatMessage({
      id: makeId(),
      sender: "agent",
      role: coordinatorRole,
      coordinator: coordinatorRole,
      agentName: coordinatorRole,
      scope: "system",
      targetRole: operationsRole,
      content,
      createdAt: nowIso,
      taskId: contextTaskId,
    });
    appendProcessStep({
      id: `proc-consult-${Date.now()}`,
      label: "Комментарий ИИ: PM",
      detail: content.slice(0, 160),
      time: formatProcessTime(nowIso),
      tone: "info",
      taskId: contextTaskId,
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
    setChatTargetRole(operationsRole);
    setChatInput(command);
    window.requestAnimationFrame(() => {
      chatInputRef.current?.focus();
    });
  };

  const selectTaskContext = (taskId: string | null) => {
    setSelectedTaskId(taskId);
    if (taskId) {
      setChatTimelineMode("selected");
    }
  };

  const deleteTaskFromDashboard = async (task: TaskItem) => {
    if (isTaskDeleting) return;

    const isActiveTask =
      pendingTaskId === task.id ||
      task.status === "in_progress" ||
      task.status === "review" ||
      task.status === "waiting_approval";

    setIsTaskDeleting(task.id);
    try {
      if (isMockMode) {
        if (isActiveTask) {
          setRoomMode("discussion");
          setTaskStatus("pending");
          setPendingTaskId(null);
          setApprovalDraft(null);
        }
        removeTaskFromDashboard(task.id);
        appendProcessStep({
          id: `proc-task-remove-${task.id}-${Date.now()}`,
          label: isActiveTask ? "Задача сброшена" : "Задача скрыта",
          detail: `${task.title} убрана из рабочего списка.`,
          time: formatProcessTime(),
          tone: isActiveTask ? "warn" : "info",
          taskId: task.id,
          category: "task",
        });
        return;
      }

      const metadataPatch = {
        hidden: true,
        hiddenAt: new Date().toISOString(),
        hiddenFromDashboard: true,
      };

      if (isActiveTask) {
        await supabase
          .from("room_state")
          .update({
            mode: "discussion",
            task_status: "pending",
            pending_task_id: null,
            updated_at: new Date().toISOString(),
          })
          .eq("room_key", activeRoomKey);

        let activeTaskQuery = supabase
          .from("tasks")
          .update({
            status: "failed",
            metadata: {
              reason: "Сброшена из dashboard",
              ...metadataPatch,
            },
            updated_at: new Date().toISOString(),
          });
        if (activeOfficeId) {
          activeTaskQuery = activeTaskQuery.eq("office_id", activeOfficeId);
        }
        await activeTaskQuery.eq("id", task.id);

        setRoomMode("discussion");
        setTaskStatus("pending");
        setPendingTaskId(null);
        setApprovalDraft(null);
      } else {
        let hiddenTaskQuery = supabase
          .from("tasks")
          .update({
            metadata: metadataPatch,
            updated_at: new Date().toISOString(),
          });
        if (activeOfficeId) {
          hiddenTaskQuery = hiddenTaskQuery.eq("office_id", activeOfficeId);
        }
        await hiddenTaskQuery.eq("id", task.id);
      }

      removeTaskFromDashboard(task.id);
      appendProcessStep({
        id: `proc-task-hide-${task.id}-${Date.now()}`,
        label: isActiveTask ? "Задача сброшена" : "Задача убрана",
        detail: `${task.title} больше не показывается в dashboard.`,
        time: formatProcessTime(),
        tone: isActiveTask ? "warn" : "info",
        taskId: task.id,
        category: "task",
      });
    } catch (error) {
      console.error(error);
      alert("Не удалось изменить состояние задачи в dashboard.");
    } finally {
      setIsTaskDeleting(null);
    }
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
    if (targetRole !== coordinatorRole && targetRole !== "All" && targetRole !== "Auto") {
      setInteractionTargetRole(targetRole);
      window.setTimeout(() => setInteractionTargetRole(null), 3200);
    }
  };

  /* в”Ђв”Ђв”Ђ Create task в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
  const createTask = async (e: FormEvent) => {
    e.preventDefault();
    const normalizedInput = taskInput.trim();
    const normalizedWorkflowRoles =
      taskWorkflowMode === "manual" ? manualWorkflowRoles : [];
    const workflowDependencies = normalizedWorkflowRoles
      .map((role, index) => ({
        from: role,
        to: normalizedWorkflowRoles[index + 1] ?? null,
      }))
      .filter((edge) => Boolean(edge.to));
    if (!normalizedInput || isRunning) return;
    if (!isMockMode && !activeOfficeId) {
      alert("Office context is still loading. Please try again in a moment.");
      return;
    }
    setIsRunning(true);
    try {
      if (isMockMode) {
        const nowIso = new Date().toISOString();
        const draft: ApprovalDraft = {
          taskId: `mock-${Date.now()}`,
          input: normalizedInput,
          targetRole: taskTargetRole,
          workflowMode: taskWorkflowMode,
          manualWorkflowRoles: normalizedWorkflowRoles,
        };
        setRoomMode("approval");
        setTaskStatus("waiting_approval");
        setPendingTaskId(draft.taskId);
        setApprovalDraft(draft);
        upsertTaskItems([
          {
            id: draft.taskId,
            title: buildTaskTitle(normalizedInput, draft.taskId),
            description: normalizedInput,
            status: "waiting_approval",
            targetRole: taskTargetRole,
            workflowMode: taskWorkflowMode,
            manualWorkflowRoles: normalizedWorkflowRoles,
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "local",
          },
        ]);
        setSelectedTaskId(draft.taskId);
        setChatTimelineMode("selected");
        appendChatMessage({
          id: makeId(),
          sender: "agent",
          role: "PM",
          agentName: "PM",
          coordinator: "PM",
          scope: "system",
          targetRole: taskTargetRole,
          content: `PM: задача принята (${getRoleTargetLabel(taskTargetRole)}). Подтвердите запуск, чтобы перейти к выполнению.`,
          createdAt: nowIso,
          taskId: draft.taskId,
          category: "task",
        });
        appendProcessStep({
          id: `proc-task-mock-${draft.taskId}`,
          label: "Task создан (demo)",
          detail: `${getRoleTargetLabel(taskTargetRole)} · ${normalizedInput.slice(0, 140)}`,
          time: formatProcessTime(nowIso),
          tone: "warn",
          taskId: draft.taskId,
          category: "task",
        });
        activateRoleAnimation("PM", taskTargetRole);
        setTaskInput("");
        setTaskWorkflowMode("autonomous");
        setManualWorkflowRoles([]);
        return;
      }

      setTaskStatus("pending");

      const { data: task, error } = await supabase
        .from("tasks")
          .insert({
            title: "Pixel Office CIC task",
            description: normalizedInput,
            status: "pending",
            office_id: activeOfficeId,
            workflow_mode: taskWorkflowMode,
            manual_workflow_roles: normalizedWorkflowRoles,
            dependencies: workflowDependencies,
            metadata: {
              targetRole: taskTargetRole,
              initiatedBy: "dashboard",
              approved: false,
              workflowMode: taskWorkflowMode,
              manualWorkflowRoles: normalizedWorkflowRoles,
              dependencies: workflowDependencies,
            },
          })
        .select()
        .single();

      if (error || !task?.id) throw error ?? new Error("task insert failed");
      const draft: ApprovalDraft = {
        taskId: task.id as string,
        input: normalizedInput,
        targetRole: taskTargetRole,
        workflowMode: taskWorkflowMode,
        manualWorkflowRoles: normalizedWorkflowRoles,
      };
      upsertTaskRecord(
        {
          ...(task as TaskRecord),
          status: "waiting_approval",
          description: normalizedInput,
            metadata: {
              ...((task as TaskRecord).metadata ?? {}),
              targetRole: taskTargetRole,
              workflowMode: taskWorkflowMode,
              manualWorkflowRoles: normalizedWorkflowRoles,
            },
            workflow_mode: taskWorkflowMode,
            manual_workflow_roles: normalizedWorkflowRoles,
          },
          "database"
        );
      setApprovalDraft(draft);
      setPendingTaskId(draft.taskId);
      setSelectedTaskId(draft.taskId);
      setChatTimelineMode("selected");
      setRoomMode("approval");
      setTaskStatus("waiting_approval");
      appendProcessStep({
        id: `proc-task-${draft.taskId}`,
        label: "Task зарегистрирован",
        detail: `${getRoleTargetLabel(taskTargetRole)} · ${normalizedInput.slice(0, 140)}`,
        time: formatProcessTime(),
        tone: "warn",
        taskId: draft.taskId,
        category: "task",
      });

      const preflightResponse = await fetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: task.id,
          input: normalizedInput,
          targetRole: taskTargetRole,
          approved: false,
          roomKey: activeRoomKey,
          officeId: activeOfficeId,
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
        content: `PM: задача зарегистрирована для ${getRoleTargetLabel(taskTargetRole)}. Подтвердите запуск в панели подтверждения.`,
        taskId: draft.taskId,
        category: "task",
      });
      activateRoleAnimation("PM", taskTargetRole);
      setTaskInput("");
      setTaskWorkflowMode("autonomous");
      setManualWorkflowRoles([]);
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
        upsertTaskItems([
          {
            id: approvalDraft.taskId,
            title: buildTaskTitle(approvalDraft.input, approvalDraft.taskId),
            description: approvalDraft.input,
            status: "in_progress",
            targetRole: approvalDraft.targetRole,
            createdAt: nowIso,
            updatedAt: nowIso,
            source: "local",
          },
        ]);
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
          taskId: approvalDraft.taskId,
          category: "task",
        });
        appendProcessStep({
          id: `proc-approve-mock-${approvalDraft.taskId}`,
          label: "Подтверждение получено",
          detail: `Запуск для ${getRoleTargetLabel(approvalDraft.targetRole)} подтвержден.`,
          time: formatProcessTime(nowIso),
          tone: "run",
          taskId: approvalDraft.taskId,
          category: "task",
        });
        activateRoleAnimation("PM", approvalDraft.targetRole);
        setApprovalDraft(null);
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
          roomKey: activeRoomKey,
          officeId: activeOfficeId,
        }),
      });
      if (!response.ok) throw new Error("approved run request failed");

      setRoomMode("execution");
      setTaskStatus("in_progress");
      upsertTaskItems([
        {
          id: approvalDraft.taskId,
          title: buildTaskTitle(approvalDraft.input, approvalDraft.taskId),
          description: approvalDraft.input,
          status: "in_progress",
          targetRole: approvalDraft.targetRole,
          createdAt: null,
          updatedAt: new Date().toISOString(),
          source: "database",
        },
      ]);
      appendProcessStep({
        id: `proc-approve-${approvalDraft.taskId}`,
        label: "Подтверждение получено",
        detail: `Task ${approvalDraft.taskId.slice(0, 8)} запущен.`,
        time: formatProcessTime(),
        tone: "run",
        taskId: approvalDraft.taskId,
        category: "task",
      });
      appendChatMessage({
        id: makeId(),
        sender: "agent",
        role: "PM",
        agentName: "PM",
        coordinator: "PM",
        scope: "system",
        targetRole: approvalDraft.targetRole,
        content: `PM: запуск подтвержден. Выполнение начато для ${getRoleTargetLabel(approvalDraft.targetRole)}.`,
        taskId: approvalDraft.taskId,
        category: "task",
      });
      activateRoleAnimation("PM", approvalDraft.targetRole);
      setApprovalDraft(null);
    } catch (error) {
      console.error(error);
      alert("Не удалось запустить задачу после подтверждения.");
    } finally {
      setIsRunning(false);
      setIsRunning(false);
    }
  };

  const cancelTask = async () => {
    if (!isMockMode && pendingTaskId) {
      let cancelTaskQuery = supabase
        .from("tasks")
        .update({ status: "failed", metadata: { reason: "Отменена пользователем" } })
        .eq("id", pendingTaskId);
      if (activeOfficeId) {
        cancelTaskQuery = cancelTaskQuery.eq("office_id", activeOfficeId);
      }
      await cancelTaskQuery;
      await supabase
        .from("room_state")
        .update({ task_status: "pending", pending_task_id: null })
        .eq("room_key", activeRoomKey);
    }
    setRoomMode("discussion");
    setTaskStatus("pending");
    setPendingTaskId(null);
    setApprovalDraft(null);
    setCurrentAgentThought(null);
    appendProcessStep({
      id: `proc-cancel-${Date.now()}`,
      label: "Задача отменена",
      detail: "Пользователь принудительно отменил выполнение задачи.",
      time: formatProcessTime(),
      tone: "error",
      taskId: pendingTaskId,
      category: "task",
    });
    appendChatMessage({
      id: makeId(),
      sender: "agent",
      role: "PM",
      agentName: "Система",
      coordinator: "PM",
      scope: "system",
      content: "Система: задача была отменена пользователем.",
      taskId: pendingTaskId,
      category: "system",
    });
    if (pendingTaskId) {
      upsertTaskItems([
        {
          id: pendingTaskId,
          title: buildTaskTitle(approvalDraft?.input ?? selectedTask?.description ?? "", pendingTaskId),
          description: approvalDraft?.input ?? selectedTask?.description ?? "",
          status: "failed",
          targetRole: approvalDraft?.targetRole ?? selectedTask?.targetRole ?? null,
          createdAt: selectedTask?.createdAt ?? null,
          updatedAt: new Date().toISOString(),
          source: selectedTask?.source ?? "database",
        },
      ]);
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
        .eq("room_key", activeRoomKey);
    }
    setRoomMode("discussion");
    setTaskStatus("pending");
    appendProcessStep({
      id: `proc-discussion-${approvalDraft.taskId}-${Date.now()}`,
      label: "Возврат в обсуждение",
      detail: `Task ${approvalDraft.taskId.slice(0, 8)} оставлен без запуска.`,
      time: formatProcessTime(),
      tone: "info",
      taskId: approvalDraft.taskId,
      category: "task",
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
      taskId: approvalDraft.taskId,
      category: "task",
    });
    upsertTaskItems([
      {
        id: approvalDraft.taskId,
        title: buildTaskTitle(approvalDraft.input, approvalDraft.taskId),
        description: approvalDraft.input,
        status: "pending",
        targetRole: approvalDraft.targetRole,
        createdAt: selectedTask?.createdAt ?? null,
        updatedAt: new Date().toISOString(),
        source: selectedTask?.source ?? "database",
      },
    ]);
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
    const contextTaskId = selectedTaskId ?? pendingTaskId ?? approvalDraft?.taskId ?? null;
    const contextTaskSummary =
      selectedTask?.description ??
      approvalDraft?.input ??
      null;

    if (!isMockMode && !activeOfficeId) {
      alert("Office context is still loading. Please try again in a moment.");
      return;
    }

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
      taskId: contextTaskId,
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
          roomKey: activeRoomKey,
          officeId: activeOfficeId,
          senderName: "Администратор CIC",
          clientMessageId,
          selectedTaskId: contextTaskId,
          selectedTaskSummary: contextTaskSummary,
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
        taskId?: string | null;
      };
      const responseClientMessageId = data.clientMessageId ?? clientMessageId;
      const responseTaskId = data.taskId ?? contextTaskId;

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
        taskId: responseTaskId,
      });
      appendProcessStep({
        id: `proc-chat-${responseClientMessageId}`,
        label: `Комментарий ИИ: ${data.agentName ?? data.role ?? "Агент"}`,
        detail: (data.message ?? "Ответ получен").slice(0, 160),
        time: formatProcessTime(),
        tone: "info",
        taskId: responseTaskId,
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
        taskId: contextTaskId,
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
    setChatTargetRole(operationsRole);
    await sendMessageToAgents(command, operationsRole);
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
    if (!activeOfficeId) return;

    const fetchTokenStats = async () => {
      const { data: logsData } = await supabase
        .from("token_logs")
        .select("agent_id, prompt_tokens, completion_tokens")
        .eq("office_id", activeOfficeId);

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
        .eq("room_key", activeRoomKey);

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

    const refreshAgentRuntimeState = async () => {
      const { data: runtimeRows } = await supabase
        .from("agent_states")
        .select("agent_id, status, current_action, current_skill, current_target_x, current_target_y, metadata")
        .eq("office_id", activeOfficeId);

      if (!runtimeRows) {
        setAgentRuntimeStateById({});
        return;
      }

      const nextRuntimeState = Object.fromEntries(
        (runtimeRows as AgentRuntimeStateRow[])
          .filter((row) => typeof row.agent_id === "string" && row.agent_id.length > 0)
          .map((row) => [row.agent_id, row])
      ) as Record<string, AgentRuntimeStateRow>;

      setAgentRuntimeStateById(nextRuntimeState);
    };

    const refreshTaskList = async () => {
      const { data: tasksData } = await supabase
        .from("tasks")
        .select("id, description, status, metadata, workflow_mode, manual_workflow_roles, created_at, updated_at")
        .eq("office_id", activeOfficeId)
        .order("updated_at", { ascending: false })
        .limit(TASK_CARD_LIMIT);

      if (!tasksData) return;

      const nextItems = (tasksData as TaskRecord[])
        .map((task) => toTaskItem(task))
        .filter((item): item is TaskItem => Boolean(item));

      setTaskItems(nextItems);
      setSelectedTaskId((previous) => {
        if (previous && nextItems.some((item) => item.id === previous)) return previous;
        if (pendingTaskIdRef.current && nextItems.some((item) => item.id === pendingTaskIdRef.current)) {
          return pendingTaskIdRef.current;
        }
        return nextItems[0]?.id ?? null;
      });
    };

    const handleTeamEvent = (eventRow: TeamEventRow) => {
      if (!eventRow?.id || seenEventIdsRef.current.has(eventRow.id)) return;
      seenEventIdsRef.current.add(eventRow.id);

      const payload = eventRow.payload ?? {};
      const message = extractEventMessage(payload);
      const clientMessageId = extractClientMessageId(payload);
      const payloadTaskId = normalizeTaskIdValue(payload.taskId);
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
          taskId: payloadTaskId,
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
          taskId: payloadTaskId,
        });
        activateRoleAnimation(payloadRole, eventRow.target_role ?? undefined);
      }

      if (eventRow.event_name === "workflow.approval_requested" && message) {
        setRoomMode("approval");
        setTaskStatus("waiting_approval");
        if (payloadTaskId) {
          setPendingTaskId(payloadTaskId);
          setSelectedTaskId((previous) => previous ?? payloadTaskId);
        }
      }

      if (eventRow.event_name === "workflow.execution_queued") {
        setRoomMode("execution");
        setTaskStatus("in_progress");
        if (payloadTaskId) {
          setPendingTaskId(payloadTaskId);
          setSelectedTaskId((previous) => previous ?? payloadTaskId);
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
          taskId: payloadTaskId,
          category: "task",
        });
        if (payloadTaskId) {
          upsertTaskItems([
            {
              id: payloadTaskId,
              title: buildTaskTitle(message, payloadTaskId),
              description: message ?? selectedTask?.description ?? "",
              status: "in_progress",
              targetRole: normalizeRoleTarget(eventRow.target_role),
              createdAt: null,
              updatedAt: eventRow.created_at,
              source: "database",
            },
          ]);
        }
      }

      if (eventRow.event_name === "task.execution_started") {
        setRoomMode("execution");
        setTaskStatus("in_progress");
        if (payloadTaskId) {
          setPendingTaskId(payloadTaskId);
          setSelectedTaskId((previous) => previous ?? payloadTaskId);
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
          taskId: payloadTaskId,
          category: "task",
        });
        if (payloadTaskId) {
          upsertTaskItems([
            {
              id: payloadTaskId,
              title: buildTaskTitle(selectedTask?.description ?? message ?? "", payloadTaskId),
              description: selectedTask?.description ?? message ?? "",
              status: "in_progress",
              targetRole: normalizeRoleTarget(eventRow.target_role),
              createdAt: selectedTask?.createdAt ?? null,
              updatedAt: eventRow.created_at,
              source: "database",
            },
          ]);
        }
      }

      if (eventRow.event_name === "task.execution_completed") {
        setRoomMode("discussion");
        setTaskStatus("done");
        setPendingTaskId(null);
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
          taskId: payloadTaskId,
          category: "task",
        });
        if (payloadTaskId) {
          upsertTaskItems([
            {
              id: payloadTaskId,
              title: buildTaskTitle(selectedTask?.description ?? message ?? "", payloadTaskId),
              description: selectedTask?.description ?? message ?? "",
              status: "done",
              targetRole: normalizeRoleTarget(eventRow.target_role),
              createdAt: selectedTask?.createdAt ?? null,
              updatedAt: eventRow.created_at,
              source: "database",
            },
          ]);
        }
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
          taskId: payloadTaskId,
          category: "task",
        });
        if (payloadTaskId) {
          upsertTaskItems([
            {
              id: payloadTaskId,
              title: buildTaskTitle(selectedTask?.description ?? reason ?? "", payloadTaskId),
              description: selectedTask?.description ?? reason ?? "",
              status: "failed",
              targetRole: normalizeRoleTarget(eventRow.target_role),
              createdAt: selectedTask?.createdAt ?? null,
              updatedAt: eventRow.created_at,
              source: "database",
            },
          ]);
        }
      }

      if (eventRow.event_name.startsWith("task.execution_") || eventRow.event_name.startsWith("workflow.")) {
        const shortMessage = message
          ? message.slice(0, 90)
          : `${eventRow.event_name} (${eventRow.sender_role ?? "system"})`;
        appendEventFeed(`[${scopeMeta[eventRow.scope]}] ${shortMessage}`);
      }
    };

    const fetchData = async () => {
      const { data: agentsData } = await supabase.from("agents").select("*").eq("office_id", activeOfficeId);
      if (agentsData) {
        const hydratedAgents = await hydrateAgentsWithSkills(agentsData);
        setAgents(hydratedAgents);
      }

      const { data: roomStateData } = await supabase
        .from("room_state")
        .select("room_key, mode, task_status, active_role, pending_task_id, revision, metadata")
        .eq("room_key", activeRoomKey)
        .maybeSingle();

      if (roomStateData) {
        const roomState = roomStateData as RoomStateRow;
        setRoomMode(roomState.mode);
        setTaskStatus(roomState.task_status);
        setPendingTaskId(roomState.pending_task_id);
        setRoomRevision(Number(roomState.revision ?? 0));
        setCurrentAgentThought(roomState.metadata?.currentAction ?? null);
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
        .eq("room_key", activeRoomKey)
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
      await refreshTaskList();
      await refreshPlayerState();
      await refreshAgentRuntimeState();
    };

    const refreshRuntimeSnapshot = async () => {
      const { data: agentsData } = await supabase.from("agents").select("*").eq("office_id", activeOfficeId);
      if (agentsData) {
        const hydratedAgents = await hydrateAgentsWithSkills(agentsData);
        setAgents(hydratedAgents);
      }

      const { data: roomStateData } = await supabase
        .from("room_state")
        .select("room_key, mode, task_status, active_role, pending_task_id, revision, metadata")
        .eq("room_key", activeRoomKey)
        .maybeSingle();

      if (roomStateData) {
        const roomState = roomStateData as RoomStateRow;
        setRoomMode(roomState.mode);
        setTaskStatus(roomState.task_status);
        setPendingTaskId(roomState.pending_task_id);
        setRoomRevision(Number(roomState.revision ?? 0));
        setCurrentAgentThought(roomState.metadata?.currentAction ?? null);
        if (roomState.active_role) {
          setAgents((previous) =>
            previous.map((agent) => ({
              ...agent,
              is_active: agent.role === roomState.active_role,
            }))
          );
        }
      }

      await fetchTokenStats();
      await refreshTaskList();
      await refreshPlayerState();
      await refreshAgentRuntimeState();
    };

    const pollTeamEvents = async () => {
      const { data: latestEvents } = await supabase
        .from("team_events")
        .select("id, event_name, scope, sender_role, payload, target_role, room_key, sender_name, created_at")
        .eq("room_key", activeRoomKey)
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

    const agentsChannel = supabase.channel(`agents-realtime-${activeRoomKey}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agents", filter: `office_id=eq.${activeOfficeId}` },
        (payload) => {
        setAgents((prev) => {
          if (payload.eventType === "INSERT") {
            const nextRow = payload.new as Agent;
            return [
              ...prev,
              {
                ...nextRow,
                skills: parseStringList((payload.new as { skills?: unknown }).skills),
              },
            ];
          }
          if (payload.eventType === "DELETE") return prev.filter((a) => a.id !== (payload.old as Agent).id);
          return prev.map((a) =>
            a.id === (payload.new as Agent).id
              ? {
                  ...(payload.new as Agent),
                  skills:
                    parseStringList((payload.new as { skills?: unknown }).skills).length > 0
                      ? parseStringList((payload.new as { skills?: unknown }).skills)
                      : a.skills ?? [],
                }
              : a
          );
        });
      }
      )
      .subscribe();

    const tasksChannel = supabase.channel(`tasks-realtime-${activeRoomKey}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks", filter: `office_id=eq.${activeOfficeId}` },
        (payload) => {
        if (payload.eventType === "DELETE") {
          const deletedTaskId = normalizeTaskIdValue((payload.old as TaskRecord | null)?.id ?? null);
          if (deletedTaskId) {
            removeTaskFromDashboard(deletedTaskId);
          }
          return;
        }
        const taskRow = payload.new as TaskRecord;
        upsertTaskRecord(taskRow, "database");
        if (taskRow?.id !== pendingTaskIdRef.current) return;
        const nextStatus = taskRow?.status;
        if (nextStatus) {
          setTaskStatus(nextStatus);
          if (nextStatus === "done" || nextStatus === "failed") {
            setApprovalDraft(null);
            setPendingTaskId(null);
          }
        }
      }
      )
      .subscribe();

    const tokenLogsChannel = supabase
      .channel(`token-logs-realtime-${activeRoomKey}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "token_logs", filter: `office_id=eq.${activeOfficeId}` }, () => {
        fetchTokenStats();
      })
      .subscribe();

    const roomStateChannel = supabase
      .channel(`room-state-realtime-${activeRoomKey}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_state", filter: `room_key=eq.${activeRoomKey}` },
        (payload) => {
          if (payload.eventType === "DELETE") return;
          const room = payload.new as RoomStateRow;
          if (!room) return;
          setRoomMode(room.mode);
          setTaskStatus(room.task_status);
          setPendingTaskId(room.pending_task_id);
          if (room.pending_task_id) {
            setSelectedTaskId((previous) => previous ?? room.pending_task_id);
          }
          setRoomRevision(Number(room.revision ?? 0));
          setCurrentAgentThought(room.metadata?.currentAction ?? null);
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
      .channel(`player-state-realtime-${activeRoomKey}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "player_state", filter: `room_key=eq.${activeRoomKey}` },
        () => {
          refreshPlayerState();
        }
      )
      .subscribe();

    const agentStatesChannel = supabase
      .channel(`agent-states-realtime-${activeRoomKey}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agent_states", filter: `office_id=eq.${activeOfficeId}` },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const deletedAgentId = String((payload.old as AgentRuntimeStateRow | null)?.agent_id ?? "");
            if (!deletedAgentId) return;
            setAgentRuntimeStateById((previous) => {
              const next = { ...previous };
              delete next[deletedAgentId];
              return next;
            });
            return;
          }

          const runtimeRow = payload.new as AgentRuntimeStateRow;
          if (!runtimeRow?.agent_id) return;
          setAgentRuntimeStateById((previous) => ({
            ...previous,
            [runtimeRow.agent_id]: runtimeRow,
          }));
        }
      )
      .subscribe();

    const teamEventsChannel = supabase
      .channel(`team-events-realtime-${activeRoomKey}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "team_events", filter: `room_key=eq.${activeRoomKey}` },
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
      supabase.removeChannel(agentStatesChannel);
      supabase.removeChannel(teamEventsChannel);
    };
  }, [activeOfficeId, activeRoomKey, mounted]);

  if (!mounted) return <div className="min-h-screen" style={{ background: "#0d0308" }} />;

  /* в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
  return (
    <main className="relative min-h-screen p-3 text-white lg:p-5"
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

      <div className="relative z-10 max-w-[1540px] mx-auto flex min-h-screen flex-col gap-4">

        <div className="flex justify-end -mb-2 pr-2 z-20">
          <button
            type="button"
            onClick={() => setIsDashboardCollapsed((p) => !p)}
            className="text-[10px] uppercase tracking-[0.16em] px-3 py-1 rounded-md transition-colors"
            style={{
              background: "rgba(194,21,90,0.14)",
              border: "1px solid rgba(194,21,90,0.30)",
              color: "rgba(255,220,228,0.7)",
            }}
          >
            {isDashboardCollapsed ? "Развернуть дашборд ▼" : "Свернуть дашборд ▲"}
          </button>
        </div>

        {!isDashboardCollapsed && (
          <>
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
                <div
                  className="px-3 py-2 rounded-lg"
                  style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(194,21,90,0.22)" }}
                >
                  <div className="text-[9px] text-rose-100/60 uppercase tracking-widest">Office</div>
                  {availableOffices.length > 1 ? (
                    <select
                      value={activeOfficeId ?? ""}
                      onChange={(event) => {
                        const nextOffice = availableOffices.find((office) => office.id === event.target.value);
                        setActiveOfficeId(nextOffice?.id ?? null);
                        setActiveOfficeName(nextOffice?.name ?? "Digital Pixel Office");
                      }}
                      className="mt-1 min-w-[180px] rounded-md border px-2 py-1 text-xs"
                      style={{
                        background: "rgba(10,3,7,0.88)",
                        borderColor: "rgba(194,21,90,0.28)",
                        color: "rgba(255,235,240,0.92)",
                      }}
                    >
                      {availableOffices.map((office) => (
                        <option key={office.id} value={office.id}>
                          {office.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="text-sm font-semibold text-rose-50 mt-0.5">{activeOfficeName}</div>
                  )}
                </div>

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
                <div className="text-[10px] uppercase tracking-[0.2em] text-rose-100/55">
                  Task Dashboard
                </div>
                <div className="px-2 py-1 rounded-md text-[10px] uppercase tracking-[0.16em] text-rose-100/90"
                  style={{ background: "rgba(194,21,90,0.18)", border: "1px solid rgba(194,21,90,0.30)" }}>
                  Режим: {currentRoomMode.label}
                </div>
                <div className="px-2 py-1 rounded-md text-[10px] uppercase tracking-[0.16em] text-rose-100/90"
                  style={{ background: "rgba(194,21,90,0.10)", border: "1px solid rgba(194,21,90,0.24)" }}>
                  Статус: {currentStatus.label}
                </div>
                <div className="ml-auto text-[11px] text-rose-100/70">
                  {zoneHint}
                </div>
              </div>

              <div className="mt-3 grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)_360px]">
                <div
                  className="rounded-xl px-3 py-3 space-y-3"
                  style={{ background: "rgba(0,0,0,0.42)", border: "1px solid rgba(194,21,90,0.22)" }}
                >
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.18em] text-rose-100/55">
                      Рабочий контекст
                    </div>
                    <div className="mt-2 text-sm text-rose-50">
                      {selectedTask ? selectedTask.title : "Общий командный контекст"}
                    </div>
                    <div className="mt-1 text-xs text-rose-100/60">
                      {selectedTask
                        ? selectedTask.description || `Task ${formatTaskShortId(selectedTask.id)} без описания`
                        : "Выберите задачу, чтобы чат и лента показывали только связанный контекст."}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTaskId(null);
                        setChatTimelineMode("all");
                      }}
                      className="px-3 py-1.5 rounded-md text-[10px] uppercase tracking-[0.16em]"
                      style={{
                        background: !selectedTaskId ? "rgba(194,21,90,0.24)" : "rgba(194,21,90,0.10)",
                        border: "1px solid rgba(194,21,90,0.30)",
                        color: "rgba(255,220,228,0.92)",
                      }}
                    >
                      Общий поток
                    </button>
                    <button
                      type="button"
                      onClick={() => setChatTimelineMode((previous) => previous === "selected" ? "all" : "selected")}
                      disabled={!selectedTaskId}
                      className="px-3 py-1.5 rounded-md text-[10px] uppercase tracking-[0.16em] disabled:opacity-40"
                      style={{
                        background: chatTimelineMode === "selected" && selectedTaskId
                          ? "rgba(194,21,90,0.24)"
                          : "rgba(194,21,90,0.10)",
                        border: "1px solid rgba(194,21,90,0.30)",
                        color: "rgba(255,220,228,0.92)",
                      }}
                    >
                      Только по task
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg px-2.5 py-2" style={{ background: "rgba(8,2,6,0.6)", border: "1px solid rgba(194,21,90,0.16)" }}>
                      <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/50">Task ID</div>
                      <div className="mt-1 font-mono text-rose-50">{selectedTask ? formatTaskShortId(selectedTask.id) : "общий"}</div>
                    </div>
                    <div className="rounded-lg px-2.5 py-2" style={{ background: "rgba(8,2,6,0.6)", border: "1px solid rgba(194,21,90,0.16)" }}>
                      <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/50">Логи / чат</div>
                      <div className="mt-1 text-rose-50">{selectedTask ? `${selectedTaskStats.logs} / ${selectedTaskStats.messages}` : "весь поток"}</div>
                    </div>
                  </div>

                  <div className="rounded-lg px-2.5 py-2 text-xs"
                    style={{ background: "rgba(8,2,6,0.6)", border: "1px solid rgba(194,21,90,0.16)" }}>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/50">Логика</div>
                    <div className="mt-1 text-rose-100/78">
                      Активные task не удаляются жестко: dashboard мягко скрывает их или сбрасывает в безопасный статус, чтобы не ломать workflow.
                    </div>
                  </div>
                </div>

                <div
                  className="rounded-xl px-3 py-3"
                  style={{ background: "rgba(0,0,0,0.42)", border: "1px solid rgba(194,21,90,0.22)" }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-rose-100/55">
                        Список задач
                      </div>
                      <div className="mt-1 text-xs text-rose-100/65">
                        Выберите задачу, чтобы закрепить чат и логи за конкретным контекстом.
                      </div>
                    </div>
                    <div className="text-[11px] text-rose-100/60">
                      {taskItems.length} в списке
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {taskItems.length === 0 && (
                      <div className="rounded-lg px-3 py-4 text-sm text-rose-100/55"
                        style={{ background: "rgba(8,2,6,0.58)", border: "1px dashed rgba(194,21,90,0.24)" }}>
                        Пока нет сохраненных задач. Создайте task сверху, и он появится здесь.
                      </div>
                    )}

                    {taskItems.map((task) => {
                      const taskStatusMeta = statusMeta[task.status] ?? { label: task.status, color: "#9CA3AF" };
                      const stats = taskActivityStats[task.id] ?? { logs: 0, messages: 0 };
                      const isSelected = selectedTaskId === task.id;

                      return (
                        <div
                          key={task.id}
                          className="rounded-xl px-3 py-3"
                          style={{
                            background: isSelected ? "rgba(194,21,90,0.16)" : "rgba(8,2,6,0.58)",
                            border: isSelected
                              ? "1px solid rgba(244,114,182,0.45)"
                              : "1px solid rgba(194,21,90,0.18)",
                          }}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-rose-50 truncate">
                                {task.title}
                              </div>
                              <div className="mt-1 text-[11px] text-rose-100/60">
                                {task.description || `Task ${formatTaskShortId(task.id)}`}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-[10px] uppercase tracking-[0.16em]" style={{ color: taskStatusMeta.color }}>
                                {taskStatusMeta.label}
                              </div>
                              <div className="mt-1 text-[10px] text-rose-100/45 font-mono">
                                {formatTaskShortId(task.id)}
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.14em] text-rose-100/70">
                            <span className="px-2 py-1 rounded-md" style={{ background: "rgba(194,21,90,0.10)", border: "1px solid rgba(194,21,90,0.18)" }}>
                              {task.targetRole ? getRoleTargetLabel(task.targetRole) : "Без роли"}
                            </span>
                            <span className="px-2 py-1 rounded-md" style={{ background: "rgba(194,21,90,0.10)", border: "1px solid rgba(194,21,90,0.18)" }}>
                              логов {stats.logs}
                            </span>
                            <span className="px-2 py-1 rounded-md" style={{ background: "rgba(194,21,90,0.10)", border: "1px solid rgba(194,21,90,0.18)" }}>
                              сообщений {stats.messages}
                            </span>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => selectTaskContext(task.id)}
                              className="px-3 py-1.5 rounded-md text-[10px] uppercase tracking-[0.16em]"
                              style={{
                                background: isSelected ? "rgba(194,21,90,0.24)" : "rgba(194,21,90,0.10)",
                                border: "1px solid rgba(194,21,90,0.30)",
                                color: "rgba(255,220,228,0.92)",
                              }}
                            >
                              Контекст
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                selectTaskContext(task.id);
                                setChatTimelineMode("selected");
                              }}
                              className="px-3 py-1.5 rounded-md text-[10px] uppercase tracking-[0.16em]"
                              style={{
                                background: "rgba(194,21,90,0.10)",
                                border: "1px solid rgba(194,21,90,0.24)",
                                color: "rgba(255,220,228,0.85)",
                              }}
                            >
                              Чат
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                selectTaskContext(task.id);
                                setChatTimelineMode("selected");
                                setActivityFilter("task");
                              }}
                              className="px-3 py-1.5 rounded-md text-[10px] uppercase tracking-[0.16em]"
                              style={{
                                background: "rgba(194,21,90,0.10)",
                                border: "1px solid rgba(194,21,90,0.24)",
                                color: "rgba(255,220,228,0.85)",
                              }}
                            >
                              Логи
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteTaskFromDashboard(task)}
                              disabled={isTaskDeleting === task.id}
                              className="px-3 py-1.5 rounded-md text-[10px] uppercase tracking-[0.16em] disabled:opacity-45"
                              style={{
                                background: "rgba(127,29,29,0.35)",
                                border: "1px solid rgba(248,113,113,0.32)",
                                color: "#fecaca",
                              }}
                            >
                              {isTaskDeleting === task.id ? "Обновление..." : (pendingTaskId === task.id ? "Сбросить" : "Убрать")}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div
                  className="rounded-xl px-3 py-3"
                  style={{ background: "rgba(0,0,0,0.42)", border: "1px solid rgba(194,21,90,0.22)" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-rose-100/55">
                        Логи и этапы
                      </div>
                      <div className="mt-1 text-xs text-rose-100/65">
                        {selectedTask ? `Показываю активность по ${selectedTask.title}` : "Показываю общий поток по комнате"}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {ACTIVITY_FILTER_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setActivityFilter(option.value)}
                        className="px-2.5 py-1 rounded-md text-[10px] uppercase tracking-[0.16em]"
                        style={{
                          background: activityFilter === option.value ? "rgba(194,21,90,0.24)" : "rgba(194,21,90,0.10)",
                          border: "1px solid rgba(194,21,90,0.24)",
                          color: "rgba(255,220,228,0.9)",
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
                    {visibleProcessFeed.length === 0 && (
                      <div className="rounded-lg px-3 py-3 text-sm text-rose-100/55"
                        style={{ background: "rgba(8,2,6,0.58)", border: "1px dashed rgba(194,21,90,0.24)" }}>
                        Для выбранного контекста логов пока нет.
                      </div>
                    )}
                    {visibleProcessFeed.slice(0, 14).map((step) => {
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
              </div>
            </section>
          </>
        )}

        {/* в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ

        {/* в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ
            MAIN GRID: office | chat
        в•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђв•ђ */}
        <div className="grid flex-1 min-h-0 items-start gap-4 lg:grid-cols-3">
          {/* в”Ђв”Ђ Left column в”Ђв”Ђ */}
          <section
            className="flex min-h-0 flex-col gap-4 pr-1 lg:col-span-2"
            onMouseEnter={() => setActiveZone(activeView === "office" ? "office" : "task")}
          >
            <section
              className="flex min-h-[520px] flex-col rounded-xl p-3"
              style={{
                background: "rgba(8,2,6,0.78)",
                border: "1px solid rgba(194,21,90,0.26)",
              }}
            >
              <div className="mb-3 flex flex-wrap gap-2">
                {DASHBOARD_VIEW_OPTIONS.map((view) => (
                  <button
                    key={`left-${view.value}`}
                    type="button"
                    onClick={() => {
                      setActiveView(view.value);
                      setActiveZone(view.value === "office" ? "office" : "task");
                    }}
                    className="rounded-lg px-3 py-2 text-[10px] uppercase tracking-[0.16em]"
                    style={{
                      background:
                        activeView === view.value ? "rgba(194,21,90,0.24)" : "rgba(194,21,90,0.10)",
                      border: "1px solid rgba(194,21,90,0.30)",
                      color: "rgba(255,220,228,0.92)",
                    }}
                  >
                    {view.label}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1 pr-1">
                {activeView === "office" ? (
                  <div onMouseEnter={() => setActiveZone("office")}>
                    <OfficeHub
                      agents={agents}
                      taskStatus={taskStatus}
                      speakingAgentId={speakingAgentId}
                      interactionTargetRole={interactionTargetRole}
                      agentTokenUsage={agentTokenUsage}
                      agentRuntimeState={agentRuntimeStateById}
                      officeName={activeOfficeName}
                    />
                  </div>
                ) : (
                  <OfficeKanbanBoard
                    tasks={taskItems}
                    selectedTaskId={selectedTaskId}
                    onSelectTask={(taskId) => {
                      selectTaskContext(taskId);
                      setChatTimelineMode("selected");
                    }}
                    onMoveTask={moveTaskBetweenBoardColumns}
                  />
                )}
              </div>
            </section>

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
                {["Auto", "All", ...workflowRoleOptions].map((role) => (
                  <option key={role} value={role}>{getRoleTargetLabel(role)}</option>
                ))}
              </select>

              <select
                value={taskWorkflowMode}
                onChange={(event) => setTaskWorkflowMode(event.target.value as WorkflowMode)}
                className="bg-black/40 px-3 py-2.5 text-sm outline-none rounded-lg text-rose-100 cursor-pointer"
                style={{ border: "1px solid rgba(194,21,90,0.28)", minWidth: 170 }}
              >
                <option value="autonomous">CEO / Автономно</option>
                <option value="manual">Ручной граф</option>
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

              <div className="sm:basis-full w-full grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
                <div
                  className="rounded-lg px-3 py-2"
                  style={{
                    background: "rgba(0,0,0,0.34)",
                    border: "1px solid rgba(194,21,90,0.20)",
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-rose-100/55">
                      Workflow
                    </div>
                    <div className="text-[11px] text-rose-100/72">
                      {workflowModeLabel[taskWorkflowMode]}
                    </div>
                    {taskWorkflowMode === "manual" && (
                      <div className="text-[11px] text-rose-100/55">
                        {manualWorkflowPreview}
                      </div>
                    )}
                  </div>

                  {taskWorkflowMode === "manual" && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {workflowRoleOptions.map((role) => {
                        const selected = manualWorkflowRoles.includes(role);
                        return (
                          <button
                            key={role}
                            type="button"
                            onClick={() => toggleManualWorkflowRole(role)}
                            className="rounded-md px-2.5 py-1.5 text-[10px] uppercase tracking-[0.16em]"
                            style={{
                              background: selected ? "rgba(249,115,22,0.20)" : "rgba(194,21,90,0.10)",
                              border: selected
                                ? "1px solid rgba(249,115,22,0.38)"
                                : "1px solid rgba(194,21,90,0.24)",
                              color: "rgba(255,220,228,0.92)",
                            }}
                          >
                            {role}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div
                  className="rounded-lg px-3 py-2 text-xs"
                  style={{
                    background: "rgba(0,0,0,0.34)",
                    border: "1px solid rgba(194,21,90,0.20)",
                    color: "rgba(255,220,228,0.8)",
                  }}
                >
                  {taskWorkflowMode === "manual"
                    ? "Граф пойдет строго по вашей цепочке ролей."
                    : "PM/CEO сам разложит задачу и распределит роли."}
                </div>
              </div>
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
                    Задача для {getRoleTargetLabel(approvalDraft.targetRole)} ожидает подтверждения.
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

            <TeamTemplatesPanel
              officeName={activeOfficeName}
              templates={teamTemplates}
              isLoading={isTemplatesLoading}
              isHiringTemplateId={isHiringTemplateId}
              isSaving={isTemplateSaving}
              onHireTemplate={hireTeamTemplate}
              onSaveCurrentTeam={saveCurrentTeamAsTemplate}
            />
          </section>

          {/* в”Ђв”Ђ Right column вЂ” Chat в”Ђв”Ђ */}
          <aside
            className="chat-scroll flex min-h-[640px] flex-col overflow-y-auto rounded-xl border-l lg:sticky lg:top-0 lg:col-span-1 lg:h-screen"
            onMouseEnter={() => setActiveZone("chat")}
            style={{
              background: "rgba(8,2,6,0.92)",
              border: "1px solid rgba(194,21,90,0.32)",
              backdropFilter: "blur(20px)",
            }}
          >
            {/* Chat header */}
            <div
              className="shrink-0 px-4 py-3 flex items-start justify-between gap-3"
              style={{ borderBottom: "1px solid rgba(194,21,90,0.18)" }}
            >
              <div className="min-w-0">
                <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-rose-100">
                  Командный центр (чат)
                </h2>
                <p className="text-[11px] text-rose-100/55 mt-0.5">
                  {selectedTask
                    ? `Контекст закреплен за ${selectedTask.title}`
                    : "Scoped-сообщения: адресно, broadcast, системные уведомления"}
                </p>
                {agents.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {agents.map((agent) => {
                      const avatarLabel = (agent.name?.trim()?.[0] ?? agent.role?.trim()?.[0] ?? "?").toUpperCase();
                      return (
                        <div
                          key={`chat-agent-badge-${agent.id}`}
                          className="w-8 h-8 rounded-full bg-gray-200/10 border-2 border-rose-200/30 flex items-center justify-center text-xs cursor-pointer text-rose-50"
                          title={`${agent.name} (${agent.role})`}
                        >
                          {avatarLabel}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <div
                    className="px-2.5 py-1 rounded-md text-[10px] uppercase tracking-[0.16em]"
                    style={{
                      background: selectedTask ? "rgba(194,21,90,0.18)" : "rgba(194,21,90,0.10)",
                      border: "1px solid rgba(194,21,90,0.24)",
                      color: "rgba(255,220,228,0.88)",
                    }}
                  >
                    {selectedTask ? `Task ${formatTaskShortId(selectedTask.id)}` : "Общий поток"}
                  </div>
                  <button
                    type="button"
                    onClick={() => setChatTimelineMode((previous) => previous === "selected" ? "all" : "selected")}
                    disabled={!selectedTaskId}
                    className="px-2.5 py-1 rounded-md text-[10px] uppercase tracking-[0.16em] disabled:opacity-40"
                    style={{
                      background: chatTimelineMode === "selected" && selectedTaskId
                        ? "rgba(194,21,90,0.22)"
                        : "rgba(194,21,90,0.10)",
                      border: "1px solid rgba(194,21,90,0.24)",
                      color: "rgba(255,220,228,0.88)",
                    }}
                  >
                    {chatTimelineMode === "selected" && selectedTaskId ? "Показывать всё" : "Только по task"}
                  </button>
                </div>
              </div>
              {/* Live indicator */}
              <div className="flex items-center gap-1.5 text-[10px] text-rose-100/60 mt-0.5">
                <IconDot color="#E8001E" />
                Live
              </div>
            </div>

            <form
              id="chat-task-form"
              onSubmit={createTask}
              className="shrink-0 space-y-2 px-4 py-2.5"
              style={{ borderBottom: "1px solid rgba(194,21,90,0.18)" }}
            >
              <div className="text-[9px] uppercase tracking-[0.2em] text-rose-100/55">
                Постановка задачи
              </div>
              <input
                id="chat-task-input"
                type="text"
                value={taskInput}
                onChange={(event) => setTaskInput(event.target.value)}
                placeholder="Опиши задачу для команды..."
                disabled={isRunning}
                className="w-full rounded-lg bg-black/45 px-3 py-2 text-sm text-white outline-none placeholder:text-rose-100/35"
                style={{ border: "1px solid rgba(194,21,90,0.26)" }}
              />
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <select
                  value={taskTargetRole}
                  onChange={(event) => setTaskTargetRole(event.target.value as RoleTarget)}
                  className="rounded-lg bg-black/45 px-3 py-2 text-xs text-rose-100 outline-none"
                  style={{ border: "1px solid rgba(194,21,90,0.26)" }}
                >
                  {["Auto", "All", ...workflowRoleOptions].map((role) => (
                    <option key={`chat-task-${role}`} value={role}>
                      {getRoleTargetLabel(role)}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={isRunning}
                  className="rounded-lg px-3 py-2 text-[10px] uppercase tracking-[0.14em] disabled:opacity-50"
                  style={{
                    background: "linear-gradient(135deg,#E8001E 0%,#C2155A 55%,#7B2FBE 100%)",
                    border: "1px solid rgba(194,21,90,0.45)",
                    color: "#fff",
                  }}
                >
                  {isRunning ? "В работе..." : "Старт"}
                </button>
              </div>
            </form>

            {/* Quick prompts */}
            <div
              className="shrink-0 px-4 py-2.5 space-y-2"
              style={{ borderBottom: "1px solid rgba(194,21,90,0.18)" }}
            >
              <div className="text-[9px] uppercase tracking-[0.2em] text-rose-100/55">
                Быстрые команды
              </div>
              <div className="chat-scroll flex max-h-[96px] flex-wrap gap-1.5 overflow-y-auto pr-1">
                {quickPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    id={`quick-${prompt.slice(1, 8).replace(/\s/g, "-")}`}
                    onClick={() => applyQuickPrompt(prompt)}
                    className="text-[11px] px-2.5 py-1 rounded-md transition-all duration-150 active:scale-95"
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
              className="shrink-0 px-4 py-2 grid grid-cols-1 sm:grid-cols-2 gap-2"
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
                  {workflowRoleOptions.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
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
              className="chat-scroll flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3"
            >
              {visibleChatMessages.map((item) => {
                const contentParts = splitChatTraceContent(item.content);
                const visibleContent = contentParts.visible;
                const hiddenTrace = contentParts.hidden;

                return (
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
                    className="w-fit max-w-[86%] px-3 py-2.5 rounded-xl text-[13px] sm:text-sm leading-relaxed"
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
                          {getRoleTargetLabel(item.targetRole)}
                        </div>
                      )}
                      {item.taskId && (
                        <div className="text-[9px] uppercase tracking-[0.14em] text-rose-100/55 font-mono">
                          task {formatTaskShortId(item.taskId)}
                        </div>
                      )}
                    </div>
                    {visibleContent ? renderChatMarkdownContent(visibleContent) : null}
                    {hiddenTrace ? (
                      <details className="mt-2 rounded-md border border-rose-300/25 bg-black/35 px-2 py-1.5">
                        <summary className="cursor-pointer text-[10px] uppercase tracking-[0.14em] text-rose-100/72">
                          Показать ход мыслей ИИ
                        </summary>
                        <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-rose-100/62">
                          {hiddenTrace}
                        </pre>
                      </details>
                    ) : null}
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
              );
              })}

              {visibleChatMessages.length === 0 && (
                <div
                  className="rounded-xl px-3 py-3 text-xs text-rose-100/55"
                  style={{
                    background: "rgba(0,0,0,0.45)",
                    border: "1px dashed rgba(194,21,90,0.22)",
                  }}
                >
                  Для выбранной задачи сообщений пока нет. Выберите другой контекст или переключитесь на общий поток.
                </div>
              )}

              {typingLabel && (
                <div
                  className="flex justify-start items-center gap-2 px-3 py-2.5 w-fit rounded-xl text-[13px]"
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
                <div className="flex justify-start items-center gap-2 px-3 py-2.5 w-fit rounded-xl text-[13px]"
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
              className="shrink-0 p-2.5 flex flex-col gap-2"
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
                  <div className="chat-scroll mt-2.5 max-h-[170px] space-y-2.5 overflow-y-auto pr-1">
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
                className="min-h-[72px] max-h-[110px] resize-y w-full bg-black/50 px-4 py-3 text-sm outline-none rounded-lg text-white placeholder:text-rose-100/30"
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
                            {getRoleTargetLabel(option.role)}
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


