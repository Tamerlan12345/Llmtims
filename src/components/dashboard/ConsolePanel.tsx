"use client";

import React from "react";
import { ProcessStep } from "@/app/dashboard/types";

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
    <div className="flex flex-col h-full glass-card border-none bg-black/40 overflow-hidden">
      <div className="p-4 border-b border-red-200/10 bg-black/20">
        <h2 className="text-sm font-bold text-red-50 uppercase tracking-widest">Консоль событий</h2>
      </div>
      
      <div className="flex-1 overflow-y-auto p-2 space-y-2 chat-scroll custom-scrollbar font-mono">
        {feed.map((step) => (
          <div 
            key={step.id} 
            className={`p-2.5 rounded-lg border text-[11px] leading-relaxed transition-all ${toneStyles[step.tone || "info"]}`}
          >
            <div className="flex items-center justify-between gap-2 mb-1.5 opacity-60">
              <span className="uppercase tracking-tighter">[{step.label}]</span>
              <span>{step.time}</span>
            </div>
            <div className="break-words">{step.detail}</div>
          </div>
        ))}
        {feed.length === 0 && (
          <div className="flex flex-col items-center justify-center p-8 opacity-20">
             <div className="text-[10px] tracking-widest uppercase">Ожидание логов...</div>
          </div>
        )}
      </div>
    </div>
  );
}
