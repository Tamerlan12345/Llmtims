"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabase, isMockMode } from "@/lib/supabase/client";
import OfficeHub from "@/components/OfficeHub";
import { TaskStatus } from "@/lib/office/engine";

/* ─── Types ─────────────────────────────────────────────────────────────── */
interface Agent {
  id: string;
  name: string;
  role: "PM" | "Developer" | "QA" | "DevOps" | string;
  status?: string;
  avatar_url?: string;
  is_active: boolean;
}

interface TokenLog {
  cost: number | string;
}

interface TaskRecord {
  id: string;
  status: TaskStatus;
}

type RoleTarget = "Auto" | "All" | "PM" | "Developer" | "QA" | "DevOps";

interface ChatMessage {
  id: string;
  sender: "user" | "agent";
  content: string;
  role?: string;
  agentName?: string;
  coordinator?: string;
}

/* ─── Constants ─────────────────────────────────────────────────────────── */
const MOCK_AGENTS: Agent[] = [
  { id: "1", name: "Айгерим", role: "PM",        is_active: true  },
  { id: "2", name: "Алексей", role: "Developer", is_active: false },
  { id: "3", name: "Алуа",    role: "QA",        is_active: false },
  { id: "4", name: "Илья",    role: "DevOps",    is_active: false },
];

const quickPrompts = [
  "@pm общий статус команды",
  "@developer нужна реализация auth модуля",
  "@qa проверь регрессию по чату",
  "@devops оцени риски деплоя",
  "@all подготовьте план релиза",
];

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const roleTargetLabel: Record<RoleTarget, string> = {
  Auto:      "Авто (через PM)",
  All:       "Вся команда",
  PM:        "PM",
  Developer: "Developer",
  QA:        "QA",
  DevOps:    "DevOps",
};

const statusMeta: Record<string, { label: string; color: string }> = {
  pending:           { label: "Ожидание",          color: "#F59E0B" },
  in_progress:       { label: "В работе",           color: "#E8001E" },
  review:            { label: "Ревью",              color: "#F97316" },
  waiting_approval:  { label: "Ждёт подтверждения", color: "#F97316" },
  done:              { label: "Готово",             color: "#10B981" },
  failed:            { label: "Сбой",              color: "#EF4444" },
};

/* ─── SVG Icon helpers ──────────────────────────────────────────────────── */
const IconSend = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2L11 13"/>
    <path d="M22 2L15 22 11 13 2 9l20-7z"/>
  </svg>
);

const IconPlay = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>
);

const IconSpinner = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
);

const IconDot = ({ color }: { color: string }) => (
  <span className="relative flex h-2 w-2">
    <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ backgroundColor: color }} />
    <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
  </span>
);

const IconUser = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

/* ─── Component ─────────────────────────────────────────────────────────── */
export default function DashboardPage() {
  const [mounted,              setMounted]              = useState(false);
  const [agents,               setAgents]               = useState<Agent[]>(isMockMode ? MOCK_AGENTS : []);
  const [totalCost,            setTotalCost]            = useState(0.042);
  const [taskInput,            setTaskInput]            = useState("");
  const [taskTargetRole,       setTaskTargetRole]       = useState<RoleTarget>("All");
  const [isRunning,            setIsRunning]            = useState(false);
  const [taskStatus,           setTaskStatus]           = useState<TaskStatus>(isMockMode ? "in_progress" : "pending");
  const [chatInput,            setChatInput]            = useState("");
  const [chatTargetRole,       setChatTargetRole]       = useState<RoleTarget>("Auto");
  const [chatLoading,          setChatLoading]          = useState(false);
  const [chatMessages,         setChatMessages]         = useState<ChatMessage[]>([
    {
      id: "boot",
      sender: "agent",
      agentName: "PM",
      role: "PM",
      coordinator: "PM",
      content: "Центр управления активирован. Все запросы проходят через PM. Можно ставить общие и адресные задачи.",
    },
  ]);
  const [speakingAgentId,      setSpeakingAgentId]      = useState<string | null>(null);
  const [interactionTargetRole, setInteractionTargetRole] = useState<string | null>(null);

  const activeAgent = useMemo(() => agents.find((a) => a.is_active), [agents]);
  const currentStatus = statusMeta[taskStatus] ?? { label: taskStatus, color: "#9CA3AF" };

  /* ─── Animation helper ──────────────────────────────────────────── */
  const activateRoleAnimation = (role?: string, forcedTargetRole?: string | null) => {
    const targetRole = forcedTargetRole ?? role;
    if (!targetRole) return;
    const speaker = agents.find((a) => a.role === role);
    if (speaker) {
      setAgents((prev) => prev.map((a) => ({ ...a, is_active: a.id === speaker.id })));
      setSpeakingAgentId(speaker.id);
      window.setTimeout(() => setSpeakingAgentId(null), 2600);
    }
    if (targetRole !== "PM" && targetRole !== "All" && targetRole !== "Auto") {
      setInteractionTargetRole(targetRole);
      window.setTimeout(() => setInteractionTargetRole(null), 3200);
    }
  };

  /* ─── Create task ───────────────────────────────────────────────── */
  const createTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!taskInput || isRunning) return;
    setIsRunning(true);
    try {
      if (isMockMode) {
        setTaskStatus("in_progress");
        setChatMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            sender: "agent",
            role: "PM",
            agentName: "PM",
            coordinator: "PM",
            content: `PM: задача принята (${roleTargetLabel[taskTargetRole]}). Запускаю координацию команды в demo-режиме.`,
          },
        ]);
        activateRoleAnimation("PM", taskTargetRole);
        setTaskInput("");
        return;
      }

      setTaskStatus("pending");

      const { data: task, error } = await supabase
        .from("tasks")
        .insert({
          title: "CentrasDEVTEAM task",
          description: taskInput,
          status: "pending",
          metadata: { targetRole: taskTargetRole, initiatedBy: "dashboard" },
        })
        .select()
        .single();

      if (error) throw error;

      const response = await fetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id, input: taskInput, targetRole: taskTargetRole }),
      });
      if (!response.ok) throw new Error("agents run request failed");

      setChatMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          sender: "agent",
          role: "PM",
          agentName: "PM",
          coordinator: "PM",
          content: `PM: задача запущена для ${roleTargetLabel[taskTargetRole]}. Если формулировка недостаточна, команда вернется с уточнениями.`,
        },
      ]);
      activateRoleAnimation("PM", taskTargetRole);
      setTaskInput("");
    } catch (err) {
      console.error(err);
      alert("Ошибка запуска задачи. Проверь логи/API.");
      setTaskStatus("failed");
    } finally {
      setIsRunning(false);
    }
  };

  /* ─── Chat ──────────────────────────────────────────────────────── */
  const askAgents = async (e: FormEvent) => {
    e.preventDefault();
    const message = chatInput.trim();
    if (!message || chatLoading) return;
    const userEntry: ChatMessage = { id: makeId(), sender: "user", content: message };
    setChatMessages((prev) => [...prev, userEntry]);
    setChatInput("");
    setChatLoading(true);
    try {
      const history = [...chatMessages, userEntry]
        .slice(-8)
        .map((m) => ({ role: m.sender === "user" ? "user" : "assistant", content: m.content }));
      const response = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history, targetRole: chatTargetRole }),
      });
      if (!response.ok) throw new Error("chat request failed");
      const data = (await response.json()) as {
        role?: string; agentName?: string; message?: string; coordinator?: string; targetRole?: string;
      };
      setChatMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          sender: "agent",
          role: data.role,
          coordinator: data.coordinator,
          agentName: data.agentName ?? data.role ?? "Агент",
          content: data.message ?? "Нет ответа.",
        },
      ]);
      activateRoleAnimation(data.role, data.targetRole ?? chatTargetRole);
    } catch {
      setChatMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          sender: "agent",
          role: "PM",
          coordinator: "PM",
          agentName: "Система",
          content: "Чат временно недоступен. Повтори запрос через несколько секунд.",
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  /* ─── Data bootstrap ────────────────────────────────────────────── */
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted || isMockMode) return;

    const fetchData = async () => {
      const { data: agentsData } = await supabase.from("agents").select("*");
      if (agentsData) setAgents(agentsData);

      const { data: costData } = await supabase.from("token_logs").select("cost");
      if (costData) setTotalCost((costData as TokenLog[]).reduce((acc, c) => acc + Number(c.cost), 0));

      const { data: latestTask } = await supabase
        .from("tasks").select("id, status").order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (latestTask?.status) setTaskStatus((latestTask as TaskRecord).status);
    };

    fetchData();

    const agentsChannel = supabase.channel("agents-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "agents" }, (payload) => {
        setAgents((prev) => {
          if (payload.eventType === "INSERT") return [...prev, payload.new as Agent];
          if (payload.eventType === "DELETE") return prev.filter((a) => a.id !== (payload.old as Agent).id);
          return prev.map((a) => a.id === (payload.new as Agent).id ? (payload.new as Agent) : a);
        });
      })
      .subscribe();

    const tasksChannel = supabase.channel("tasks-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, (payload) => {
        if (payload.eventType === "DELETE") return;
        const nextStatus = (payload.new as TaskRecord)?.status;
        if (nextStatus) setTaskStatus(nextStatus);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(agentsChannel);
      supabase.removeChannel(tasksChannel);
    };
  }, [mounted]);

  if (!mounted) return <div className="min-h-screen" style={{ background: "#0d0308" }} />;

  /* ──────────────────────────────────────────────────────────────── */
  return (
    <main className="min-h-dvh text-white p-3 lg:p-5 overflow-hidden relative"
      style={{ fontFamily: '"Trebuchet MS", "Segoe UI", sans-serif' }}>

      {/* ── Background atmosphere ── */}
      <div className="fixed inset-0 -z-10"
        style={{
          background: "linear-gradient(160deg,#130208 0%,#0a0114 45%,#05010c 100%)",
        }}
      />
      <div className="fixed inset-0 -z-10 opacity-70"
        style={{
          background:
            "radial-gradient(circle at 8% 6%, rgba(232,0,30,0.28) 0%, transparent 35%)," +
            "radial-gradient(circle at 90% 12%, rgba(123,47,190,0.22) 0%, transparent 38%)," +
            "radial-gradient(circle at 50% 95%, rgba(42,63,219,0.14) 0%, transparent 40%)",
        }}
      />

      <div className="relative z-10 max-w-[1540px] mx-auto flex flex-col gap-4">

        {/* ══════════════════════════════════════════════════════════
            HEADER  — logos + status bar
        ══════════════════════════════════════════════════════════ */}
        <header
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-5 py-4 rounded-xl"
          style={{
            background: "rgba(10,3,7,0.82)",
            border: "1px solid rgba(194,21,90,0.30)",
            boxShadow: "0 0 0 1px rgba(232,0,30,0.08), inset 0 1px 0 rgba(255,255,255,0.04), 0 8px 32px rgba(0,0,0,0.55)",
            backdropFilter: "blur(20px)",
          }}
        >
          {/* Left: logos */}
          <div className="flex items-center gap-5">
            {/* Centras logo */}
            <div className="flex-shrink-0">
              <img
                src="/centras-logo.svg"
                alt="Centras Insurance"
                style={{ height: 44, width: "auto", filter: "drop-shadow(0 0 8px rgba(232,0,30,0.35))" }}
                draggable={false}
              />
            </div>

            {/* Divider */}
            <div
              style={{
                width: 1,
                height: 36,
                background: "linear-gradient(to bottom, transparent, rgba(194,21,90,0.6), transparent)",
              }}
            />

            {/* DevTeam logo */}
            <div className="flex-shrink-0">
              <img
                src="/devteam-logo.svg"
                alt="DevTeam"
                style={{ height: 38, width: "auto", filter: "drop-shadow(0 0 8px rgba(123,47,190,0.35))" }}
                draggable={false}
              />
            </div>

            {/* Mode badge */}
            <div
              className="hidden md:flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em]"
              style={{
                background: "rgba(232,0,30,0.10)",
                border: "1px solid rgba(232,0,30,0.28)",
                borderRadius: 6,
                color: "rgba(255,200,210,0.85)",
              }}
            >
              <IconDot color="#E8001E" />
              {isMockMode ? "Демо-режим" : "Боевой режим"}
            </div>
          </div>

          {/* Right: metrics */}
          <div className="flex flex-wrap items-center gap-3">
            {/* API Cost */}
            <div
              className="px-3 py-2 rounded-lg text-right"
              style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(194,21,90,0.22)" }}
            >
              <div className="text-[9px] text-rose-100/60 uppercase tracking-widest">Стоимость API</div>
              <div className="text-sm font-mono text-rose-200 mt-0.5">${totalCost.toFixed(4)}</div>
            </div>

            {/* Active role */}
            <div
              className="px-3 py-2 rounded-lg"
              style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(194,21,90,0.22)" }}
            >
              <div className="text-[9px] text-rose-100/60 uppercase tracking-widest">Активная роль</div>
              <div className="text-sm font-semibold text-rose-50 mt-0.5">
                {activeAgent?.role ?? "—"} · {activeAgent?.name ?? "Нет"}
              </div>
            </div>

            {/* Task status chip */}
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-lg"
              style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(194,21,90,0.22)" }}
            >
              <IconDot color={currentStatus.color} />
              <div>
                <div className="text-[9px] text-rose-100/60 uppercase tracking-widest">Статус задачи</div>
                <div className="text-sm font-semibold mt-0.5" style={{ color: currentStatus.color }}>
                  {currentStatus.label}
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* ══════════════════════════════════════════════════════════
            MAIN GRID: office | chat
        ══════════════════════════════════════════════════════════ */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.95fr)_minmax(390px,1fr)]">

          {/* ── Left column ── */}
          <section className="flex flex-col gap-4">

            {/* Task input bar */}
            <form
              id="task-form"
              onSubmit={createTask}
              className="flex flex-col sm:flex-row gap-2 p-3 rounded-xl"
              style={{
                background: "rgba(10,3,7,0.78)",
                border: "1px solid rgba(194,21,90,0.28)",
                backdropFilter: "blur(12px)",
              }}
            >
              {/* Text input */}
              <input
                id="task-input"
                type="text"
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                placeholder="Поставь задачу команде — PM скоординирует всех..."
                disabled={isRunning}
                className="flex-1 min-w-0 bg-black/35 px-4 py-2.5 text-sm outline-none rounded-lg text-white placeholder:text-rose-100/30"
                style={{ border: "1px solid rgba(194,21,90,0.22)" }}
              />

              {/* Role select */}
              <select
                id="task-role-select"
                value={taskTargetRole}
                onChange={(e) => setTaskTargetRole(e.target.value as RoleTarget)}
                className="bg-black/40 px-3 py-2.5 text-sm outline-none rounded-lg text-rose-100 cursor-pointer"
                style={{ border: "1px solid rgba(194,21,90,0.28)", minWidth: 160 }}
              >
                {(Object.keys(roleTargetLabel) as RoleTarget[]).map((role) => (
                  <option key={role} value={role}>{roleTargetLabel[role]}</option>
                ))}
              </select>

              {/* Submit button */}
              <button
                id="task-submit-btn"
                type="submit"
                disabled={isRunning}
                className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold whitespace-nowrap transition-all duration-200 active:scale-95 disabled:opacity-50 disabled:pointer-events-none"
                style={{
                  background: isRunning
                    ? "rgba(100,80,90,0.4)"
                    : "linear-gradient(135deg,#E8001E 0%,#C2155A 50%,#7B2FBE 100%)",
                  border: isRunning ? "1px solid rgba(150,130,140,0.3)" : "1px solid rgba(232,0,30,0.5)",
                  color: "#fff",
                  boxShadow: isRunning ? "none" : "0 0 20px rgba(194,21,90,0.40)",
                }}
              >
                {isRunning ? <><IconSpinner /> Выполнение...</> : <><IconPlay /> Запустить задачу</>}
              </button>
            </form>

            {/* Pixel Office */}
            <OfficeHub
              agents={agents}
              taskStatus={taskStatus}
              speakingAgentId={speakingAgentId}
              interactionTargetRole={interactionTargetRole}
            />
          </section>

          {/* ── Right column — Chat ── */}
          <aside
            className="flex flex-col rounded-xl"
            style={{
              background: "rgba(8,2,6,0.88)",
              border: "1px solid rgba(194,21,90,0.26)",
              backdropFilter: "blur(18px)",
              height: "calc(100vh - 178px)",
              minHeight: 620,
              maxHeight: 940,
            }}
          >
            {/* Chat header */}
            <div
              className="px-4 py-3 flex items-start justify-between gap-2"
              style={{ borderBottom: "1px solid rgba(194,21,90,0.18)" }}
            >
              <div>
                <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-rose-100">
                  Командный чат
                </h2>
                <p className="text-[11px] text-rose-100/55 mt-0.5">
                  Адресная связь с ролью или всей командой
                </p>
              </div>
              {/* Live indicator */}
              <div className="flex items-center gap-1.5 text-[10px] text-rose-100/60 mt-0.5">
                <IconDot color="#E8001E" />
                Live
              </div>
            </div>

            {/* Quick prompts */}
            <div
              className="px-4 py-3 space-y-2"
              style={{ borderBottom: "1px solid rgba(194,21,90,0.18)" }}
            >
              <div className="text-[9px] uppercase tracking-[0.2em] text-rose-100/55">
                Быстрые команды
              </div>
              <div className="flex flex-wrap gap-1.5">
                {quickPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    id={`quick-${prompt.slice(1, 8).replace(/\s/g, "-")}`}
                    onClick={() => setChatInput(prompt)}
                    className="text-[10px] px-2.5 py-1 rounded-md transition-all duration-150 active:scale-95"
                    style={{
                      background: "rgba(194,21,90,0.08)",
                      border: "1px solid rgba(194,21,90,0.25)",
                      color: "rgba(255,200,210,0.8)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "rgba(194,21,90,0.20)";
                      e.currentTarget.style.borderColor = "rgba(194,21,90,0.55)";
                      e.currentTarget.style.color = "#fff";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "rgba(194,21,90,0.08)";
                      e.currentTarget.style.borderColor = "rgba(194,21,90,0.25)";
                      e.currentTarget.style.color = "rgba(255,200,210,0.8)";
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>

            {/* Addressee selector */}
            <div
              className="px-4 py-2.5"
              style={{ borderBottom: "1px solid rgba(194,21,90,0.18)" }}
            >
              <label className="text-[9px] uppercase tracking-[0.2em] text-rose-100/55 block mb-1.5">
                Кому адресовать
              </label>
              <select
                id="chat-role-select"
                value={chatTargetRole}
                onChange={(e) => setChatTargetRole(e.target.value as RoleTarget)}
                className="w-full bg-black/45 px-3 py-2 text-sm outline-none rounded-lg text-rose-100 cursor-pointer"
                style={{ border: "1px solid rgba(194,21,90,0.26)" }}
              >
                <option value="Auto">Авто (определит PM)</option>
                <option value="All">Вся команда</option>
                <option value="PM">PM</option>
                <option value="Developer">Developer</option>
                <option value="QA">QA</option>
                <option value="DevOps">DevOps</option>
              </select>
            </div>

            {/* Messages */}
            <div
              id="chat-messages"
              className="flex-1 overflow-y-auto p-4 space-y-3 chat-scroll"
            >
              {chatMessages.map((item) => (
                <div
                  key={item.id}
                  className={`flex ${item.sender === "user" ? "justify-end" : "justify-start"}`}
                >
                  {/* Agent icon */}
                  {item.sender === "agent" && (
                    <div
                      className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mr-2 mt-0.5"
                      style={{
                        background: "linear-gradient(135deg,#E8001E,#7B2FBE)",
                        boxShadow: "0 0 8px rgba(194,21,90,0.4)",
                      }}
                    >
                      <IconUser />
                    </div>
                  )}

                  <div
                    className="w-fit max-w-[82%] px-3 py-2.5 rounded-xl text-xs leading-relaxed"
                    style={
                      item.sender === "user"
                        ? {
                            background: "linear-gradient(135deg,rgba(232,0,30,0.25),rgba(123,47,190,0.18))",
                            border: "1px solid rgba(194,21,90,0.38)",
                            color: "#ffe8ec",
                          }
                        : {
                            background: "rgba(0,0,0,0.65)",
                            border: "1px solid rgba(194,21,90,0.20)",
                            color: "#fde8ec",
                          }
                    }
                  >
                    {item.sender === "agent" && (
                      <div
                        className="text-[9px] uppercase tracking-[0.15em] mb-1.5 font-semibold"
                        style={{
                          background: "linear-gradient(90deg,#E8001E,#7B2FBE)",
                          WebkitBackgroundClip: "text",
                          WebkitTextFillColor: "transparent",
                        }}
                      >
                        {item.coordinator === "PM" && item.role && item.role !== "PM"
                          ? `PM → ${item.agentName ?? item.role}`
                          : (item.agentName ?? item.role ?? "Агент")}
                      </div>
                    )}
                    <span className="whitespace-pre-wrap">{item.content}</span>
                  </div>
                </div>
              ))}

              {chatLoading && (
                <div className="flex justify-start items-center gap-2 px-3 py-2.5 w-fit rounded-xl text-xs"
                  style={{ background: "rgba(0,0,0,0.55)", border: "1px solid rgba(194,21,90,0.20)", color: "rgba(255,220,230,0.7)" }}>
                  <IconSpinner />
                  PM координирует ответ...
                </div>
              )}
            </div>

            {/* Chat input */}
            <form
              id="chat-form"
              onSubmit={askAgents}
              className="p-3 flex flex-col gap-2"
              style={{ borderTop: "1px solid rgba(194,21,90,0.20)" }}
            >
              <textarea
                id="chat-input"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Напиши запрос. Пример: '@qa проверь регрессию по чату'"
                disabled={chatLoading}
                className="min-h-[80px] max-h-[120px] resize-y w-full bg-black/50 px-4 py-3 text-sm outline-none rounded-lg text-white placeholder:text-rose-100/30"
                style={{ border: "1px solid rgba(194,21,90,0.22)" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    askAgents(e as unknown as FormEvent);
                  }
                }}
              />
              <button
                id="chat-send-btn"
                type="submit"
                disabled={chatLoading}
                className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 active:scale-95 disabled:opacity-50 disabled:pointer-events-none"
                style={{
                  background: chatLoading
                    ? "rgba(100,80,90,0.35)"
                    : "linear-gradient(135deg,#E8001E 0%,#C2155A 55%,#7B2FBE 100%)",
                  border: "1px solid rgba(194,21,90,0.45)",
                  color: "#fff",
                  boxShadow: chatLoading ? "none" : "0 0 18px rgba(194,21,90,0.35)",
                }}
              >
                {chatLoading ? <><IconSpinner /> Отправка...</> : <><IconSend /> Отправить сообщение</>}
              </button>
              <div className="text-center text-[9px] text-rose-100/30">
                Ctrl + Enter для быстрой отправки
              </div>
            </form>
          </aside>
        </div>
      </div>
    </main>
  );
}
