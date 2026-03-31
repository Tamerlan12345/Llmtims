"use client";

import { useMemo } from "react";
import { TaskStatus } from "@/lib/office/engine";

export interface KanbanTaskItem {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  targetRole?: string | null;
  workflowMode?: "autonomous" | "manual";
  manualWorkflowRoles?: string[];
}

interface OfficeKanbanBoardProps {
  tasks: KanbanTaskItem[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onMoveTask: (taskId: string, nextStatus: TaskStatus) => void;
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
    title: "Backlog",
    statuses: ["pending", "waiting_approval"],
    accent: "#f59e0b",
  },
  {
    key: "in_progress",
    title: "In Progress",
    statuses: ["in_progress"],
    accent: "#e11d48",
  },
  {
    key: "review",
    title: "Review",
    statuses: ["review"],
    accent: "#fb923c",
  },
  {
    key: "done",
    title: "Done",
    statuses: ["done", "failed"],
    accent: "#10b981",
  },
];

const statusLabel: Record<TaskStatus, string> = {
  pending: "Ожидание",
  waiting_approval: "Подтверждение",
  in_progress: "В работе",
  review: "Review",
  done: "Done",
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
}: OfficeKanbanBoardProps) {
  const tasksByColumn = useMemo(() => {
    return COLUMNS.map((column) => ({
      ...column,
      tasks: tasks.filter((task) => column.statuses.includes(task.status)),
    }));
  }, [tasks]);

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
            Trello Dashboard
          </div>
          <div className="mt-1 text-sm text-rose-50">
            Backlog, выполнение, review и возврат на доработку в одной доске.
          </div>
        </div>
        <div className="text-[11px] text-rose-100/60">
          Перетаскивайте карточки между колонками
        </div>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-4">
        {tasksByColumn.map((column) => (
          <div
            key={column.key}
            className="min-h-[220px] rounded-xl p-3"
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
                return (
                  <button
                    key={task.id}
                    type="button"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", task.id);
                    }}
                    onClick={() => onSelectTask(task.id)}
                    className="block w-full rounded-xl px-3 py-3 text-left transition-transform active:scale-[0.99]"
                    style={{
                      background: isSelected ? "rgba(194,21,90,0.18)" : "rgba(8,2,6,0.78)",
                      border: isSelected
                        ? "1px solid rgba(244,114,182,0.45)"
                        : "1px solid rgba(194,21,90,0.20)",
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-rose-50">{task.title}</div>
                        <div className="mt-1 line-clamp-2 text-xs text-rose-100/62">
                          {task.description || "Задача без описания"}
                        </div>
                      </div>
                      <div className="text-[10px] text-rose-100/46">{task.id.slice(0, 8)}</div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] uppercase tracking-[0.14em]">
                      <span
                        className="rounded-md px-2 py-1"
                        style={{ background: "rgba(194,21,90,0.12)", color: "rgba(255,220,228,0.92)" }}
                      >
                        {task.targetRole || "All"}
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
                    </div>

                    <div className="mt-2 text-[11px] text-rose-100/55">
                      {compactWorkflowLabel(task)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
