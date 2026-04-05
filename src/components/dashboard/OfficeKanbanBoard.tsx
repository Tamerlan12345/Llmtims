"use client";

import { useMemo, useState } from "react";
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
    status?: string | null;
    downloadUrl: string;
  }>;
  workflowMode?: "autonomous" | "manual";
  manualWorkflowRoles?: string[];
}

interface OfficeKanbanBoardProps {
  tasks: KanbanTaskItem[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onMoveTask: (taskId: string, nextStatus: TaskStatus) => void;
  onDeleteTask: (taskId: string) => Promise<void>;
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

const statusLabel: Record<TaskStatus, string> = {
  pending: "Ожидание",
  waiting_approval: "Подтверждение",
  in_progress: "В работе",
  review: "Ревью",
  done: "Готово",
  failed: "Сбой",
};

const compactWorkflowLabel = (task: KanbanTaskItem) => {
  if (task.workflowMode !== "manual" || !Array.isArray(task.manualWorkflowRoles) || task.manualWorkflowRoles.length === 0) {
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
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Record<string, true>>({});

  const tasksByColumn = useMemo(() => {
    return COLUMNS.map((column) => ({
      ...column,
      tasks: tasks.filter(
        (task) =>
          task.status !== "archived" &&
          !pendingDeleteIds[task.id] &&
          column.statuses.includes(task.status)
      ),
    }));
  }, [pendingDeleteIds, tasks]);

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
          <div className="text-[10px] uppercase tracking-[0.2em] text-rose-100/55">
            Канбан-доска
          </div>
          <div className="mt-1 text-sm text-rose-50">
            Бэклог, выполнение, ревью и возврат на доработку в одной доске.
          </div>
        </div>
        <div className="text-[11px] text-rose-100/60">
          Перетаскивайте карточки между колонками
        </div>
      </div>

      <div className="mt-4 overflow-x-auto snap-x">
        <div className="grid min-w-[920px] gap-3 xl:min-w-0 xl:grid-cols-4">
          {tasksByColumn.map((column) => (
          <div
            key={column.key}
            className="min-h-[220px] snap-start rounded-xl p-3"
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
              {column.tasks.length === 0 && (
                <div
                  className="rounded-lg px-3 py-4 text-xs text-rose-100/45"
                  style={{
                    background: "rgba(8,2,6,0.58)",
                    border: "1px dashed rgba(194,21,90,0.22)",
                  }}
                >
                  В этой колонке пока нет карточек.
                </div>
              )}

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
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={async (event) => {
                            event.stopPropagation();
                            setPendingDeleteIds((previous) => ({ ...previous, [task.id]: true }));
                            try {
                              await onDeleteTask(task.id);
                            } catch (error) {
                              console.error("[OfficeKanbanBoard] failed to delete task:", error);
                              setPendingDeleteIds((previous) => {
                                const next = { ...previous };
                                delete next[task.id];
                                return next;
                              });
                            }
                          }}
                          className="rounded-md border border-red-300/20 bg-black/35 p-1 text-rose-100/65 transition hover:border-red-300/45 hover:text-red-100 md:opacity-0 md:group-hover:opacity-100"
                          aria-label="Удалить задачу"
                          title="Удалить задачу"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                            <path d="M10 11v6M14 11v6" />
                            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                          </svg>
                        </button>
                        <div className="text-[10px] text-rose-100/46">{task.id.slice(0, 8)}</div>
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
                          background: task.workflowMode === "manual" ? "rgba(251,146,60,0.16)" : "rgba(16,185,129,0.16)",
                          color: "rgba(255,220,228,0.92)",
                        }}
                      >
                        {task.workflowMode === "manual" ? "Ручной" : "CEO"}
                      </span>
                      <span
                        className="rounded-md px-2 py-1"
                        style={{ background: "rgba(194,21,90,0.10)", color: "rgba(255,220,228,0.78)" }}
                      >
                        {statusLabel[task.status]}
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

                    <div className="mt-2 text-[11px] text-rose-100/55">
                      {compactWorkflowLabel(task)}
                    </div>

                    {task.attachmentsCount ? (
                      <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
                        <div className="text-[10px] uppercase tracking-[0.14em] text-rose-100/60">
                          Вложения ({task.attachmentsCount})
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(task.attachmentsPreview ?? []).map((attachment) => (
                            <a
                              key={attachment.id}
                              href={attachment.downloadUrl}
                              download={attachment.title}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(event) => event.stopPropagation()}
                              className="rounded-md border border-red-300/20 bg-red-500/10 px-2 py-1 text-[10px] text-rose-50/90 hover:bg-red-500/15"
                            >
                              {attachment.status === "processing" ? (
                                <span className="mr-1 inline-block h-2.5 w-2.5 animate-spin rounded-full border border-rose-100/70 border-t-transparent align-middle" />
                              ) : null}
                              {attachment.artifactType ? `${attachment.artifactType.toUpperCase()}: ` : ""}
                              {repairTextForDisplay(attachment.title)}
                            </a>
                          ))}
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
      </div>
    </section>
  );
}
