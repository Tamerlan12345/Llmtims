"use client";

import React from "react";
import { IconActivity, IconBriefcase, IconLayout, IconPlus, IconHistory } from "@/components/icons";

interface HeaderStatsProps {
  offices: Array<{ id: string; name: string }>;
  activeOfficeId: string | null;
  onOfficeChange: (id: string) => void;
  onAddOffice: () => void;
  onExitToHub: () => void;
  stats: {
    agentsCount: number;
    activeTasks: number;
    completedTasks: number;
    eventsToday: number;
  };
}

export default function HeaderStats({
  offices,
  activeOfficeId,
  onOfficeChange,
  onAddOffice,
  onExitToHub,
  stats,
}: HeaderStatsProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-6 p-6 glass-card border-none bg-black/40 shadow-2xl">
      <div className="flex items-center gap-4">
        <div className="space-y-1">
          <div className="text-[10px] items-center gap-1.5 uppercase tracking-[0.2em] font-bold text-red-500/80 flex">
            <IconLayout /> Текущий департамент
          </div>
          <div className="flex items-center gap-2">
            <select
              value={activeOfficeId || ""}
              onChange={(e) => onOfficeChange(e.target.value)}
              className="mt-1 bg-black/40 border border-red-200/20 rounded-xl px-4 py-2 text-sm font-bold text-red-50 outline-none hover:border-red-500/40 transition-all cursor-pointer appearance-none min-w-[200px]"
              style={{ boxShadow: "inset 0 2px 8px rgba(0,0,0,0.4)" }}
            >
              {offices.map((office) => (
                <option key={office.id} value={office.id}>
                  {office.name}
                </option>
              ))}
            </select>
            <button
              onClick={onAddOffice}
              className="mt-1 w-10 h-10 flex items-center justify-center rounded-xl bg-red-600/10 border border-red-500/30 text-red-500 hover:bg-red-600/20 transition-all active:scale-95 shadow-[0_0_12px_rgba(232,0,30,0.1)]"
            >
              <IconPlus />
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-6 md:gap-12">
        <StatItem
          icon={<IconActivity />}
          label="Сотрудников"
          value={stats.agentsCount}
          color="rgba(232,0,30,0.8)"
        />
        <StatItem
          icon={<IconBriefcase />}
          label="В работе"
          value={stats.activeTasks}
          color="rgba(194,21,90,0.8)"
        />
        <StatItem
          icon={<IconHistory />}
          label="Завершено"
          value={stats.completedTasks}
          color="rgba(123,47,190,0.8)"
        />
        <button
          onClick={onExitToHub}
          className="h-11 px-4 rounded-xl border border-red-400/30 text-xs uppercase tracking-[0.2em] font-bold text-red-100/90 bg-black/50 hover:bg-red-500/20 hover:border-red-400/60 transition-all"
        >
          Выход в Хаб
        </button>
      </div>
    </div>
  );
}

function StatItem({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-4 group cursor-default">
      <div
        className="w-12 h-12 flex items-center justify-center rounded-2xl transition-all group-hover:scale-110"
        style={{ background: `${color}15`, border: `1px solid ${color}40`, color }}
      >
        {icon}
      </div>
      <div>
        <div className="text-[10px] uppercase font-bold tracking-[0.15em] text-rose-100/40">{label}</div>
        <div className="text-xl font-black text-rose-50 tabular-nums">{value}</div>
      </div>
    </div>
  );
}
