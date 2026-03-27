"use client";

import { motion } from "framer-motion";
import {
  MEETING_POINTS,
  TaskStatus,
  resolveActivityLabel,
  resolveAgentMode,
  resolveTargetPoint,
  roleLabelRu,
} from "@/lib/office/engine";
import PixelAgentSprite from "@/components/PixelAgentSprite";

interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
}

interface OfficeHubProps {
  agents: OfficeAgent[];
  taskStatus: TaskStatus;
  speakingAgentId?: string | null;
  interactionTargetRole?: string | null;
}

const desks = [
  {
    title: "Стратегический штаб",
    subtitle: "PM / Аналитика",
    color: "border-rose-400/40 bg-rose-500/10",
    x: "6%",
    y: "8%",
  },
  {
    title: "Код-цех",
    subtitle: "Developer / Архитектура",
    color: "border-red-500/40 bg-red-500/10",
    x: "67%",
    y: "8%",
  },
  {
    title: "Контроль качества",
    subtitle: "QA / Автотесты",
    color: "border-orange-400/40 bg-orange-500/10",
    x: "6%",
    y: "58%",
  },
  {
    title: "Деплой-узел",
    subtitle: "DevOps / Логи",
    color: "border-red-700/40 bg-red-900/20",
    x: "67%",
    y: "58%",
  },
];

const statusTone: Record<string, string> = {
  pending: "text-amber-300",
  in_progress: "text-rose-300",
  review: "text-orange-300",
  waiting_approval: "text-orange-300",
  done: "text-emerald-300",
  failed: "text-red-300",
};

const resolveInteractionPoint = (role: string, interactionTargetRole?: string | null) => {
  if (!interactionTargetRole) return null;
  if (role === "PM") return MEETING_POINTS.PM;
  if (role === interactionTargetRole) return MEETING_POINTS.Peer;
  return null;
};

export default function OfficeHub({
  agents,
  taskStatus,
  speakingAgentId,
  interactionTargetRole,
}: OfficeHubProps) {
  return (
    <section className="relative h-[calc(100vh-260px)] min-h-[560px] rounded-2xl overflow-hidden border border-red-300/20 shadow-[0_0_90px_rgba(185,28,28,0.28)]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_10%_10%,rgba(239,68,68,0.33),transparent_38%),radial-gradient(circle_at_85%_10%,rgba(153,27,27,0.35),transparent_42%),radial-gradient(circle_at_50%_90%,rgba(251,113,133,0.22),transparent_46%),linear-gradient(180deg,#18030a,#12070a_45%,#080202)]" />
      <div className="absolute inset-0 office-floor-grid office-floor-scroll opacity-40" />
      <div className="absolute inset-0 office-vignette" />

      <div className="absolute top-4 left-4 z-40 px-3 py-1 border border-red-400/45 bg-red-950/65 text-[10px] uppercase tracking-[0.14em] text-red-100">
        CENTRASDEVTEAM | Tactical Office
      </div>
      <div className="absolute top-4 right-5 z-40 px-3 py-1 border border-red-300/30 bg-black/55 text-[10px] uppercase tracking-wide">
        <span className="text-slate-300">Статус:</span>{" "}
        <span className={statusTone[taskStatus] ?? "text-white"}>{taskStatus}</span>
      </div>

      {desks.map((desk) => (
        <div
          key={desk.title}
          className={`absolute w-[27%] h-[30%] rounded-xl border backdrop-blur-sm p-3 ${desk.color}`}
          style={{ left: desk.x, top: desk.y }}
        >
          <div className="text-[11px] uppercase tracking-[0.12em] text-rose-100 font-semibold">{desk.title}</div>
          <div className="text-[10px] text-rose-200/70">{desk.subtitle}</div>

          <div className="absolute left-4 right-4 bottom-4 h-14 border border-white/20 bg-black/45">
            <div className="absolute left-2 top-2 w-8 h-2 bg-slate-700/90" />
            <div className="absolute right-2 top-2 w-12 h-8 border border-red-300/30 bg-black overflow-hidden">
              <div className="absolute inset-0 office-monitor-scan" />
            </div>
            <div className="absolute left-10 right-16 bottom-2 h-2 bg-red-500/25 animate-pulse" />
          </div>
        </div>
      ))}

      <div className="absolute left-[33%] top-[55%] w-[35%] h-[36%] border border-rose-300/35 bg-rose-900/25 backdrop-blur-sm p-4">
        <div className="text-[11px] uppercase tracking-[0.16em] text-rose-100/90 font-semibold">Чилл-зона</div>
        <div className="text-[10px] text-rose-100/65 mt-1">
          Перерыв, обзор метрик, синхронизация команды.
        </div>
        <div className="absolute left-[12%] right-[12%] bottom-5 h-11 border border-white/15 bg-slate-900/70" />
        <div className="absolute left-[35%] top-14 w-[30%] h-20 border border-white/30 bg-black overflow-hidden">
          <div className="absolute inset-0 office-tv-flicker" />
        </div>
      </div>

      {interactionTargetRole ? (
        <svg className="absolute inset-0 z-20 pointer-events-none">
          <line
            x1="46%"
            y1="40%"
            x2="54%"
            y2="40%"
            className="office-link-pulse"
            strokeWidth="2"
            strokeDasharray="4 4"
          />
        </svg>
      ) : null}

      <motion.div
        className="absolute left-[50%] top-[42%] z-20 w-2 h-2 bg-red-300"
        animate={{ opacity: [0.25, 0.9, 0.25], scale: [1, 1.8, 1] }}
        transition={{ repeat: Infinity, duration: 2.2, ease: "easeInOut" }}
      />

      {agents.map((agent, index) => {
        const interactionPoint = resolveInteractionPoint(agent.role, interactionTargetRole);
        const discussing = Boolean(interactionPoint);
        const mode = resolveAgentMode(agent.role, agent.is_active, taskStatus, discussing);
        const target = interactionPoint ?? resolveTargetPoint(agent.role, agent.is_active, index, taskStatus);
        const activity = resolveActivityLabel(agent.role, mode);
        const speaking = speakingAgentId === agent.id;

        return (
          <motion.div
            key={agent.id}
            initial={false}
            animate={{
              left: target.x,
              top: target.y,
              scale: mode === "watching_tv" ? 0.92 : 1,
              y: speaking ? [0, -4, 0] : 0,
            }}
            transition={{
              left: { type: "spring", stiffness: 90, damping: 14 },
              top: { type: "spring", stiffness: 90, damping: 14 },
              scale: { duration: 0.25 },
              y: { repeat: speaking ? Infinity : 0, duration: 0.56, ease: "easeInOut" },
            }}
            className="absolute z-30 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5"
          >
            {speaking ? (
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                className="px-2 py-0.5 text-[9px] uppercase tracking-wide border border-red-300/60 bg-red-500/30 text-red-100"
              >
                На связи
              </motion.div>
            ) : null}

            <PixelAgentSprite role={agent.role} mode={mode} speaking={speaking} />

            <div className="px-2 py-1 border border-red-200/25 bg-black/70 text-center min-w-[140px]">
              <div className="text-[10px] font-semibold text-red-50 leading-none">
                {agent.name} · {roleLabelRu(agent.role)}
              </div>
              <div className="text-[9px] uppercase tracking-wide text-red-100/70 mt-1">{activity}</div>
            </div>
          </motion.div>
        );
      })}
    </section>
  );
}
