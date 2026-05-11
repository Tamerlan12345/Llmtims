"use client";

import { useMemo } from "react";
import { IconSpinner } from "@/components/icons";
import { TaskStatus } from "@/lib/office/engine";
import { repairTextForDisplay } from "@/lib/text/repairMojibake";

export interface KanbanTaskItem {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  targetRole?: string | null;
  currentAssignee?: string | null;
  assignedAgentId?: string | null;
  workflowSignal?: string | null;
  attachmentsCount?: number;
  attachmentsPreview?: Array<{
    id: string;
    title: string;
    artifactType: string | null;
    status: "ready" | "processing" | "failed";
    downloadUrl: string | null;
  }>;
  workflowMode?: "autonomous" | "manual";
  manualWorkflowRoles?: string[];
}

interface OfficeKanbanBoardProps {
  tasks: KanbanTaskItem[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onMoveTask: (taskId: string, nextStatus: TaskStatus) => void;
  onDeleteTask: (taskId: string) => void;
}

interface ColumnConfig {
  key: "backlog" | "in_progress" | "review" | "done";
  title: string;
  statuses: TaskStatus[];
  accent: string;
}

const COLUMNS: ColumnConfig[] = [
  {
    key: "backlog",
    title: "Бэклог",
    statuses: ["pending", "waiting_approval"],
    accent: "#f59e0b",
  },
  {
    key: "in_progress",
    title: "В работе",
    statuses: ["in_progress"],
    accent: "#e11d48",
  },
  {
    key: "review",
    title: "Ревью",
    statuses: ["review"],
    accent: "#fb923c",
  },
  {
    key: "done",
    title: "Готово",
    statuses: ["done", "failed"],
    accent: "#10b981",
  },
];

const statusLabel: Record<string, string> = {
  pending: "Ожидание",
  waiting_approval: "Подтверждение",
  in_progress: "В работе",
  review: "Ревью",
  done: "Готово",
  failed: "Ошибка",
  archived: "Архив",
};

const TrashIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14H6L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
);

const compactWorkflowLabel = (task: KanbanTaskItem) => {
  if (
    task.workflowMode !== "manual" ||
    !Array.isArray(task.manualWorkflowRoles) ||
    task.manualWorkflowRoles.length === 0
  ) {
    return "Маршрут определяет CEO";
  }

  return task.manualWorkflowRoles.join(" -> ");
};

export default function OfficeKanbanBoard({
  tasks,
  selectedTaskId,
  onSelectTask,
  onMoveTask,
  onDeleteTask,
}: OfficeKanbanBoardProps) {
  const visibleTasks = useMemo(() => tasks.filter((task) => task.status !== "archived"), [tasks]);

  const tasksByColumn = useMemo(() => {
    return COLUMNS.map((column) => ({
      ...column,
      tasks: visibleTasks.filter((task) => column.statuses.includes(task.status)),
    }));
  }, [visibleTasks]);

  return (
    <section
      className="rounded-xl px-4 py-4"
      style={{
        background: "rgba(8,2,6,0.76)",
        border: "1px solid rgba(194,21,90,0.24)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-rose-100/55">Канбан-доска</div>
          <div className="mt-1 text-sm text-rose-50">
            Бэклог, выполнение, ревью и возврат на доработку в одной доске.
          </div>
        </div>
        <div className="text-[11px] text-rose-100/60">Перетаскивайте карточки между колонками</div>
      </div>

      <div className="mt-4 flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory xl:grid xl:grid-cols-4 xl:overflow-visible xl:pb-0">
        {tasksByColumn.map((column) => (
          <div
            key={column.key}
            className="min-h-[220px] min-w-[280px] shrink-0 snap-start rounded-xl p-3 xl:min-w-0"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const taskId = event.dataTransfer.getData("text/plain");
              if (!taskId) return;
              const fallbackStatus = column.statuses[0];
              if (!fallbackStatus) return;
              onMoveTask(taskId, fallbackStatus);
            }}
            style={{
              background: "rgba(0,0,0,0.42)",
              border: `1px solid ${column.accent}33`,
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: column.accent }}>
                {column.title}
              </div>
              <div
                className="rounded-md px-2 py-1 text-[10px]"
                style={{ background: `${column.accent}1a`, color: "#ffe4ea" }}
              >
                {column.tasks.length}
              </div>
            </div>

            <div className="mt-3 space-y-2">
              {column.tasks.length === 0 ? (
                <div
                  className="rounded-lg px-3 py-4 text-xs text-rose-100/45"
                  style={{
                    background: "rgba(8,2,6,0.58)",
                    border: "1px dashed rgba(194,21,90,0.22)",
                  }}
                >
                  В этой колонке пока нет карточек.
                </div>
              ) : null}

              {column.tasks.map((task) => {
                const isSelected = selectedTaskId === task.id;
                const isRejected = task.workflowSignal === "rejected";

                return (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", task.id);
                    }}
                    onClick={() => onSelectTask(task.id)}
                    className="group block w-full cursor-pointer rounded-xl px-3 py-3 text-left transition-transform active:scale-[0.99]"
                    style={{
                      background: isSelected ? "rgba(194,21,90,0.18)" : "rgba(8,2,6,0.78)",
                      border: isRejected
                        ? "1px solid rgba(248,113,113,0.55)"
                        : isSelected
                          ? "1px solid rgba(244,114,182,0.45)"
                          : "1px solid rgba(194,21,90,0.20)",
                      boxShadow: isRejected ? "0 0 0 1px rgba(248,113,113,0.18) inset" : undefined,
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-rose-50">
                          {repairTextForDisplay(task.title)}
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs text-rose-100/62">
                          {repairTextForDisplay(task.description) || "Задача без описания"}
                        </div>
                      </div>
                      <div className="flex items-start gap-2">
                        <div className="text-[10px] text-rose-100/46">{task.id.slice(0, 8)}</div>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteTask(task.id);
                          }}
                          className="rounded-md border border-red-300/20 bg-black/35 p-1 text-rose-100/72 transition hover:border-red-400/45 hover:text-rose-50 sm:opacity-0 sm:group-hover:opacity-100"
                          aria-label="Archive task"
                          title="Archive task"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-[0.14em]">
                      <span
                        className="rounded-md px-2 py-1"
                        style={{ background: "rgba(194,21,90,0.12)", color: "rgba(255,220,228,0.92)" }}
                      >
                        {repairTextForDisplay(task.targetRole || "All")}
                      </span>
                      <span
                        className="rounded-md px-2 py-1"
                        style={{
                          background:
                            task.workflowMode === "manual"
                              ? "rgba(251,146,60,0.16)"
                              : "rgba(16,185,129,0.16)",
                          color: "rgba(255,220,228,0.92)",
                        }}
                      >
                        {task.workflowMode === "manual" ? "Ручной" : "CEO"}
                      </span>
                      <span
                        className="rounded-md px-2 py-1"
                        style={{ background: "rgba(194,21,90,0.10)", color: "rgba(255,220,228,0.78)" }}
                      >
                        {statusLabel[task.status] ?? repairTextForDisplay(task.status)}
                      </span>
                      {task.currentAssignee ? (
                        <span
                          className="rounded-md px-2 py-1"
                          style={{ background: "rgba(251,113,133,0.16)", color: "rgba(255,241,243,0.92)" }}
                        >
                          {repairTextForDisplay(task.currentAssignee)}
                        </span>
                      ) : null}
                      {isRejected ? (
                        <span
                          className="rounded-md px-2 py-1"
                          style={{ background: "rgba(248,113,113,0.16)", color: "rgba(255,230,230,0.94)" }}
                        >
                          Возврат
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-2 text-[11px] text-rose-100/55">{compactWorkflowLabel(task)}</div>

                    {task.attachmentsCount ? (
                      <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
                        <div className="text-[10px] uppercase tracking-[0.14em] text-rose-100/60">
                          Вложения ({task.attachmentsCount})
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(task.attachmentsPreview ?? []).map((attachment) => {
                            if (attachment.status === "processing") {
                              return (
                                <span
                                  key={attachment.id}
                                  className="inline-flex items-center gap-1 rounded-md border border-amber-300/25 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-100"
                                >
                                  <IconSpinner />
                                  {attachment.artifactType ? `${attachment.artifactType.toUpperCase()}: ` : ""}
                                  {repairTextForDisplay(attachment.title)}
                                </span>
                              );
                            }

                            if (!attachment.downloadUrl) {
                              return (
                                <span
                                  key={attachment.id}
                                  className="rounded-md border border-red-300/20 bg-red-500/10 px-2 py-1 text-[10px] text-rose-50/90"
                                >
                                  {attachment.artifactType ? `${attachment.artifactType.toUpperCase()}: ` : ""}
                                  {repairTextForDisplay(attachment.title)}
                                </span>
                              );
                            }

                            return (
                              <a
                                key={attachment.id}
                                href={attachment.downloadUrl}
                                download={attachment.title}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(event) => event.stopPropagation()}
                                className="rounded-md border border-red-300/20 bg-red-500/10 px-2 py-1 text-[10px] text-rose-50/90 hover:bg-red-500/15"
                              >
                                {attachment.artifactType ? `${attachment.artifactType.toUpperCase()}: ` : ""}
                                {repairTextForDisplay(attachment.title)}
                              </a>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
