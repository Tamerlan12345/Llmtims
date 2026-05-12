"use client";

import React from "react";
import { TaskItem } from "@/app/dashboard/types";
import { IconSpinner } from "@/components/icons";
import { repairTextForDisplay } from "@/lib/text/repairMojibake";

interface TaskPanelProps {
  tasks: TaskItem[];
  onSelectTask: (taskId: string) => void;
  selectedTaskId: string | null;
}

const statusColors: Record<string, string> = {
  pending: "rgba(255,255,255,0.05)",
  waiting_approval: "rgba(245,158,11,0.1)",
  in_progress: "rgba(194,21,90,0.1)",
  review: "rgba(123,47,190,0.1)",
  done: "rgba(16,185,129,0.1)",
  failed: "rgba(232,0,30,0.1)",
};

const statusBorders: Record<string, string> = {
  pending: "rgba(255,255,255,0.15)",
  waiting_approval: "rgba(245,158,11,0.35)",
  in_progress: "rgba(194,21,90,0.4)",
  review: "rgba(123,47,190,0.4)",
  done: "rgba(16,185,129,0.4)",
  failed: "rgba(232,0,30,0.4)",
};

const statusLabels: Record<string, string> = {
  pending: "Ожидает",
  waiting_approval: "Ждет approval",
  in_progress: "В работе",
  review: "Ревью",
  done: "Готово",
  failed: "Ошибка",
};

const statusTone = (status: string) => {
  if (status === "done") return "text-emerald-400";
  if (status === "failed") return "text-red-400";
  if (status === "waiting_approval") return "text-amber-300";
  return "text-rose-100/60";
};

export default function TaskPanel({ tasks, onSelectTask, selectedTaskId }: TaskPanelProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden border-none bg-black/40 glass-card">
      <div className="flex items-center justify-between border-b border-red-200/10 bg-black/20 p-4">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-red-50">
          Активные задачи <span className="font-mono text-[10px] text-rose-100/40">[{tasks.length}]</span>
        </h2>
      </div>

      <div className="chat-scroll custom-scrollbar flex-1 space-y-2 overflow-y-auto p-3">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 opacity-40">
            <div className="text-[10px] uppercase tracking-widest text-rose-100/50">Задач пока нет</div>
          </div>
        ) : (
          tasks.map((task) => {
            const isSelected = selectedTaskId === task.id;
            return (
              <div
                key={task.id}
                onClick={() => onSelectTask(task.id)}
                className={`cursor-pointer rounded-xl border p-3 transition-all hover:scale-[1.01] active:scale-[0.99] ${
                  isSelected ? "scale-[1.01] shadow-[0_4px_16px_rgba(0,0,0,0.4)]" : "opacity-80 hover:opacity-100"
                }`}
                style={{
                  background: isSelected ? "rgba(194,21,90,0.15)" : statusColors[task.status] || statusColors.pending,
                  borderColor: isSelected ? "rgba(232,0,30,0.6)" : statusBorders[task.status] || statusBorders.pending,
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 text-sm font-semibold leading-tight text-red-50 line-clamp-2">
                    {repairTextForDisplay(task.title)}
                  </div>
                  {task.workflowMode === "autonomous" ? (
                    <div className="shrink-0 rounded bg-indigo-600 px-1.5 py-0.5 text-[7px] font-bold uppercase text-white shadow-[0_0_8px_rgba(79,70,229,0.4)]">
                      Авто
                    </div>
                  ) : null}
                </div>

                {task.currentAssignee ? (
                  <div className="mt-2 truncate text-[10px] text-rose-100/48">
                    Исполнитель: {repairTextForDisplay(task.currentAssignee)}
                  </div>
                ) : null}

                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {task.status === "in_progress" ? <IconSpinner /> : null}
                    <span className={`truncate text-[10px] font-bold uppercase tracking-wider ${statusTone(task.status)}`}>
                      {statusLabels[task.status] || repairTextForDisplay(task.status)}
                    </span>
                  </div>
                  <div className="shrink-0 font-mono text-[9px] uppercase text-rose-100/40">
                    {repairTextForDisplay(task.targetRole || "All")}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
