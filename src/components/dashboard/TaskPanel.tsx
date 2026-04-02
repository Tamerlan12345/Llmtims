"use client";

import React from "react";
import { TaskItem } from "@/app/dashboard/types";
import { IconSpinner } from "@/components/icons";

interface TaskPanelProps {
  tasks: TaskItem[];
  onSelectTask: (taskId: string) => void;
  selectedTaskId: string | null;
}

const statusColors: Record<string, string> = {
  pending: "rgba(255, 255, 255, 0.05)",
  in_progress: "rgba(194, 21, 90, 0.1)",
  review: "rgba(123, 47, 190, 0.1)",
  done: "rgba(16, 185, 129, 0.1)",
  failed: "rgba(232, 0, 30, 0.1)",
};

const statusBorders: Record<string, string> = {
  pending: "rgba(255, 255, 255, 0.15)",
  in_progress: "rgba(194, 21, 90, 0.4)",
  review: "rgba(123, 47, 190, 0.4)",
  done: "rgba(16, 185, 129, 0.4)",
  failed: "rgba(232, 0, 30, 0.4)",
};

const statusLabels: Record<string, string> = {
  pending: "Ожидание",
  in_progress: "В работе",
  review: "Ревью",
  waiting_approval: "Ждет команды",
  done: "Готово",
  failed: "Ошибка",
};

export default function TaskPanel({ tasks, onSelectTask, selectedTaskId }: TaskPanelProps) {
  return (
    <div className="flex flex-col h-full glass-card border-none bg-black/40 overflow-hidden">
      <div className="p-4 border-b border-red-200/10 flex items-center justify-between bg-black/20">
        <h2 className="text-sm font-bold text-red-50 uppercase tracking-widest flex items-center gap-2">
            Активные задачи <span className="text-[10px] text-rose-100/40 font-mono">[{tasks.length}]</span>
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2 chat-scroll custom-scrollbar">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 opacity-40">
             <div className="text-[10px] tracking-widest text-rose-100/50 uppercase">Задач пока нет</div>
          </div>
        ) : (
          tasks.map((task) => (
            <div 
              key={task.id}
              onClick={() => onSelectTask(task.id)}
              className={`p-3 rounded-xl border cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] ${
                selectedTaskId === task.id ? "scale-[1.02] shadow-[0_4px_16px_rgba(0,0,0,0.4)]" : "opacity-80 hover:opacity-100"
              }`}
              style={{
                background: selectedTaskId === task.id ? "rgba(194, 21, 90, 0.15)" : (statusColors[task.status] || statusColors.pending),
                borderColor: selectedTaskId === task.id ? "rgba(232, 0, 30, 0.6)" : (statusBorders[task.status] || statusBorders.pending),
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-semibold text-red-50 leading-tight line-clamp-2">{task.title}</div>
                {task.workflowMode === "autonomous" && (
                    <div className="shrink-0 text-[7px] bg-indigo-600 px-1.5 py-0.5 rounded uppercase font-bold text-white shadow-[0_0_8px_rgba(79,70,229,0.4)]">
                        Auto
                    </div>
                )}
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {task.status === "in_progress" && <IconSpinner />}
                  <span className={`text-[10px] tracking-wider font-bold uppercase ${
                    task.status === "done" ? "text-emerald-400" : task.status === "failed" ? "text-red-400" : "text-rose-100/60"
                  }`}>
                    {statusLabels[task.status] || task.status}
                  </span>
                </div>
                <div className="text-[9px] text-rose-100/40 uppercase font-mono">{task.targetRole || "All"}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
