"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { supabase, isMockMode } from "@/lib/supabase/client";
import OfficeHub from "@/components/OfficeHub";
import { TaskStatus, rotateActiveAgent, rotateMockTaskStatus } from "@/lib/office/engine";

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

const MOCK_AGENTS: Agent[] = [
  { id: "1", name: "Alex", role: "PM", is_active: true },
  { id: "2", name: "John", role: "Developer", is_active: false },
  { id: "3", name: "Sara", role: "QA", is_active: false },
  { id: "4", name: "Mike", role: "DevOps", is_active: false },
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
  Auto: "Авто (через PM)",
  All: "Вся команда",
  PM: "PM",
  Developer: "Developer",
  QA: "QA",
  DevOps: "DevOps",
};

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const [agents, setAgents] = useState<Agent[]>(isMockMode ? MOCK_AGENTS : []);
  const [totalCost, setTotalCost] = useState(0.042);
  const [taskInput, setTaskInput] = useState("");
  const [taskTargetRole, setTaskTargetRole] = useState<RoleTarget>("All");
  const [isRunning, setIsRunning] = useState(false);
  const [taskStatus, setTaskStatus] = useState<TaskStatus>("pending");
  const [chatInput, setChatInput] = useState("");
  const [chatTargetRole, setChatTargetRole] = useState<RoleTarget>("Auto");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "boot",
      sender: "agent",
      agentName: "PM",
      role: "PM",
      coordinator: "PM",
      content:
        "Центр управления активирован. Все запросы проходят через PM. Можно ставить общие и адресные задачи.",
    },
  ]);
  const [speakingAgentId, setSpeakingAgentId] = useState<string | null>(null);
  const [interactionTargetRole, setInteractionTargetRole] = useState<string | null>(null);

  const activeAgent = useMemo(() => agents.find((a) => a.is_active), [agents]);

  const activateRoleAnimation = (role?: string, forcedTargetRole?: string | null) => {
    const targetRole = forcedTargetRole ?? role;
    if (!targetRole) return;

    const speaker = agents.find((agent) => agent.role === role);
    if (speaker) {
      setAgents((prev) =>
        prev.map((agent) => ({
          ...agent,
          is_active: agent.id === speaker.id,
        }))
      );
      setSpeakingAgentId(speaker.id);
      window.setTimeout(() => setSpeakingAgentId(null), 2600);
    }

    if (targetRole !== "PM" && targetRole !== "All" && targetRole !== "Auto") {
      setInteractionTargetRole(targetRole);
      window.setTimeout(() => setInteractionTargetRole(null), 3200);
    }
  };

  const rotateMockActivity = () => {
    setAgents((prev) => rotateActiveAgent(prev));
    setTaskStatus((prev) => rotateMockTaskStatus(prev));
  };

  const createTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!taskInput || isRunning) return;
    setIsRunning(true);

    try {
      if (isMockMode) {
        rotateMockActivity();
        setChatMessages((prev) => [
          ...prev,
          {
            id: makeId(),
            sender: "agent",
            role: "PM",
            agentName: "PM",
            coordinator: "PM",
            content:
              `PM: задача принята (${roleTargetLabel[taskTargetRole]}). ` +
              "Запускаю координацию команды в demo-режиме.",
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

      if (!response.ok) {
        throw new Error("agents run request failed");
      }

      setChatMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          sender: "agent",
          role: "PM",
          agentName: "PM",
          coordinator: "PM",
          content:
            `PM: задача запущена для ${roleTargetLabel[taskTargetRole]}. ` +
            "Если формулировка недостаточна, команда вернется с уточнениями.",
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
        .map((item) => ({ role: item.sender === "user" ? "user" : "assistant", content: item.content }));

      const response = await fetch("/api/agents/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history, targetRole: chatTargetRole }),
      });

      if (!response.ok) {
        throw new Error("chat request failed");
      }

      const data = (await response.json()) as {
        role?: string;
        agentName?: string;
        message?: string;
        coordinator?: string;
        targetRole?: string;
      };

      setChatMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          sender: "agent",
          role: data.role,
          coordinator: data.coordinator,
          agentName: data.agentName ?? data.role ?? "Agent",
          content: data.message ?? "Нет ответа.",
        },
      ]);

      activateRoleAnimation(data.role, data.targetRole ?? chatTargetRole);
    } catch (error) {
      console.error(error);
      setChatMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          sender: "agent",
          role: "PM",
          coordinator: "PM",
          agentName: "System",
          content: "Чат временно недоступен. Повтори запрос через несколько секунд.",
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || !isMockMode) return;

    const timer = setInterval(() => {
      rotateMockActivity();
    }, 4500);

    return () => clearInterval(timer);
  }, [mounted]);

  useEffect(() => {
    if (!mounted || isMockMode) return;

    const fetchData = async () => {
      const { data: agentsData } = await supabase.from("agents").select("*");
      if (agentsData) setAgents(agentsData);

      const { data: costData } = await supabase.from("token_logs").select("cost");
      if (costData) {
        setTotalCost((costData as TokenLog[]).reduce((acc, curr) => acc + Number(curr.cost), 0));
      }

      const { data: latestTask } = await supabase
        .from("tasks")
        .select("id, status")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestTask?.status) {
        setTaskStatus((latestTask as TaskRecord).status);
      }
    };

    fetchData();

    const agentsChannel = supabase
      .channel("agents-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "agents" }, (payload) => {
        setAgents((prev) => {
          if (payload.eventType === "INSERT") {
            return [...prev, payload.new as Agent];
          }

          if (payload.eventType === "DELETE") {
            return prev.filter((agent) => agent.id !== (payload.old as Agent).id);
          }

          return prev.map((agent) =>
            agent.id === (payload.new as Agent).id ? (payload.new as Agent) : agent
          );
        });
      })
      .subscribe();

    const tasksChannel = supabase
      .channel("tasks-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, (payload) => {
        if (payload.eventType === "DELETE") return;
        const nextStatus = (payload.new as TaskRecord)?.status;
        if (nextStatus) {
          setTaskStatus(nextStatus);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(agentsChannel);
      supabase.removeChannel(tasksChannel);
    };
  }, [mounted]);

  if (!mounted) return <div className="min-h-screen bg-[#100506]" />;

  return (
    <main
      className="min-h-screen text-white p-4 lg:p-6 overflow-hidden relative"
      style={{ fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif' }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_7%_8%,rgba(244,63,94,0.3),transparent_35%),radial-gradient(circle_at_92%_14%,rgba(185,28,28,0.32),transparent_42%),linear-gradient(180deg,#130306,#090102)]" />

      <div className="relative z-10 max-w-[1500px] mx-auto">
        <header className="px-5 py-4 border border-red-300/20 bg-black/50 backdrop-blur-md rounded-t-xl">
          <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-2 px-2 py-1 border border-red-300/30 bg-red-500/10 text-[10px] uppercase tracking-[0.2em] text-red-100">
                <span className="w-2 h-2 bg-red-400 animate-pulse" />
                CentrasDEVTEAM
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-rose-200 via-red-300 to-red-500">
                Tactical Office Command Center
              </h1>
              <p className="text-xs uppercase tracking-[0.18em] text-red-100/70">
                {isMockMode ? "Демо-режим" : "Реальный режим"} · PM-координация · Адресные и общие задачи
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={rotateMockActivity}
                className="px-4 py-2 text-xs font-semibold tracking-wide uppercase border border-red-300/35 bg-red-500/15 text-red-100 hover:bg-red-500/30 transition"
              >
                Cycle Animation
              </button>
              <div className="px-3 py-2 border border-red-200/20 bg-black/45 rounded">
                <div className="text-[10px] text-red-100/70 uppercase tracking-wide">API Cost</div>
                <div className="text-sm font-mono text-rose-200">${totalCost.toFixed(4)}</div>
              </div>
              <div className="px-3 py-2 border border-red-200/20 bg-black/45 rounded">
                <div className="text-[10px] text-red-100/70 uppercase tracking-wide">Активная роль</div>
                <div className="text-sm font-semibold text-red-100">
                  {activeAgent?.role ?? "Unknown"} · {activeAgent?.name ?? "None"}
                </div>
              </div>
            </div>
          </div>
        </header>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.95fr)_minmax(390px,1fr)] mt-4">
          <section className="space-y-4">
            <form
              onSubmit={createTask}
              className="grid gap-2 lg:grid-cols-[1fr_auto_auto] border border-red-300/20 bg-black/45 backdrop-blur-sm p-3 rounded-lg"
            >
              <input
                type="text"
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                placeholder="Поставь задачу команде (PM скоординирует всех)..."
                className="bg-black/40 border border-red-200/20 px-3 py-2 text-sm placeholder:text-red-100/35 outline-none focus:border-red-300/55"
                disabled={isRunning}
              />
              <select
                value={taskTargetRole}
                onChange={(e) => setTaskTargetRole(e.target.value as RoleTarget)}
                className="bg-black/40 border border-red-200/20 px-3 py-2 text-sm outline-none focus:border-red-300/55"
              >
                {Object.keys(roleTargetLabel).map((role) => (
                  <option key={role} value={role}>
                    {roleTargetLabel[role as RoleTarget]}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={isRunning}
                className={`px-5 text-xs font-bold uppercase tracking-wide transition border ${
                  isRunning
                    ? "bg-slate-700 border-slate-600 text-slate-300"
                    : "bg-red-500/20 border-red-300/45 text-red-100 hover:bg-red-500/35"
                }`}
              >
                {isRunning ? "Выполнение..." : "Запустить задачу"}
              </button>
            </form>

            <OfficeHub
              agents={agents}
              taskStatus={taskStatus}
              speakingAgentId={speakingAgentId}
              interactionTargetRole={interactionTargetRole}
            />
          </section>

          <aside className="border border-red-300/20 bg-black/55 backdrop-blur-md rounded-lg h-[calc(100vh-190px)] min-h-[620px] max-h-[920px] flex flex-col">
            <div className="px-4 py-3 border-b border-red-200/20">
              <h2 className="text-sm uppercase tracking-[0.18em] text-red-100 font-semibold">
                Командный чат
              </h2>
              <p className="text-xs text-red-100/70 mt-1">
                Общайся с конкретной ролью или всей командой. Координация всегда через PM.
              </p>
            </div>

            <div className="px-4 py-3 border-b border-red-200/20 grid gap-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-red-100/70">Быстрые команды</div>
              <div className="flex flex-wrap gap-2">
                {quickPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => setChatInput(prompt)}
                    className="text-[10px] px-2 py-1 border border-red-200/20 text-red-100/75 hover:text-white hover:border-red-300/50 transition"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>

            <div className="px-4 py-2 border-b border-red-200/20">
              <label className="text-[10px] uppercase tracking-[0.14em] text-red-100/70">Кому адресовать</label>
              <select
                value={chatTargetRole}
                onChange={(e) => setChatTargetRole(e.target.value as RoleTarget)}
                className="mt-1 w-full bg-black/45 border border-red-200/20 px-3 py-2 text-sm outline-none focus:border-red-300/55"
              >
                <option value="Auto">Авто (определит PM)</option>
                <option value="All">Вся команда</option>
                <option value="PM">PM</option>
                <option value="Developer">Developer</option>
                <option value="QA">QA</option>
                <option value="DevOps">DevOps</option>
              </select>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 chat-scroll">
              {chatMessages.map((item) => (
                <div key={item.id} className={item.sender === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={`w-fit max-w-[86%] px-3 py-2 border text-xs leading-relaxed rounded ${
                      item.sender === "user"
                        ? "bg-red-500/20 border-red-300/40 text-red-50"
                        : "bg-black/70 border-red-200/25 text-red-50"
                    }`}
                  >
                    {item.sender === "agent" ? (
                      <div className="text-[10px] uppercase tracking-wide text-red-100/70 mb-1">
                        {item.coordinator === "PM" && item.role && item.role !== "PM"
                          ? `PM -> ${item.agentName ?? item.role}`
                          : item.agentName ?? item.role ?? "Agent"}
                      </div>
                    ) : null}
                    <span className="whitespace-pre-wrap">{item.content}</span>
                  </div>
                </div>
              ))}
              {chatLoading ? (
                <div className="flex justify-start">
                  <div className="px-3 py-2 border border-red-200/25 bg-black/70 text-xs text-red-100/70 rounded">
                    PM координирует ответ...
                  </div>
                </div>
              ) : null}
            </div>

            <form onSubmit={askAgents} className="p-3 border-t border-red-200/20 grid gap-2">
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Напиши запрос. Пример: '@qa проверь регрессию по чату'"
                className="min-h-[86px] max-h-[120px] resize-y bg-black/50 border border-red-200/20 px-3 py-2 text-sm outline-none focus:border-red-300/55"
                disabled={chatLoading}
              />
              <button
                type="submit"
                disabled={chatLoading}
                className="px-4 py-2 text-xs font-bold uppercase tracking-wide border border-red-300/50 bg-red-500/20 text-red-100 hover:bg-red-500/35 transition disabled:opacity-60"
              >
                Отправить
              </button>
            </form>
          </aside>
        </div>
      </div>
    </main>
  );
}
