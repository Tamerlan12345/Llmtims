"use client";

import React from "react";
import { ProcessStep } from "@/app/dashboard/types";
import { repairTextForDisplay } from "@/lib/text/repairMojibake";

interface ConsolePanelProps {
  feed: ProcessStep[];
}

const toneStyles: Record<string, string> = {
  info: "text-rose-100/60 border-red-200/5 bg-white/5",
  run: "text-amber-400 border-amber-500/20 bg-amber-500/5",
  ok: "text-emerald-400 border-emerald-500/20 bg-emerald-500/5",
  warn: "text-orange-400 border-orange-500/20 bg-orange-500/5",
  error: "text-red-400 border-red-500/30 bg-red-500/10",
};

export default function ConsolePanel({ feed }: ConsolePanelProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden border-none bg-black/40 glass-card">
      <div className="border-b border-red-200/10 bg-black/20 p-4">
        <h2 className="text-sm font-bold uppercase tracking-widest text-red-50">Консоль событий</h2>
      </div>

      <div className="chat-scroll custom-scrollbar flex-1 space-y-2 overflow-y-auto p-2 font-mono">
        {feed.map((step) => (
          <div
            key={step.id}
            className={`rounded-lg border p-2.5 text-[11px] leading-relaxed transition-all ${toneStyles[step.tone || "info"]}`}
          >
            <div className="mb-1.5 flex items-center justify-between gap-2 opacity-60">
              <span className="truncate uppercase tracking-tighter">[{repairTextForDisplay(step.label)}]</span>
              <span className="shrink-0">{step.time}</span>
            </div>
            <div className="break-words">{repairTextForDisplay(step.detail)}</div>
          </div>
        ))}
        {feed.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 opacity-20">
            <div className="text-[10px] uppercase tracking-widest">Ожидание логов...</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
