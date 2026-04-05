"use client";

import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
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
  composeAgentContextTextWithAssets,
  getDefaultReferenceAssetUsage,
  parseAgentContextReferenceAssets,
  stripAgentContextReferenceAssets,
  type AgentContextReferenceAsset,
} from "@/lib/agentContextAssets";
import { repairMojibakeDeep, repairTextForDisplay } from "@/lib/text/repairMojibake";

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


/* в”Ђв”Ђв”Ђв”Ђ Types в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
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
  current_assignee?: string | null;
  assigned_agent_id?: string | null;
  artifacts?: unknown;
  workflow_mode?: "autonomous" | "manual" | null;
  manual_workflow_roles?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
  office_id?: string | null;
}

interface TaskArtifactRow {
  id: string;
  task_id: string;
  title: string;
  artifact_type?: string | null;
  mime_type?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
}

interface TaskAttachmentSummary {
  id: string;
  title: string;
  artifactType: string | null;
  mimeType: string | null;
  status: string | null;
  createdAt: string | null;
  downloadUrl: string;
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
  thoughtTrace?: string;
}

interface ChatThreadItem {
  id: string;
  title: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  isArchived?: boolean;
  activeTaskId?: string | null;
}

interface PersistedChatMessageRow {
  id: string;
  sender: "user" | "agent" | "system";
  content: string;
  role?: string | null;
  agentName?: string | null;
  scope?: string | null;
  targetRole?: string | null;
  clientMessageId?: string | null;
  taskId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
}

interface AgentContextItem {
  id: string;
  officeId: string;
  title: string;
  contextText: string;
  targetRoles: string[];
  targetAgentIds: string[];
  isActive: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  referenceAssets?: AgentContextReferenceAsset[];
}

interface SkillCatalogItem {
  id: string;
  name: string;
  description: string | null;
  runtime?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface MentionOption {
  id: string;
  role: RoleTarget;
  label: string;
  handle: string;
  isOnline: boolean;
  status: string;
}

interface CommandPaletteOption {
  id: string;
  kind: "agent" | "task" | "mcp";
  label: string;
  hint: string;
  keywords: string;
  execute: () => void;
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
  metadata?: Record<string, unknown> | null;
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
  threadId?: string | null;
  category?: ActivityCategory;
  toolCallId?: string | null;
  transient?: boolean;
}

interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  targetRole: RoleTarget | null;
  currentAssignee: string | null;
  assignedAgentId: string | null;
  workflowSignal: string | null;
  attachmentsCount: number;
  attachmentsPreview: TaskAttachmentSummary[];
  workflowMode?: WorkflowMode;
  manualWorkflowRoles?: WorkflowRole[];
  createdAt: string | null;
  updatedAt: string | null;
  source: "database" | "local";
}

/* в”Ђв”Ђв”Ђв”Ђ Constants в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
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
    visible: visibleLines.join("\\n").trim(),
    hidden: hiddenLines.join("\\n").trim(),
  };
};

const SYSTEM_BOOT_MESSAGE: ChatMessage = {
  id: "boot",
  sender: "agent",
  agentName: "Система",
  role: "System",
  content: "Командный центр на связи. Опишите задачу, и агенты приступят к работе.",
};

const mapPersistedMessageToChat = (row: PersistedChatMessageRow): ChatMessage => {
  const sender = row.sender === "user" ? "user" : "agent";
  const rawContent = repairTextForDisplay(String(row.content ?? "").trim());
  const { visible, hidden } = splitChatTraceContent(rawContent);
  const fallbackAgentName =
    row.sender === "system" ? repairTextForDisplay("Система") : undefined;
  return {
    id: row.id,
    sender,
    content: visible || rawContent,
    role: row.role ? repairTextForDisplay(row.role) : undefined,
    agentName: row.agentName ? repairTextForDisplay(row.agentName) : fallbackAgentName,
    scope: (row.scope as TeamEventScope | undefined) ?? undefined,
    targetRole: normalizeRoleTarget(row.targetRole),
    clientMessageId: row.clientMessageId ?? null,
    createdAt: row.createdAt ?? undefined,
    taskId: row.taskId ?? null,
    category: detectActivityCategory(
      rawContent,
      row.role ? repairTextForDisplay(row.role) : undefined,
      row.scope as TeamEventScope | undefined
    ),
    thoughtTrace: hidden || undefined,
  };
};

const parseCommaSeparatedValues = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
      )
  );

const getReferenceAssetKindLabel = (kind: string): string => {
  if (kind === "logo") return "Logo";
  if (kind === "product") return "Product";
  if (kind === "character") return "Character";
  return "Reference";
};

const DOWNLOADABLE_FILE_URL_PATTERN = /\.(pdf|mp4|xlsx|xls|csv|docx?|zip|jpe?g|png|webp)(\?|#|$)/i;

const normalizeDownloadName = (value: string) => {
  const normalized = value.split("\\uD83D\\uDCE5").join("").trim();
  return normalized.length > 0 ? normalized : "artifact";
};

const isDownloadableLink = (url: string, label: string) => {
  return label.includes("\\uD83D\\uDCE5") || DOWNLOADABLE_FILE_URL_PATTERN.test(url.toLowerCase());
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
  { value: "office", label: "Офис" },
  { value: "kanban", label: "Канбан" },
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
  return `${normalized.slice(0, 56).trim()}...`;
};

const normalizeTaskMetadataTargetRole = (metadata?: Record<string, unknown> | null): RoleTarget | null => {
  const value = typeof metadata?.targetRole === "string" ? metadata.targetRole : null;
  return normalizeRoleTarget(value);
};

const normalizeTaskWorkflowMetadata = (metadata?: Record<string, unknown> | null) => {
  const workflow =
    metadata?.workflow && typeof metadata.workflow === "object" && !Array.isArray(metadata.workflow)
      ? (metadata.workflow as Record<string, unknown>)
      : {};

  return {
    currentAssignee: normalizeRoleTarget(
      typeof workflow.currentAssignee === "string" ? workflow.currentAssignee : null
    ),
    workflowSignal:
      typeof workflow.workflowSignal === "string" && workflow.workflowSignal.trim().length > 0
        ? workflow.workflowSignal.trim()
        : null,
  };
};

const normalizeTaskWorkflowMode = (task: TaskRecord): WorkflowMode => {
  return normalizeWorkflowMode(task.workflow_mode ?? task.metadata?.workflowMode);
};

const normalizeTaskWorkflowRoles = (task: TaskRecord): WorkflowRole[] => {
  return normalizeWorkflowRoles(task.manual_workflow_roles ?? task.metadata?.manualWorkflowRoles);
};

const isTaskHidden = (metadata?: Record<string, unknown> | null) => metadata?.hidden === true;

const enrichTaskItemWithAttachments = (
  item: TaskItem,
  taskAttachmentsByTaskId: Record<string, TaskAttachmentSummary[]>
): TaskItem => {
  const attachments = taskAttachmentsByTaskId[item.id] ?? [];
  return {
    ...item,
    attachmentsCount: attachments.length,
    attachmentsPreview: attachments.slice(0, 4),
  };
};

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
  source: TaskItem["source"] = "database",
  taskAttachmentsByTaskId: Record<string, TaskAttachmentSummary[]> = {}
): TaskItem | null => {
  if (isTaskHidden(task.metadata)) return null;

  const description = (task.description ?? "").trim();
  const workflowMetadata = normalizeTaskWorkflowMetadata(task.metadata);
  const baseItem: TaskItem = {
    id: task.id,
    title: buildTaskTitle(description, task.id),
    description,
    status: task.status,
    targetRole: normalizeTaskMetadataTargetRole(task.metadata),
    currentAssignee: normalizeRoleTarget(task.current_assignee) ?? workflowMetadata.currentAssignee ?? null,
    assignedAgentId:
      typeof task.assigned_agent_id === "string" && task.assigned_agent_id.trim().length > 0
        ? task.assigned_agent_id
        : null,
    workflowSignal: workflowMetadata.workflowSignal,
    attachmentsCount: 0,
    attachmentsPreview: [],
    workflowMode: normalizeTaskWorkflowMode(task),
    manualWorkflowRoles: normalizeTaskWorkflowRoles(task),
    createdAt: task.created_at ?? null,
    updatedAt: task.updated_at ?? null,
    source,
  };
  return enrichTaskItemWithAttachments(baseItem, taskAttachmentsByTaskId);
};

const mapTaskArtifactRow = (row: TaskArtifactRow): TaskAttachmentSummary => {
  return {
    id: row.id,
    title: row.title?.trim() || "Artifact",
    artifactType:
      typeof row.artifact_type === "string" && row.artifact_type.trim().length > 0
        ? row.artifact_type.trim()
        : null,
    mimeType:
      typeof row.mime_type === "string" && row.mime_type.trim().length > 0 ? row.mime_type.trim() : null,
    status:
      typeof row.status === "string" && row.status.trim().length > 0
        ? row.status.trim()
        : typeof row.metadata?.status === "string" && row.metadata.status.trim().length > 0
          ? row.metadata.status.trim()
          : null,
    createdAt: row.created_at ?? null,
    downloadUrl: `/api/task-artifacts/${encodeURIComponent(row.id)}/download`,
  };
};

const groupTaskArtifacts = (rows: TaskArtifactRow[]) => {
  const grouped: Record<string, TaskAttachmentSummary[]> = {};
  for (const row of rows) {
    const taskId = typeof row.task_id === "string" && row.task_id.trim().length > 0 ? row.task_id : null;
    if (!taskId) continue;
    const summary = mapTaskArtifactRow(row);
    grouped[taskId] = [...(grouped[taskId] ?? []), summary].sort((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? ""))
    );
  }
  return grouped;
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
      currentAssignee: item.currentAssignee ?? previous?.currentAssignee ?? null,
      assignedAgentId: item.assignedAgentId ?? previous?.assignedAgentId ?? null,
      workflowSignal: item.workflowSignal ?? previous?.workflowSignal ?? null,
      attachmentsCount: item.attachmentsCount ?? previous?.attachmentsCount ?? 0,
      attachmentsPreview: item.attachmentsPreview ?? previous?.attachmentsPreview ?? [],
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
  return typeof value === "string" && value.trim().length > 0 ? repairTextForDisplay(value) : null;
};

const extractClientMessageId = (payload: Record<string, unknown> | null): string | null => {
  if (!payload) return null;
  const value = payload.clientMessageId;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
};

const extractThreadIdValue = (payload: Record<string, unknown> | null): string | null => {
  if (!payload) return null;
  const value = payload.threadId;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

/* в”Ђв”Ђв”Ђв”Ђ Component в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ */
export default function DashboardPage() {
  const router = useRouter();
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
  const [taskAttachmentsByTaskId, setTaskAttachmentsByTaskId] = useState<Record<string, TaskAttachmentSummary[]>>({});
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
  const [liveToolStatuses, setLiveToolStatuses] = useState<ProcessStep[]>([]);
  const [isTaskPanelCollapsed, setIsTaskPanelCollapsed] = useState(false);
  const [isChatPanelCollapsed, setIsChatPanelCollapsed] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
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
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([SYSTEM_BOOT_MESSAGE]);
  const [chatThreads, setChatThreads] = useState<ChatThreadItem[]>([]);
  const [activeChatThreadId, setActiveChatThreadId] = useState<string | null>(null);
  const [isChatThreadLoading, setIsChatThreadLoading] = useState(false);
  const [isInstructionModalOpen, setIsInstructionModalOpen] = useState(false);
  const [agentContexts, setAgentContexts] = useState<AgentContextItem[]>([]);
  const [isContextLoading, setIsContextLoading] = useState(false);
  const [isContextSaving, setIsContextSaving] = useState(false);
  const [editingContextId, setEditingContextId] = useState<string | null>(null);
  const taskAttachmentsRef = useRef<Record<string, TaskAttachmentSummary[]>>({});
  const [contextTitleInput, setContextTitleInput] = useState('');
  const [contextTextInput, setContextTextInput] = useState('');
  const [contextReferenceAssetsInput, setContextReferenceAssetsInput] = useState<AgentContextReferenceAsset[]>([]);
  const [contextAssetKindInput, setContextAssetKindInput] = useState("logo");
  const [contextAssetLabelInput, setContextAssetLabelInput] = useState("");
  const [isInstructionAssetUploading, setIsInstructionAssetUploading] = useState(false);
  const [contextRolesInput, setContextRolesInput] = useState<string[]>([]);
  const [contextAgentIdsInput, setContextAgentIdsInput] = useState<string[]>([]);
  const [contextRoleCsvInput, setContextRoleCsvInput] = useState('');
  const [contextIsActiveInput, setContextIsActiveInput] = useState(true);
  const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);
  const [interactionTargetRole, setInteractionTargetRole] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const seenClientMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingTaskIdRef = useRef<string | null>(null);
  const liveStatusTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const instructionAssetInputRef = useRef<HTMLInputElement | null>(null);
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
          .select("id, name, description, runtime, metadata")
          .eq("is_active", true)
          .order("name", { ascending: true });

        if (cancelled) return;
        if (error) throw error;

        const skills = (Array.isArray(data) ? data : [])
          .map<SkillCatalogItem | null>((row) => {
            const id = typeof row.id === "string" ? row.id : "";
            const name = typeof row.name === "string" ? row.name.trim() : "";
            if (!id || !name) return null;
            return {
              id,
              name,
              description: typeof row.description === "string" ? row.description : null,
              runtime: typeof row.runtime === "string" ? row.runtime : null,
              metadata:
                row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
                  ? (row.metadata as Record<string, unknown>)
                  : null,
            };
          })
          .filter((item): item is SkillCatalogItem => item !== null);

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
    if (typingRoles.length === 1) return `${repairTextForDisplay(typingRoles[0])} печатает...`;
    return `${typingRoles.map((role) => repairTextForDisplay(role)).join(", ")} печатают...`;
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

  const commandPaletteOptions = useMemo<CommandPaletteOption[]>(() => {
    const agentOptions = agents.map((agent) => ({
      id: `agent-${agent.id}`,
      kind: "agent" as const,
      label: `Агент: ${repairTextForDisplay(agent.name)}`,
      hint: agent.role,
      keywords: `${agent.name} ${agent.role} agent role`,
      execute: () => {
        setInteractionTargetRole(agent.role);
        setChatTargetRole(agent.role);
      },
    }));

    const taskOptions = taskItems.map((task) => ({
      id: `task-${task.id}`,
      kind: "task" as const,
      label: `Задача: ${repairTextForDisplay(task.title)}`,
      hint: task.status,
      keywords: `${task.title} ${task.status} ${task.targetRole ?? "all"} task`,
      execute: () => {
        setSelectedTaskId(task.id);
        setActiveView("office");
      },
    }));

    const mcpOptions = skillsCatalog
      .filter((skill) => {
        const normalized = skill.name.toLowerCase();
        return skill.runtime === "mcp" || normalized.startsWith("mcp_");
      })
      .map((skill) => ({
        id: `mcp-${skill.id}`,
        kind: "mcp" as const,
        label: `MCP: ${skill.name}`,
        hint: "Connector",
        keywords: `${skill.name} ${skill.description ?? ""} mcp connector`,
        execute: () => {
          void sendMessageToAgents(
            `Проверь статус MCP-инструмента ${repairTextForDisplay(skill.name)} и сообщи доступные действия.`,
            operationsRole
          );
        },
      }));

    return [...agentOptions, ...taskOptions, ...mcpOptions];
  }, [agents, operationsRole, skillsCatalog, taskItems]);

  const filteredCommandOptions = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return commandPaletteOptions.slice(0, 12);
    return commandPaletteOptions
      .filter((option) => option.keywords.toLowerCase().includes(query))
      .slice(0, 12);
  }, [commandPaletteOptions, commandQuery]);

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
      content: repairTextForDisplay(entry.content),
      role: entry.role ? repairTextForDisplay(entry.role) : entry.role,
      agentName: entry.agentName ? repairTextForDisplay(entry.agentName) : entry.agentName,
      thoughtTrace: entry.thoughtTrace ? repairTextForDisplay(entry.thoughtTrace) : entry.thoughtTrace,
      category:
        entry.category ??
        detectActivityCategory(
          repairTextForDisplay(entry.content),
          entry.role ? repairTextForDisplay(entry.role) : entry.role,
          entry.scope
        ),
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

  const resetInstructionForm = () => {
    setEditingContextId(null);
    setContextTitleInput("");
    setContextTextInput("");
    setContextReferenceAssetsInput([]);
    setContextAssetKindInput("logo");
    setContextAssetLabelInput("");
    setContextRolesInput([]);
    setContextAgentIdsInput([]);
    setContextRoleCsvInput("");
    setContextIsActiveInput(true);
    if (instructionAssetInputRef.current) {
      instructionAssetInputRef.current.value = "";
    }
  };

  const applyContextToForm = (context: AgentContextItem) => {
    const referenceAssets =
      Array.isArray(context.referenceAssets) && context.referenceAssets.length > 0
        ? context.referenceAssets
        : parseAgentContextReferenceAssets(context.contextText);
    setEditingContextId(context.id);
    setContextTitleInput(context.title);
    setContextTextInput(stripAgentContextReferenceAssets(context.contextText));
    setContextReferenceAssetsInput(referenceAssets);
    setContextAssetKindInput(referenceAssets[0]?.kind ?? "logo");
    setContextAssetLabelInput("");
    setContextRolesInput(context.targetRoles);
    setContextAgentIdsInput(context.targetAgentIds);
    setContextRoleCsvInput(context.targetRoles.join(", "));
    setContextIsActiveInput(context.isActive);
  };

  const removeContextReferenceAsset = (storagePath: string) => {
    setContextReferenceAssetsInput((previous) =>
      previous.filter((asset) => asset.storagePath !== storagePath)
    );
  };

  const uploadInstructionAsset = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file || !activeOfficeId || isInstructionAssetUploading) {
      return;
    }

    setIsInstructionAssetUploading(true);
    try {
      const formData = new FormData();
      const kind = contextAssetKindInput.trim() || "reference";
      const label = contextAssetLabelInput.trim();

      formData.set("officeId", activeOfficeId);
      formData.set("kind", kind);
      if (label) {
        formData.set("label", label);
      }
      formData.set("usage", getDefaultReferenceAssetUsage(kind, label || file.name));
      formData.set("file", file);

      const response = await fetch("/api/agent-contexts/assets", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as {
        asset?: AgentContextReferenceAsset;
        error?: string;
      };
      if (!response.ok || !payload.asset) {
        throw new Error(payload.error ?? "Failed to upload instruction asset");
      }

      setContextReferenceAssetsInput((previous) => {
        const deduped = previous.filter(
          (asset) => asset.storagePath !== payload.asset?.storagePath
        );
        return [...deduped, payload.asset!];
      });
      setContextAssetLabelInput("");
    } catch (error) {
      console.error("[AgentContexts] failed to upload instruction asset:", error);
      alert("Не удалось загрузить reference image.");
    } finally {
      setIsInstructionAssetUploading(false);
      if (instructionAssetInputRef.current) {
        instructionAssetInputRef.current.value = "";
      }
    }
  };

  const loadAgentContexts = useCallback(
    async (officeId: string) => {
      if (!officeId || isMockMode) {
        setAgentContexts([]);
        return;
      }

      setIsContextLoading(true);
      try {
        const response = await fetch(`/api/agent-contexts?officeId=${encodeURIComponent(officeId)}`, {
          method: "GET",
        });
        const payload = (await response.json()) as { contexts?: AgentContextItem[]; error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to load contexts");
        }
        setAgentContexts(
          (Array.isArray(payload.contexts) ? payload.contexts : []).map((context) => ({
            ...context,
            referenceAssets:
              Array.isArray(context.referenceAssets) && context.referenceAssets.length > 0
                ? context.referenceAssets
                : parseAgentContextReferenceAssets(context.contextText),
          }))
        );
      } catch (error) {
        console.error("[AgentContexts] failed to load:", error);
        setAgentContexts([]);
      } finally {
        setIsContextLoading(false);
      }
    },
    []
  );

  const loadThreadMessages = useCallback(
    async (officeId: string, threadId: string) => {
      if (!officeId || !threadId || isMockMode) {
        setChatMessages([SYSTEM_BOOT_MESSAGE]);
        return;
      }

      setIsChatThreadLoading(true);
      try {
        const response = await fetch(
          `/api/chat-threads/${encodeURIComponent(threadId)}/messages?officeId=${encodeURIComponent(officeId)}`,
          { method: "GET" }
        );
        const payload = (await response.json()) as { messages?: PersistedChatMessageRow[]; error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to load thread messages");
        }
        const mapped = (Array.isArray(payload.messages) ? payload.messages : []).map(mapPersistedMessageToChat);
        setChatMessages(mapped.length > 0 ? mapped : [SYSTEM_BOOT_MESSAGE]);
      } catch (error) {
        console.error("[ChatThreads] failed to load messages:", error);
        setChatMessages([SYSTEM_BOOT_MESSAGE]);
      } finally {
        setIsChatThreadLoading(false);
      }
    },
    []
  );

  const loadChatThreads = useCallback(
    async (officeId: string, preferredThreadId?: string | null): Promise<string | null> => {
      if (!officeId || isMockMode) {
        setChatThreads([]);
        setActiveChatThreadId(null);
        setChatMessages([SYSTEM_BOOT_MESSAGE]);
        return null;
      }

      setIsChatThreadLoading(true);
      try {
        const response = await fetch(`/api/chat-threads?officeId=${encodeURIComponent(officeId)}`, {
          method: "GET",
        });
        const payload = (await response.json()) as { threads?: ChatThreadItem[]; error?: string };
        if (!response.ok) {
          throw new Error(payload.error ?? "Failed to load chat threads");
        }

        const threads = repairMojibakeDeep(Array.isArray(payload.threads) ? payload.threads : []);
        setChatThreads(threads);
        const existingThreadId = preferredThreadId ?? null;
        const resolvedThreadId =
          (existingThreadId && threads.some((thread) => thread.id === existingThreadId) ? existingThreadId : null) ??
          threads[0]?.id ??
          null;
        setActiveChatThreadId(resolvedThreadId);
        const resolvedThread = threads.find((thread) => thread.id === resolvedThreadId) ?? null;
        setSelectedTaskId(resolvedThread?.activeTaskId ?? null);
        if (resolvedThreadId) {
          await loadThreadMessages(officeId, resolvedThreadId);
        } else {
          setChatMessages([SYSTEM_BOOT_MESSAGE]);
        }
        return resolvedThreadId;
      } catch (error) {
        console.error("[ChatThreads] failed to load:", error);
        setChatThreads([]);
        setActiveChatThreadId(null);
        setChatMessages([SYSTEM_BOOT_MESSAGE]);
        return null;
      } finally {
        setIsChatThreadLoading(false);
      }
    },
    [loadThreadMessages]
  );

  const createChatThread = useCallback(async (): Promise<string | null> => {
    if (!activeOfficeId || isMockMode) return null;

    const index = chatThreads.length + 1;
    const nextTitle = `Чат ${index}`;
    setIsChatThreadLoading(true);
    try {
      const response = await fetch("/api/chat-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          officeId: activeOfficeId,
          title: nextTitle,
        }),
      });
      const payload = (await response.json()) as { thread?: ChatThreadItem; error?: string };
      if (!response.ok || !payload.thread?.id) {
        throw new Error(payload.error ?? "Failed to create thread");
      }
      const thread = payload.thread;
      setChatThreads((previous) => [thread, ...previous.filter((item) => item.id !== thread.id)]);
      setActiveChatThreadId(thread.id);
      setSelectedTaskId(null);
      setChatMessages([SYSTEM_BOOT_MESSAGE]);
      return thread.id;
    } catch (error) {
      console.error("[ChatThreads] failed to create:", error);
      return null;
    } finally {
      setIsChatThreadLoading(false);
    }
  }, [activeOfficeId, chatThreads.length]);

  const ensureActiveThreadId = useCallback(async (): Promise<string | null> => {
    if (activeChatThreadId) return activeChatThreadId;
    if (chatThreads[0]?.id) {
      setActiveChatThreadId(chatThreads[0].id);
      return chatThreads[0].id;
    }
    return createChatThread();
  }, [activeChatThreadId, chatThreads, createChatThread]);

  const persistThreadMessage = useCallback(
    async (threadId: string, entry: ChatMessage) => {
      if (!activeOfficeId || !threadId || isMockMode) return;

      try {
        const response = await fetch(`/api/chat-threads/${encodeURIComponent(threadId)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            officeId: activeOfficeId,
            sender: entry.sender === "user" ? "user" : "agent",
            content: entry.content,
            role: entry.role ?? null,
            agentName: entry.agentName ?? null,
            scope: entry.scope ?? null,
            targetRole: entry.targetRole ?? null,
            clientMessageId: entry.clientMessageId ?? null,
            taskId: entry.taskId ?? null,
            metadata: {
              thoughtTrace: entry.thoughtTrace ?? null,
            },
          }),
        });
        if (response.ok) {
          setChatThreads((previous) => {
            const current = previous.find((thread) => thread.id === threadId);
            if (!current) return previous;
            const next = {
              ...current,
              updatedAt: new Date().toISOString(),
            };
            return [next, ...previous.filter((thread) => thread.id !== threadId)];
          });
        }
      } catch (error) {
        console.error("[ChatThreads] failed to persist message:", error);
      }
    },
    [activeOfficeId]
  );

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

  const clearLiveStatusTimeout = (statusId: string) => {
    const timer = liveStatusTimeoutsRef.current[statusId];
    if (!timer) return;
    clearTimeout(timer);
    delete liveStatusTimeoutsRef.current[statusId];
  };

  const scheduleLiveStatusExpiry = (statusId: string) => {
    clearLiveStatusTimeout(statusId);
    liveStatusTimeoutsRef.current[statusId] = setTimeout(() => {
      setLiveToolStatuses((previous) => previous.filter((item) => item.id !== statusId));
      delete liveStatusTimeoutsRef.current[statusId];
    }, 8000);
  };

  const upsertLiveToolStatus = (step: ProcessStep) => {
    const normalizedStep: ProcessStep = {
      ...step,
      taskId: step.taskId ?? null,
      threadId: step.threadId ?? null,
      toolCallId: step.toolCallId ?? null,
      transient: true,
    };

    setLiveToolStatuses((previous) => {
      const next = previous.filter(
        (item) =>
          item.id !== normalizedStep.id &&
          !(
            normalizedStep.toolCallId &&
            item.toolCallId &&
            item.toolCallId === normalizedStep.toolCallId
          )
      );
      return [normalizedStep, ...next].slice(0, 12);
    });

    if (normalizedStep.tone === "ok" || normalizedStep.tone === "error") {
      scheduleLiveStatusExpiry(normalizedStep.id);
    } else {
      clearLiveStatusTimeout(normalizedStep.id);
    }
  };

  const clearLiveStatusesForContext = (threadId?: string | null, taskId?: string | null) => {
    if (!threadId && !taskId) {
      return;
    }

    setLiveToolStatuses((previous) => {
      const next = previous.filter((item) => {
        const matchesThread = threadId ? item.threadId === threadId : false;
        const matchesTask = taskId ? item.taskId === taskId : false;
        const shouldRemove = matchesThread || matchesTask;
        if (shouldRemove) {
          clearLiveStatusTimeout(item.id);
        }
        return !shouldRemove;
      });
      return next;
    });
  };

  const upsertTaskItems = (items: TaskItem[]) => {
    if (items.length === 0) return;
    setTaskItems((previous) => mergeTaskItems(previous, items));
  };

  const upsertTaskRecord = (task: TaskRecord, source: TaskItem["source"] = "database") => {
    const normalized = toTaskItem(task, source, taskAttachmentsRef.current);
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

  const handleKanbanMoveTask = (taskId: string, nextStatus: TaskStatus) => {
    const existingTask = taskItems.find((task) => task.id === taskId);
    if (!existingTask || existingTask.status === nextStatus) return;

    const nextUpdatedAt = new Date().toISOString();
    setTaskItems((previous) =>
      previous.map((task) =>
        task.id === taskId
          ? {
              ...task,
              status: nextStatus,
              updatedAt: nextUpdatedAt,
            }
          : task
      )
    );

    appendProcessStep({
      id: makeId(),
      label: "Kanban update",
      detail: `${existingTask.title} -> ${nextStatus}`,
      time: formatProcessTime(nextUpdatedAt),
      tone: "info",
      taskId,
      category: "devops",
    });

    if (isMockMode) return;

    void (async () => {
      try {
        let updateQuery = supabase
          .from("tasks")
          .update({ status: nextStatus, updated_at: nextUpdatedAt })
          .eq("id", taskId);

        if (activeOfficeId) {
          updateQuery = updateQuery.eq("office_id", activeOfficeId);
        }

        const { error } = await updateQuery;
        if (error) throw error;
      } catch (error) {
        console.error("[KanbanMoveTask] failed to persist status:", error);
        setTaskItems((previous) =>
          previous.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  status: existingTask.status,
                  updatedAt: existingTask.updatedAt,
                }
              : task
          )
        );
        appendProcessStep({
          id: makeId(),
          label: "Kanban rollback",
          detail: `Не удалось сохранить ${repairTextForDisplay(existingTask.title)}`,
          time: formatProcessTime(),
          tone: "error",
          taskId,
          category: "devops",
        });
      }
    })();
  };

  const handleKanbanDeleteTask = async (taskId: string) => {
    const existingTask = taskItems.find((task) => task.id === taskId);
    if (!existingTask) return;

    removeTaskFromDashboard(taskId);
    appendProcessStep({
      id: makeId(),
      label: "Kanban delete",
      detail: `Удаление: ${existingTask.title}`,
      time: formatProcessTime(),
      tone: "info",
      taskId,
      category: "devops",
    });

    if (isMockMode) return;

    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}?officeId=${encodeURIComponent(activeOfficeId ?? "")}`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
      }
    } catch (error) {
      console.error("[KanbanDeleteTask] failed:", error);
      setTaskItems((previous) => mergeTaskItems(previous, [existingTask]));
      appendProcessStep({
        id: makeId(),
        label: "Kanban rollback",
        detail: `Не удалось удалить ${repairTextForDisplay(existingTask.title)}`,
        time: formatProcessTime(),
        tone: "error",
        taskId,
        category: "devops",
      });
      throw error;
    }
  };

  const createOffice = async () => {
    const normalizedName = newOfficeName.trim();
    if (!normalizedName || isCreatingOffice) return;
    setIsCreatingOffice(true);
    try {
      if (isMockMode) {
        const mockId = `mock-${Date.now()}`;
        const mockOffice = { id: mockId, name: normalizedName, accessRole: "owner" as const };
        setAvailableOffices((prev) => [mockOffice, ...prev]);
        setActiveOfficeId(mockOffice.id);
        setActiveOfficeName(mockOffice.name);
        setIsCreateOfficeOpen(false);
        setNewOfficeName("");
      } else {
        const res = await fetch("/api/offices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: normalizedName }),
        });
        const data = await res.json();
        if (res.ok && data.office) {
           setAvailableOffices(prev => [data.office, ...prev]);
           setActiveOfficeId(data.office.id);
           setActiveOfficeName(data.office.name);
           setIsCreateOfficeOpen(false);
           setNewOfficeName("");
        } else {
           const errorMsg = data.detail || data.error || "Ошибка при создании офиса";
           alert(errorMsg);
        }
      }
    } catch (e) {
      console.error("[CreateOffice]", e);
      alert("Не удалось создать департамент. Проверьте соединение с БД.");
    } finally {
      setIsCreatingOffice(false);
    }
  };

  const resolveEventActorName = (eventRow: TeamEventRow) => {
    const senderRole = repairTextForDisplay(eventRow.sender_role ?? "").trim();
    const senderName = repairTextForDisplay(eventRow.sender_name ?? "").trim();
    const matchedAgent =
      agents.find((agent) => repairTextForDisplay(agent.role).trim() === senderRole) ??
      agents.find((agent) => repairTextForDisplay(agent.name).trim() === senderName);

    return matchedAgent?.name || senderName || senderRole || "Система";
  };

  const buildProcessStepFromEvent = (eventRow: TeamEventRow): ProcessStep | null => {
    const payload = eventRow.payload ?? {};
    const message = extractEventMessage(payload);
    const taskId = normalizeTaskIdValue(payload.taskId);
    const threadId = extractThreadIdValue(payload);
    const sender = resolveEventActorName(eventRow);
    const time = formatProcessTime(eventRow.created_at);
    const category = detectActivityCategory(message ?? eventRow.event_name, eventRow.sender_role, eventRow.scope, eventRow.event_name);
    const toolName = typeof payload.toolName === "string" ? repairTextForDisplay(payload.toolName) : null;
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : null;

    if (eventRow.event_name === "workflow.approval_requested") {
      return { id: `proc-${eventRow.id}`, label: "Ожидание подтверждения", detail: message ?? "Требуется запуск проекта.", time, tone: "warn", taskId, threadId, category };
    }
    if (eventRow.event_name === "task.execution_started") {
      return { id: `proc-${eventRow.id}`, label: "Выполнение начато", detail: `${sender} приступил к работе.`, time, tone: "run", taskId, threadId, category };
    }
    if (eventRow.event_name === "task.execution_completed") {
      return { id: `proc-${eventRow.id}`, label: "Выполнение завершено", detail: `${sender} закончил задачу.`, time, tone: "ok", taskId, threadId, category };
    }
    if (eventRow.event_name === "workflow.tool_started") {
      return {
        id: `proc-${eventRow.id}`,
        label: `⚙️ ${sender}`,
        detail:
          toolName === "image_generator"
            ? `${sender} генерирует изображение...`
            : message ?? `${sender} использует инструмент ${toolName ?? "tool"}`,
        time,
        tone: "run",
        taskId,
        threadId,
        category,
        toolCallId,
        transient: true,
      };
    }
    if (eventRow.event_name === "workflow.tool_completed") {
      return {
        id: `proc-${eventRow.id}`,
        label: `✅ ${sender}`,
        detail:
          toolName === "image_generator"
            ? `${sender} получил изображение`
            : message ?? `${sender} завершил инструмент ${toolName ?? "tool"}`,
        time,
        tone: "ok",
        taskId,
        threadId,
        category,
        toolCallId,
        transient: true,
      };
    }
    if (eventRow.event_name === "workflow.tool_failed") {
      return {
        id: `proc-${eventRow.id}`,
        label: `❌ ${sender}`,
        detail:
          toolName === "image_generator"
            ? `Генерация изображения не удалась: ${message ?? "неизвестная ошибка"}`
            : message ?? `Инструмент ${toolName ?? "tool"} завершился с ошибкой`,
        time,
        tone: "error",
        taskId,
        threadId,
        category,
        toolCallId,
        transient: true,
      };
    }
    if (eventRow.event_name === "workflow.delegate_task") {
      return { id: `proc-${eventRow.id}`, label: "Handoff", detail: message ?? `${sender} передал задачу следующей роли.`, time, tone: "info", taskId, threadId, category };
    }
    if (eventRow.event_name === "workflow.system_error") {
      return { id: `proc-${eventRow.id}`, label: "System Error", detail: message ?? "Требуется коррекция workflow.", time, tone: "error", taskId, threadId, category };
    }
    if (eventRow.event_name === "workflow.stage_started") {
      return { id: `proc-${eventRow.id}`, label: `${sender}`, detail: message ?? "Начал этап работы.", time, tone: "run", taskId, threadId, category };
    }
    if (eventRow.event_name === "workflow.stage_completed") {
      return { id: `proc-${eventRow.id}`, label: `${sender}`, detail: message ?? "Завершил этап работы.", time, tone: "ok", taskId, threadId, category };
    }
    if (eventRow.event_name === "chat.agent_response" && message) {
      return { id: `proc-${eventRow.id}`, label: `ИИ: ${sender}`, detail: message.slice(0, 100) + "...", time, tone: "info", taskId, threadId, category };
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

    const threadId = await ensureActiveThreadId();
    if (!threadId) {
      alert("Не удалось создать чат. Проверьте доступ к БД.");
      return;
    }

    const resolvedTargetRole = /@([^\s@]+)/.test(message) ? resolveMentionTargetRole(message) : preferredTargetRole;
    const resolvedScope = resolveScopeForRequest(resolvedTargetRole);
    const clientMessageId = `chat-${makeId()}`;
    const contextTaskId = selectedTaskId ?? pendingTaskId ?? approvalDraft?.taskId ?? null;

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
    await persistThreadMessage(threadId, userEntry);
    setChatLoading(true);

    try {
      const historyForRequest = [...chatMessages, userEntry].slice(-6).map((item) => ({
        role: item.sender === "user" ? "user" : "assistant",
        content: item.content,
      }));

      const res = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          targetRole: resolvedTargetRole,
          scope: resolvedScope,
          roomKey: activeRoomKey,
          officeId: activeOfficeId,
          threadId,
          clientMessageId,
          selectedTaskId: contextTaskId,
          history: historyForRequest,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const errorMessage =
          typeof data?.error === "string" && data.error.trim().length > 0
            ? data.error
            : `chat_request_failed_${res.status}`;
        throw new Error(errorMessage);
      }
      const resolvedTaskId = typeof data.taskId === "string" && data.taskId.trim().length > 0
        ? data.taskId
        : contextTaskId;
      if (resolvedTaskId) {
        setSelectedTaskId(resolvedTaskId);
        setChatMessages((previous) =>
          previous.map((item) =>
            item.clientMessageId === clientMessageId && item.sender === "user"
              ? { ...item, taskId: resolvedTaskId }
              : item
          )
        );
        setChatThreads((previous) =>
          previous.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  activeTaskId: resolvedTaskId,
                  updatedAt: new Date().toISOString(),
                }
              : thread
          )
        );
      }
      const rawReply = repairTextForDisplay(
        typeof data.message === "string" && data.message.trim().length > 0
          ? data.message
          : typeof data.error === "string" && data.error.trim().length > 0
            ? `Ошибка чата: ${data.error}`
            : "Нет ответа."
      );
      const { visible, hidden } = splitChatTraceContent(rawReply);
      const agentEntry: ChatMessage = {
        id: makeId(),
        sender: "agent",
        role: typeof data.role === "string" ? repairTextForDisplay(data.role) : data.role,
        agentName: repairTextForDisplay(
          typeof data.agentName === "string" && data.agentName.trim().length > 0
            ? data.agentName
            : typeof data.role === "string"
              ? data.role
              : ""
        ),
        content: visible || rawReply,
        scope: data.scope ?? resolvedScope,
        targetRole: normalizeRoleTarget(data.targetRole),
        clientMessageId: data.clientMessageId,
        createdAt: new Date().toISOString(),
        taskId: resolvedTaskId,
        thoughtTrace: hidden || undefined,
      };
      appendChatMessage(agentEntry);
      await persistThreadMessage(threadId, agentEntry);
      activateRoleAnimation(data.role, data.targetRole);

      if (data.role) {
        const roleOwner = agents.find((agent) => agent.role === data.role);
        if (roleOwner?.id) {
          setAgentRuntimeStateById((previous) => ({
            ...previous,
            [roleOwner.id]: {
              ...(previous[roleOwner.id] ?? { agent_id: roleOwner.id }),
              agent_id: roleOwner.id,
              status: "working",
              current_action: (visible || rawReply).slice(0, 180),
              current_skill: null,
              metadata: {
                ...(previous[roleOwner.id]?.metadata ?? {}),
                syncedFrom: "chat",
              },
            },
          }));
        }
      }
    } catch (error) {
      console.error("Chat error", error);
      const errorMessage =
        error instanceof Error && error.message.trim().length > 0
          ? repairTextForDisplay(error.message)
          : "Не удалось получить ответ агента.";
      const agentEntry: ChatMessage = {
        id: makeId(),
        sender: "agent",
        role: resolvedTargetRole ?? "System",
        agentName: "System",
        content: `Ошибка чата: ${errorMessage}`,
        scope: resolvedScope,
        targetRole: resolvedTargetRole,
        clientMessageId,
        createdAt: new Date().toISOString(),
        taskId: contextTaskId,
      };
      appendChatMessage(agentEntry);
      await persistThreadMessage(threadId, agentEntry);
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

  const handleSelectThread = async (threadId: string) => {
    if (!activeOfficeId || !threadId || threadId === activeChatThreadId) return;
    setActiveChatThreadId(threadId);
    const thread = chatThreads.find((item) => item.id === threadId) ?? null;
    setSelectedTaskId(thread?.activeTaskId ?? null);
    await loadThreadMessages(activeOfficeId, threadId);
  };

  const handleCreateThread = async () => {
    const newThreadId = await createChatThread();
    if (!newThreadId || !activeOfficeId) return;
    await loadThreadMessages(activeOfficeId, newThreadId);
  };

  const toggleRoleInInstructionForm = (role: string) => {
    setContextRolesInput((previous) => {
      const next = previous.includes(role)
        ? previous.filter((item) => item !== role)
        : [...previous, role];
      setContextRoleCsvInput(next.join(", "));
      return next;
    });
  };

  const toggleAgentInInstructionForm = (agentId: string) => {
    setContextAgentIdsInput((previous) =>
      previous.includes(agentId)
        ? previous.filter((item) => item !== agentId)
        : [...previous, agentId]
    );
  };

  const saveAgentInstruction = async () => {
    const composedContextText = composeAgentContextTextWithAssets(
      contextTextInput.trim(),
      contextReferenceAssetsInput
    );
    if (!activeOfficeId || !contextTitleInput.trim() || !composedContextText || isContextSaving) {
      return;
    }

    setIsContextSaving(true);
    const normalizedRoles = parseCommaSeparatedValues(contextRoleCsvInput);
    const payload = {
      officeId: activeOfficeId,
      title: contextTitleInput.trim(),
      contextText: composedContextText,
      targetRoles: normalizedRoles.length > 0 ? normalizedRoles : contextRolesInput,
      targetAgentIds: contextAgentIdsInput,
      isActive: contextIsActiveInput,
    };

    try {
      const endpoint = editingContextId
        ? `/api/agent-contexts/${encodeURIComponent(editingContextId)}`
        : "/api/agent-contexts";
      const method = editingContextId ? "PATCH" : "POST";
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "Failed to save instruction");
      }
      await loadAgentContexts(activeOfficeId);
      resetInstructionForm();
    } catch (error) {
      console.error("[AgentContexts] failed to save:", error);
      alert("Не удалось сохранить инструкцию.");
    } finally {
      setIsContextSaving(false);
    }
  };

  const toggleInstructionActive = async (context: AgentContextItem) => {
    if (!activeOfficeId) return;
    try {
      await fetch(`/api/agent-contexts/${encodeURIComponent(context.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          officeId: activeOfficeId,
          isActive: !context.isActive,
        }),
      });
      await loadAgentContexts(activeOfficeId);
    } catch (error) {
      console.error("[AgentContexts] failed to toggle:", error);
    }
  };

  const deleteInstruction = async (contextId: string) => {
    if (!activeOfficeId) return;
    try {
      await fetch(
        `/api/agent-contexts/${encodeURIComponent(contextId)}?officeId=${encodeURIComponent(activeOfficeId)}`,
        { method: "DELETE" }
      );
      await loadAgentContexts(activeOfficeId);
      if (editingContextId === contextId) {
        resetInstructionForm();
      }
    } catch (error) {
      console.error("[AgentContexts] failed to delete:", error);
    }
  };

  const executeCommandPaletteOption = (option: CommandPaletteOption) => {
    option.execute();
    setIsCommandPaletteOpen(false);
    setCommandQuery("");
  };

  const exitToHub = () => {
    setActiveOfficeId(null);
    setActiveOfficeName("Digital Pixel Office");
    router.push("/");
  };

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    return () => {
      for (const timer of Object.values(liveStatusTimeoutsRef.current)) {
        clearTimeout(timer);
      }
      liveStatusTimeoutsRef.current = {};
    };
  }, []);

  useEffect(() => {
    taskAttachmentsRef.current = taskAttachmentsByTaskId;
    setTaskItems((previous) =>
      previous.map((item) => enrichTaskItemWithAttachments(item, taskAttachmentsByTaskId))
    );
  }, [taskAttachmentsByTaskId]);

  useEffect(() => {
    if (!mounted) return;
    if (window.innerWidth < 1480) {
      setIsTaskPanelCollapsed(true);
      setIsChatPanelCollapsed(true);
    }
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const lowerKey = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && lowerKey === "k") {
        event.preventDefault();
        setIsCommandPaletteOpen((previous) => !previous);
        return;
      }
      if (event.key === "Escape") {
        setIsCommandPaletteOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mounted]);

  useEffect(() => {
    if (!mounted || isMockMode || !activeOfficeId) return;
    void loadChatThreads(activeOfficeId, activeChatThreadId);
    void loadAgentContexts(activeOfficeId);
  }, [activeOfficeId, loadAgentContexts, loadChatThreads, mounted]);

  useEffect(() => {
    if (!isInstructionModalOpen || !activeOfficeId || isMockMode) return;
    void loadAgentContexts(activeOfficeId);
  }, [activeOfficeId, isInstructionModalOpen, loadAgentContexts]);

  useEffect(() => {
    if (!mounted) return;
    if (isMockMode || !activeOfficeId) {
      setTaskItems([]);
      setTaskAttachmentsByTaskId({});
      return;
    }

    let isDisposed = false;

    const loadTaskArtifacts = async () => {
      const { data } = await supabase
        .from("task_artifacts")
        .select("id, task_id, title, artifact_type, mime_type, status, metadata, created_at")
        .eq("office_id", activeOfficeId)
        .order("created_at", { ascending: false })
        .limit(120);

      if (isDisposed) return;
      setTaskAttachmentsByTaskId(groupTaskArtifacts((data ?? []) as TaskArtifactRow[]));
    };

    const loadInitialTasks = async () => {
      const [{ data: tasksData }, { data: artifactRows }] = await Promise.all([
        supabase
          .from("tasks")
          .select("*")
          .eq("office_id", activeOfficeId)
          .order("updated_at", { ascending: false })
          .limit(TASK_CARD_LIMIT),
        supabase
          .from("task_artifacts")
          .select("id, task_id, title, artifact_type, mime_type, status, metadata, created_at")
          .eq("office_id", activeOfficeId)
          .order("created_at", { ascending: false })
          .limit(120),
      ]);

      if (isDisposed) return;

      const attachmentMap = groupTaskArtifacts((artifactRows ?? []) as TaskArtifactRow[]);
      setTaskAttachmentsByTaskId(attachmentMap);
      setTaskItems(
        ((tasksData ?? []) as TaskRecord[])
          .map((task) => toTaskItem(task, "database", attachmentMap))
          .filter((task): task is TaskItem => Boolean(task))
      );
    };

    void loadInitialTasks();

    const tasksChannel = supabase
      .channel(`dashboard-tasks-${activeOfficeId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "tasks",
          filter: `office_id=eq.${activeOfficeId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const deletedTaskId =
              typeof payload.old?.id === "string" && payload.old.id.trim().length > 0
                ? payload.old.id
                : null;
            if (deletedTaskId) {
              removeTaskFromDashboard(deletedTaskId);
            }
            return;
          }

          const nextTask = payload.new as TaskRecord | null;
          if (nextTask?.id) {
            upsertTaskRecord(nextTask, "database");
          }
        }
      )
      .subscribe();

    const artifactsChannel = supabase
      .channel(`dashboard-task-artifacts-${activeOfficeId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "task_artifacts",
          filter: `office_id=eq.${activeOfficeId}`,
        },
        () => {
          void loadTaskArtifacts();
        }
      )
      .subscribe();

    return () => {
      isDisposed = true;
      void supabase.removeChannel(tasksChannel);
      void supabase.removeChannel(artifactsChannel);
    };
  }, [activeOfficeId, mounted]);

  useEffect(() => {
    if (!mounted || isMockMode || !activeRoomKey) return;

    seenEventIdsRef.current.clear();
    let disposed = false;

    const channel = supabase
      .channel(`dashboard-team-events-${activeRoomKey}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "team_events",
          filter: `room_key=eq.${activeRoomKey}`,
        },
        (payload) => {
          if (disposed) return;

          const eventRow = payload.new as TeamEventRow;
          if (!eventRow?.id || seenEventIdsRef.current.has(eventRow.id)) return;
          seenEventIdsRef.current.add(eventRow.id);

          appendEventFeed(`[${formatProcessTime(eventRow.created_at)}] ${eventRow.event_name}`);
          const step = buildProcessStepFromEvent(eventRow);
          if (step) {
            appendProcessStep(step);
            if (step.transient) {
              upsertLiveToolStatus(step);
            }
          }

          const eventPayload = eventRow.payload ?? {};
          const message = extractEventMessage(eventPayload);
          const eventTaskId = normalizeTaskIdValue(eventPayload.taskId);
          const eventThreadId = extractThreadIdValue(eventPayload);
          const isWorkflowChatResponse =
            eventRow.event_name === "chat.agent_response" &&
            eventPayload.source === "workflow" &&
            typeof message === "string" &&
            message.trim().length > 0;

          if (eventRow.event_name === "chat.agent_response") {
            clearLiveStatusesForContext(eventThreadId, eventTaskId);
          }

          if (isWorkflowChatResponse && message) {
            appendChatMessage({
              id: `event-${eventRow.id}`,
              sender: "agent",
              content: message,
              role: eventRow.sender_role ?? undefined,
              agentName: eventRow.sender_name ?? eventRow.sender_role ?? undefined,
              scope: eventRow.scope,
              targetRole: normalizeRoleTarget(eventRow.target_role),
              clientMessageId: extractClientMessageId(eventPayload) ?? `event-${eventRow.id}`,
              createdAt: eventRow.created_at,
              taskId: eventTaskId,
              category: detectActivityCategory(
                message,
                eventRow.sender_role,
                eventRow.scope,
                eventRow.event_name
              ),
            });
          }

          if (
            eventThreadId &&
            eventTaskId &&
            (eventRow.event_name === "workflow.delegate_task" || eventRow.event_name === "chat.agent_response")
          ) {
            if (eventThreadId === activeChatThreadId) {
              setSelectedTaskId(eventTaskId);
            }
            setChatThreads((previous) =>
              previous.map((thread) =>
                thread.id === eventThreadId
                  ? {
                      ...thread,
                      activeTaskId: eventTaskId,
                      updatedAt: eventRow.created_at,
                    }
                  : thread
              )
            );
          }
        }
      )
      .subscribe();

    return () => {
      disposed = true;
      void supabase.removeChannel(channel);
    };
  }, [activeChatThreadId, activeRoomKey, isMockMode, mounted]);

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

      const { data: playerRows } = await supabase.from("player_state").select("*").eq("room_key", activeRoomKey);
      if (playerRows) {
        const st: Record<string, { status: string; isOnline: boolean }> = {};
        const ty: string[] = [];
        const runtimeFromPlayerState: Record<string, AgentRuntimeStateRow> = {};
        for (const r of playerRows as PlayerStateRow[]) {
          st[r.role] = { status: r.status, isOnline: r.is_online };
          if (isTypingState(r.status, r.typing_until)) ty.push(r.role);
          runtimeFromPlayerState[r.agent_id] = {
            agent_id: r.agent_id,
            status: r.status,
            current_action:
              typeof r.metadata?.reason === "string"
                ? r.metadata.reason
                : typeof r.metadata?.lastReplyAt === "string"
                  ? "Ответ в чате"
                  : null,
            current_skill: null,
            metadata: r.metadata ?? null,
          };
        }
        setPlayerStateByRole(st);
        setTypingRoles(ty);

        let runtimeRows:
          | Array<{
              agent_id?: string;
              status?: string;
              current_action?: string | null;
              current_skill?: string | null;
              current_target_x?: number | null;
              current_target_y?: number | null;
              metadata?: Record<string, unknown> | null;
            }>
          | null = null;

        const runtimeQuery = await supabase
          .from("agent_states")
          .select("agent_id, status, current_action, current_skill, current_target_x, current_target_y, metadata")
          .eq("office_id", activeOfficeId);
        if (runtimeQuery.data) {
          runtimeRows = runtimeQuery.data as Array<{
            agent_id?: string;
            status?: string;
            current_action?: string | null;
            current_skill?: string | null;
            current_target_x?: number | null;
            current_target_y?: number | null;
            metadata?: Record<string, unknown> | null;
          }>;
        } else if (runtimeQuery.error) {
          const fallbackRuntimeQuery = await supabase
            .from("agent_states")
            .select("agent_id, status, current_action, current_skill, current_target_x, current_target_y, metadata");
          runtimeRows = (fallbackRuntimeQuery.data ?? null) as typeof runtimeRows;
        }

        const nextRuntime = { ...runtimeFromPlayerState };
        for (const row of runtimeRows ?? []) {
          const agentId = typeof row.agent_id === "string" ? row.agent_id : "";
          if (!agentId) continue;
          nextRuntime[agentId] = {
            ...(nextRuntime[agentId] ?? { agent_id: agentId, status: "idle" }),
            agent_id: agentId,
            status:
              typeof row.status === "string" && row.status.trim().length > 0
                ? row.status
                : nextRuntime[agentId]?.status ?? "idle",
            current_action:
              typeof row.current_action === "string" && row.current_action.trim().length > 0
                ? row.current_action
                : nextRuntime[agentId]?.current_action ?? null,
            current_skill:
              typeof row.current_skill === "string" && row.current_skill.trim().length > 0
                ? row.current_skill
                : nextRuntime[agentId]?.current_skill ?? null,
            current_target_x:
              typeof row.current_target_x === "number" ? row.current_target_x : nextRuntime[agentId]?.current_target_x ?? null,
            current_target_y:
              typeof row.current_target_y === "number" ? row.current_target_y : nextRuntime[agentId]?.current_target_y ?? null,
            metadata: row.metadata ?? nextRuntime[agentId]?.metadata ?? null,
          };
        }
        setAgentRuntimeStateById(nextRuntime);
      } else {
        setPlayerStateByRole({});
        setTypingRoles([]);
        setAgentRuntimeStateById({});
      }
    };

    refreshData();
    const timer = setInterval(refreshData, 5000);
    return () => clearInterval(timer);
  }, [activeOfficeId, activeRoomKey, mounted]);

  const activeTaskByRole = useMemo(() => {
    const next: Record<
      string,
      {
        taskId: string;
        title: string;
        status: TaskStatus;
        workflowSignal: string | null;
      }
    > = {};

    for (const task of [...taskItems].sort(compareTaskItems)) {
      if (!task.currentAssignee) continue;
      if (task.status !== "in_progress" && task.status !== "review") continue;
      if (next[task.currentAssignee]) continue;

      next[task.currentAssignee] = {
        taskId: task.id,
        title: task.title,
        status: task.status,
        workflowSignal: task.workflowSignal,
      };
    }

    return next;
  }, [taskItems]);

  const activeThreadTaskId = useMemo(
    () => chatThreads.find((thread) => thread.id === activeChatThreadId)?.activeTaskId ?? null,
    [activeChatThreadId, chatThreads]
  );

  const visibleLiveSteps = useMemo(() => {
    return liveToolStatuses
      .filter((step) => {
        if (step.threadId && activeChatThreadId) {
          return step.threadId === activeChatThreadId;
        }
        if (step.taskId && (selectedTaskId || activeThreadTaskId)) {
          return step.taskId === (selectedTaskId ?? activeThreadTaskId);
        }
        return !step.threadId && !step.taskId;
      })
      .slice(0, 6)
      .reverse();
  }, [activeChatThreadId, activeThreadTaskId, liveToolStatuses, selectedTaskId]);

  if (!mounted) return null;

  return (
    <main className="relative h-screen overflow-hidden">
      <div className="p-4 md:p-6 flex h-full min-h-0 flex-col gap-4 md:gap-6 overflow-hidden">
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
          onAddOffice={() => {
            setIsHireAgentOpen(false);
            setIsCreateOfficeOpen(true);
          }}
          onExitToHub={exitToHub}
          stats={{
            agentsCount: agents.length,
            activeTasks: taskItems.filter(t => t.status !== "done").length,
            completedTasks: taskItems.filter(t => t.status === "done").length,
            eventsToday: processFeed.length,
          }}
        />

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => setIsCommandPaletteOpen(true)}
            className="px-3 py-2 rounded-xl border border-red-300/20 bg-black/40 text-[10px] uppercase tracking-[0.18em] text-rose-100/70 hover:text-rose-50 hover:border-red-400/50 transition-all"
          >
            Cmd+K
          </button>
          <button
            onClick={() => setIsInstructionModalOpen(true)}
            className="px-3 py-2 rounded-xl border border-red-300/20 bg-black/40 text-[10px] uppercase tracking-[0.18em] text-rose-100/70 hover:text-rose-50 hover:border-red-400/50 transition-all"
          >
            Instructions
          </button>
          <button
            onClick={() => setIsTaskPanelCollapsed((previous) => !previous)}
            className="px-3 py-2 rounded-xl border border-red-300/20 bg-black/40 text-[10px] uppercase tracking-[0.18em] text-rose-100/70 hover:text-rose-50 hover:border-red-400/50 transition-all"
          >
            {isTaskPanelCollapsed ? "Show Tasks" : "Hide Tasks"}
          </button>
          <button
            onClick={() => setIsChatPanelCollapsed((previous) => !previous)}
            className="px-3 py-2 rounded-xl border border-red-300/20 bg-black/40 text-[10px] uppercase tracking-[0.18em] text-rose-100/70 hover:text-rose-50 hover:border-red-400/50 transition-all"
          >
            {isChatPanelCollapsed ? "Show Chat" : "Hide Chat"}
          </button>
        </div>

        <div className="flex flex-1 gap-6 min-h-0 overflow-hidden">
          {/* Dashboard Left Rail */}
          <motion.aside
            animate={{ width: isTaskPanelCollapsed ? 72 : 320 }}
            transition={{ type: "spring", stiffness: 260, damping: 28 }}
            className="shrink-0 h-full overflow-hidden"
          >
            <div className="h-full flex flex-col gap-3">
              <button
                onClick={() => setIsTaskPanelCollapsed((previous) => !previous)}
                className="h-10 rounded-xl border border-red-300/20 bg-black/45 text-[10px] uppercase tracking-[0.2em] text-rose-100/70 hover:text-rose-50 transition-colors"
              >
                {isTaskPanelCollapsed ? "Tasks" : "Collapse"}
              </button>
              <AnimatePresence initial={false} mode="wait">
                {isTaskPanelCollapsed ? (
                  <motion.button
                    key="task-shortcut"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setIsTaskPanelCollapsed(false)}
                    className="flex-1 rounded-2xl border border-red-300/15 bg-black/35 text-[10px] uppercase tracking-[0.18em] text-rose-100/60 px-2"
                  >
                    {taskItems.length} Tasks
                  </motion.button>
                ) : (
                  <motion.div
                    key="task-full"
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    className="flex-1 min-h-0 flex flex-col gap-3"
                  >
                    <div className="flex-1 min-h-0">
                      <TaskPanel
                        tasks={taskItems as any}
                        selectedTaskId={selectedTaskId}
                        onSelectTask={setSelectedTaskId}
                      />
                    </div>
                    <div className="h-[260px]">
                      <ConsolePanel feed={processFeed as any} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.aside>

          {/* Main Visualizing View */}
          <section className="flex-1 min-w-0 relative flex flex-col glass-card border-none bg-black/20 overflow-hidden rounded-3xl">
            <div className="absolute inset-0 z-0">
               <OfficeHub 
                 agents={agents}
                 taskStatus={taskStatus}
                 speakingAgentId={speakingAgentId}
                 interactionTargetRole={interactionTargetRole}
                 agentTokenUsage={agentTokenUsage}
                 agentRuntimeState={agentRuntimeStateById as any}
                 activeTaskByRole={activeTaskByRole}
                 officeName={activeOfficeName}
                 roomKey={activeRoomKey}
                 activeThreadId={activeChatThreadId}
               />
            </div>

            <div className="absolute top-4 right-4 z-20 flex gap-2">
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
                  onClick={() => setIsCommandPaletteOpen(true)}
                  className="px-3 py-2 rounded-xl border border-red-200/20 bg-black/55 text-[10px] uppercase tracking-[0.2em] text-rose-100/70 hover:text-rose-50 transition-all"
                >
                  Cmd+K
                </button>
                <button 
                  onClick={() => {
                    setIsCreateOfficeOpen(false);
                    setIsHireAgentOpen(true);
                  }}
                  className="p-2.5 rounded-xl border border-red-200/10 bg-red-600/20 text-red-500 hover:scale-110 active:scale-95 transition-all shadow-lg shadow-red-900/20"
                >
                 <IconPlus />
               </button>
            </div>
            
             {activeView === "kanban" && (
               <div className="absolute inset-0 z-10 bg-black/80 backdrop-blur-xl overflow-auto p-8">
                  <OfficeKanbanBoard
                    tasks={taskItems as any}
                    selectedTaskId={selectedTaskId}
                    onSelectTask={(id) => {
                      setSelectedTaskId(id);
                      setActiveView("office");
                    }}
                    onMoveTask={handleKanbanMoveTask}
                    onDeleteTask={handleKanbanDeleteTask}
                  />
               </div>
             )}
          </section>

          {/* OperChat Command Panel */}
          <motion.aside
            animate={{ width: isChatPanelCollapsed ? 72 : 400 }}
            transition={{ type: "spring", stiffness: 260, damping: 28 }}
            className="shrink-0 h-full overflow-hidden"
          >
            <div className="h-full flex flex-col gap-3">
              <button
                onClick={() => setIsChatPanelCollapsed((previous) => !previous)}
                className="h-10 rounded-xl border border-red-300/20 bg-black/45 text-[10px] uppercase tracking-[0.2em] text-rose-100/70 hover:text-rose-50 transition-colors"
              >
                {isChatPanelCollapsed ? "Chat" : "Collapse"}
              </button>
              <AnimatePresence initial={false} mode="wait">
                {isChatPanelCollapsed ? (
                  <motion.button
                    key="chat-shortcut"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setIsChatPanelCollapsed(false)}
                    className="flex-1 rounded-2xl border border-red-300/15 bg-black/35 text-[10px] uppercase tracking-[0.18em] text-rose-100/60 px-2"
                  >
                    Open Chat
                  </motion.button>
                ) : (
                  <motion.div
                    key="chat-full"
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12 }}
                    className="flex-1 min-h-0"
                  >
                    <ChatPanel
                      messages={visibleChatMessages as any}
                      liveSteps={visibleLiveSteps as any}
                      agents={agents as any}
                      activeOfficeId={activeOfficeId}
                      activeOfficeName={activeOfficeName}
                      threads={chatThreads}
                      activeThreadId={activeChatThreadId}
                      threadLoading={isChatThreadLoading}
                      loading={chatLoading}
                      typingLabel={typingLabel}
                      onSelectThread={handleSelectThread}
                      onCreateThread={handleCreateThread}
                      onOpenAgentInstructions={() => setIsInstructionModalOpen(true)}
                      onSendMessage={(content) => {
                        setChatInput(content);
                        sendMessageToAgents(content, chatTargetRole);
                      }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.aside>
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
            detail: `${repairTextForDisplay(agent.name)} (${agent.role}) добавлен в офис.`,
            time: formatProcessTime(),
            tone: "ok",
            category: "system",
          });
        }}
      />

      {/* Location Creator */}
      {isCreateOfficeOpen && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
            <div className="relative w-full max-w-md glass-card bg-[#0e0708] p-8 space-y-6 rounded-3xl border border-red-500/20 shadow-[0_32px_64px_rgba(0,0,0,0.5)]">
               <button 
                 onClick={() => setIsCreateOfficeOpen(false)}
                 className="absolute top-6 right-6 text-rose-100/30 hover:text-white transition-colors"
               >
                 <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                   <path d="M18 6L6 18M6 6l12 12" />
                 </svg>
               </button>

               <div>
                 <h2 className="text-xl font-bold text-red-50">Создать департамент</h2>
                 <p className="mt-1 text-sm text-rose-100/40">Разверните новую рабочую область</p>
               </div>

               <div className="space-y-4">
                 <div className="space-y-2">
                   <label className="text-[10px] uppercase font-bold text-rose-100/30 tracking-widest pl-1">Имя юнита</label>
                   <input 
                     value={newOfficeName} 
                     onChange={e => setNewOfficeName(e.target.value)}
                     placeholder="Напр. Отдел Разработки..."
                     className="w-full bg-black/40 border border-red-200/10 rounded-xl px-4 py-3 text-white outline-none focus:border-red-500/40 transition-all font-medium"
                   />
                 </div>
               </div>

               <div className="flex gap-4 pt-4">
                  <button 
                    onClick={() => setIsCreateOfficeOpen(false)} 
                    className="flex-1 py-3 text-rose-100/40 hover:text-rose-100/80 hover:bg-white/5 rounded-xl font-bold transition-all text-sm"
                  >
                    Отмена
                  </button>
                  <button 
                    onClick={createOffice} 
                    disabled={!newOfficeName.trim() || isCreatingOffice} 
                    className="flex-1 py-3 bg-gradient-to-br from-red-600 to-violet-600 rounded-xl font-bold text-white shadow-xl shadow-red-900/30 hover:scale-[1.02] active:scale-[0.98] transition-all text-sm disabled:grayscale disabled:opacity-50"
                  >
                     {isCreatingOffice ? "Создание..." : "Создать"}
                  </button>
               </div>
            </div>
        </div>
      )}

      {isInstructionModalOpen && (
        <div
          className="fixed inset-0 z-[1300] bg-black/80 backdrop-blur-md p-4"
          onClick={() => {
            setIsInstructionModalOpen(false);
            resetInstructionForm();
          }}
        >
          <div
            className="mx-auto flex h-full max-h-[92vh] w-full max-w-6xl flex-col rounded-3xl border border-red-400/25 bg-[#10080b] shadow-[0_28px_70px_rgba(0,0,0,0.6)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-red-300/20 px-6 py-4">
              <div>
                <h2 className="text-lg font-bold text-red-50">Инструкция агенту</h2>
                <p className="mt-1 text-xs text-rose-100/55">
                  Общий и адресный контекст для роли или конкретного агента.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsInstructionModalOpen(false);
                  resetInstructionForm();
                }}
                className="rounded-xl border border-red-300/25 bg-black/45 px-3 py-2 text-xs uppercase tracking-[0.14em] text-rose-100/70 hover:text-rose-50"
              >
                Закрыть
              </button>
            </div>

            <div className="grid flex-1 min-h-0 gap-4 p-4 md:grid-cols-[1.1fr_1fr]">
              <section className="min-h-0 overflow-y-auto rounded-2xl border border-red-300/20 bg-black/35 p-4 space-y-3">
                <h3 className="text-sm font-semibold text-red-50">
                  {editingContextId ? "Редактирование инструкции" : "Новая инструкция"}
                </h3>
                <input
                  value={contextTitleInput}
                  onChange={(event) => setContextTitleInput(event.target.value)}
                  placeholder="Название"
                  className="w-full rounded-xl border border-red-200/20 bg-black/45 px-3 py-2 text-sm text-rose-50 outline-none focus:border-red-400/50"
                />
                <textarea
                  value={contextTextInput}
                  onChange={(event) => setContextTextInput(event.target.value)}
                  placeholder="Что агент должен учитывать при ответе..."
                  className="min-h-[140px] w-full resize-y rounded-xl border border-red-200/20 bg-black/45 px-3 py-2 text-sm text-rose-50 outline-none focus:border-red-400/50"
                />

                <div className="space-y-3 rounded-2xl border border-red-300/15 bg-black/25 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-rose-100/55">
                        Reference Images
                      </div>
                      <div className="mt-1 text-[11px] text-rose-100/45">
                        Загружайте логотипы и визуальные референсы. Они сохранятся в инструкции без ручного вставления manifest-блоков.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => instructionAssetInputRef.current?.click()}
                      disabled={isInstructionAssetUploading || !activeOfficeId}
                      className="rounded-xl border border-red-300/25 bg-black/45 px-3 py-2 text-[11px] uppercase tracking-[0.14em] text-rose-100/75 disabled:opacity-40"
                    >
                      {isInstructionAssetUploading ? "Загрузка..." : "Добавить файл"}
                    </button>
                  </div>

                  <div className="grid gap-2 md:grid-cols-[140px_1fr]">
                    <select
                      value={contextAssetKindInput}
                      onChange={(event) => setContextAssetKindInput(event.target.value)}
                      className="rounded-xl border border-red-200/20 bg-black/45 px-3 py-2 text-xs text-rose-50 outline-none focus:border-red-400/50"
                    >
                      <option value="logo">Logo</option>
                      <option value="reference">Reference</option>
                      <option value="product">Product</option>
                      <option value="character">Character</option>
                    </select>
                    <input
                      value={contextAssetLabelInput}
                      onChange={(event) => setContextAssetLabelInput(event.target.value)}
                      placeholder="Название референса, например Centras official logo"
                      className="rounded-xl border border-red-200/20 bg-black/45 px-3 py-2 text-xs text-rose-50 outline-none focus:border-red-400/50"
                    />
                  </div>

                  <input
                    ref={instructionAssetInputRef}
                    type="file"
                    accept="image/*"
                    onChange={uploadInstructionAsset}
                    className="hidden"
                  />

                  {contextReferenceAssetsInput.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {contextReferenceAssetsInput.map((asset) => (
                        <div
                          key={`instruction-asset-${asset.storagePath}`}
                          className="rounded-xl border border-red-300/20 bg-black/45 p-3"
                        >
                          {asset.url ? (
                            <img
                              src={asset.url}
                              alt={asset.label}
                              className="h-28 w-full rounded-lg border border-red-300/15 object-contain bg-black/35"
                            />
                          ) : null}
                          <div className="mt-2 flex items-start justify-between gap-2">
                            <div>
                              <div className="text-sm font-medium text-rose-50">
                                {repairTextForDisplay(asset.label)}
                              </div>
                              <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-rose-100/45">
                                {getReferenceAssetKindLabel(asset.kind)}
                              </div>
                              <div className="mt-1 text-[11px] text-rose-100/55 break-words">
                                {repairTextForDisplay(asset.fileName)}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeContextReferenceAsset(asset.storagePath)}
                              className="rounded-lg border border-red-300/20 bg-black/45 px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-rose-100/65"
                            >
                              Убрать
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-red-300/15 bg-black/20 px-3 py-4 text-xs text-rose-100/45">
                      Пока нет reference assets. Если загрузите официальный логотип или референс, агент сможет учитывать его в инструкциях и creative briefs.
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-[0.14em] text-rose-100/55">Роли</div>
                  <div className="flex flex-wrap gap-2">
                    {workflowRoleOptions.map((role) => (
                      <button
                        key={`instruction-role-${role}`}
                        type="button"
                        onClick={() => toggleRoleInInstructionForm(role)}
                        className={`rounded-lg border px-2.5 py-1 text-[11px] ${
                          contextRolesInput.includes(role)
                            ? "border-red-400/60 bg-red-500/20 text-red-50"
                            : "border-red-200/25 bg-black/45 text-rose-100/70"
                        }`}
                      >
                        {role}
                      </button>
                    ))}
                  </div>
                  <input
                    value={contextRoleCsvInput}
                    onChange={(event) => setContextRoleCsvInput(event.target.value)}
                    placeholder="Доп. роли через запятую (например: Dev-Ker, CMM)"
                    className="w-full rounded-lg border border-red-200/20 bg-black/45 px-3 py-2 text-xs text-rose-50 outline-none focus:border-red-400/50"
                  />
                </div>

                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-[0.14em] text-rose-100/55">Агенты</div>
                  <div className="flex flex-wrap gap-2">
                    {agents.map((agent) => (
                      <button
                        key={`instruction-agent-${agent.id}`}
                        type="button"
                        onClick={() => toggleAgentInInstructionForm(agent.id)}
                        className={`rounded-lg border px-2.5 py-1 text-[11px] ${
                          contextAgentIdsInput.includes(agent.id)
                            ? "border-red-400/60 bg-red-500/20 text-red-50"
                            : "border-red-200/25 bg-black/45 text-rose-100/70"
                        }`}
                        title={agent.role}
                      >
                        {agent.name}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs text-rose-100/70">
                  <input
                    type="checkbox"
                    checked={contextIsActiveInput}
                    onChange={(event) => setContextIsActiveInput(event.target.checked)}
                    className="accent-red-500"
                  />
                  Инструкция активна
                </label>

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={saveAgentInstruction}
                    disabled={
                      isContextSaving ||
                      !contextTitleInput.trim() ||
                      (contextTextInput.trim().length === 0 && contextReferenceAssetsInput.length === 0)
                    }
                    className="rounded-xl border border-red-500/50 bg-red-500/20 px-3 py-2 text-xs uppercase tracking-[0.14em] text-red-50 disabled:opacity-40"
                  >
                    {isContextSaving ? "Сохранение..." : editingContextId ? "Сохранить" : "Добавить"}
                  </button>
                  <button
                    type="button"
                    onClick={resetInstructionForm}
                    className="rounded-xl border border-red-300/25 bg-black/45 px-3 py-2 text-xs uppercase tracking-[0.14em] text-rose-100/70"
                  >
                    Очистить
                  </button>
                </div>
              </section>

              <section className="min-h-0 overflow-y-auto rounded-2xl border border-red-300/20 bg-black/35 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-red-50">Список инструкций</h3>
                  <span className="text-xs text-rose-100/55">
                    {isContextLoading ? "Загрузка..." : `${agentContexts.length} шт.`}
                  </span>
                </div>
                <div className="space-y-3">
                  {agentContexts.map((context) => (
                    <div
                      key={context.id}
                      className="rounded-xl border border-red-300/20 bg-black/50 p-3"
                    >
                      {(() => {
                        const referenceAssets =
                          Array.isArray(context.referenceAssets) && context.referenceAssets.length > 0
                            ? context.referenceAssets
                            : parseAgentContextReferenceAssets(context.contextText);
                        const cleanContextText = stripAgentContextReferenceAssets(context.contextText);

                        return (
                          <>
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-rose-50">
                            {repairTextForDisplay(context.title)}
                          </div>
                          {cleanContextText ? (
                            <div className="mt-1 text-xs text-rose-100/70 whitespace-pre-wrap break-words">
                              {repairTextForDisplay(cleanContextText)}
                            </div>
                          ) : (
                            <div className="mt-1 text-xs text-rose-100/45">
                              Только reference assets без дополнительного текста.
                            </div>
                          )}
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] ${
                            context.isActive
                              ? "bg-emerald-500/20 text-emerald-100 border border-emerald-400/40"
                              : "bg-black/45 text-rose-100/55 border border-red-200/20"
                          }`}
                        >
                          {context.isActive ? "active" : "off"}
                        </span>
                      </div>

                      {referenceAssets.length > 0 ? (
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {referenceAssets.map((asset) => (
                            <div
                              key={`context-list-asset-${context.id}-${asset.storagePath}`}
                              className="rounded-xl border border-red-300/15 bg-black/35 p-2"
                            >
                              {asset.url ? (
                                <img
                                  src={asset.url}
                                  alt={asset.label}
                                  className="h-24 w-full rounded-lg border border-red-300/10 object-contain bg-black/30"
                                />
                              ) : null}
                              <div className="mt-2 text-xs font-medium text-rose-50">
                                {repairTextForDisplay(asset.label)}
                              </div>
                              <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-rose-100/45">
                                {getReferenceAssetKindLabel(asset.kind)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div className="mt-2 text-[11px] text-rose-100/60">
                        Роли: {context.targetRoles.length > 0 ? context.targetRoles.map((role) => repairTextForDisplay(role)).join(", ") : "Все"}
                      </div>
                      <div className="mt-1 text-[11px] text-rose-100/60">
                        Агенты:{" "}
                        {context.targetAgentIds.length > 0
                          ? context.targetAgentIds
                              .map((agentId) => repairTextForDisplay(agents.find((agent) => agent.id === agentId)?.name ?? agentId.slice(0, 8)))
                              .join(", ")
                          : "Все"}
                      </div>

                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => applyContextToForm(context)}
                          className="rounded-lg border border-red-300/25 bg-black/45 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-rose-100/75"
                        >
                          Изменить
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleInstructionActive(context)}
                          className="rounded-lg border border-red-300/25 bg-black/45 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-rose-100/75"
                        >
                          {context.isActive ? "Выключить" : "Включить"}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteInstruction(context.id)}
                          className="rounded-lg border border-red-500/40 bg-red-500/15 px-2.5 py-1 text-[11px] uppercase tracking-[0.12em] text-red-100"
                        >
                          Удалить
                        </button>
                      </div>
                          </>
                        );
                      })()}
                    </div>
                  ))}
                  {agentContexts.length === 0 && !isContextLoading ? (
                    <div className="rounded-xl border border-red-300/15 bg-black/35 px-3 py-6 text-center text-sm text-rose-100/55">
                      Инструкций пока нет.
                    </div>
                  ) : null}
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {isCommandPaletteOpen && (
          <motion.div
            className="fixed inset-0 z-[1400] bg-black/70 backdrop-blur-sm p-4 md:p-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsCommandPaletteOpen(false)}
          >
            <motion.div
              className="mx-auto max-w-2xl rounded-2xl border border-red-300/30 bg-[#11080c] shadow-[0_24px_80px_rgba(0,0,0,0.55)] overflow-hidden"
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 24, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="px-4 py-3 border-b border-red-300/20 bg-black/40">
                <input
                  autoFocus
                  value={commandQuery}
                  onChange={(event) => setCommandQuery(event.target.value)}
                  placeholder="Search agents, tasks, MCP tools..."
                  className="w-full bg-black/40 border border-red-200/20 rounded-xl px-4 py-3 text-sm text-white placeholder:text-rose-100/25 outline-none focus:border-red-500/40 transition-all"
                />
              </div>
              <div className="max-h-[420px] overflow-y-auto p-3 space-y-2">
                {filteredCommandOptions.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-rose-100/50">
                    No matching commands.
                  </div>
                ) : (
                  filteredCommandOptions.map((option) => (
                    <button
                      key={option.id}
                      onClick={() => executeCommandPaletteOption(option)}
                      className="w-full text-left rounded-xl border border-red-300/15 bg-black/35 px-3 py-3 hover:border-red-400/45 hover:bg-red-600/10 transition-all"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-rose-50">{option.label}</span>
                        <span className="text-[10px] uppercase tracking-[0.2em] text-red-200/65">
                          {option.kind}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-rose-100/45">{option.hint}</div>
                    </button>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

