"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentRunTimelineItem,
  AgentRunView,
  AgentWorkerHealth,
  ApprovalRequestView,
  TracePayload,
} from "@/app/dashboard/types";
import { IconSpinner } from "@/components/icons";
import { repairTextForDisplay } from "@/lib/text/repairMojibake";

interface OperatorReviewPanelProps {
  officeId: string | null;
  selectedTaskId: string | null;
}

const chipClass = (value?: string | null) => {
  if (
    value === "allowed" ||
    value === "approved" ||
    value === "completed" ||
    value === "passed" ||
    value === "ready" ||
    value === "idle" ||
    value === "running"
  ) {
    return "border-emerald-300/25 bg-emerald-500/10 text-emerald-100";
  }
  if (
    value === "approval_required" ||
    value === "pending" ||
    value === "waiting_approval" ||
    value === "skipped" ||
    value === "queued" ||
    value === "retryable"
  ) {
    return "border-amber-300/25 bg-amber-500/10 text-amber-100";
  }
  if (value === "denied" || value === "rejected" || value === "failed" || value === "cancelled" || value === "stale" || value === "dead_letter") {
    return "border-red-300/25 bg-red-500/10 text-red-100";
  }
  return "border-rose-100/15 bg-white/[0.03] text-rose-100/65";
};

const statusText: Record<string, string> = {
  idle: "idle",
  running: "running",
  stale: "stale",
  queued: "queued",
  waiting_approval: "approval",
  completed: "done",
  failed: "failed",
  retryable: "retry",
  dead_letter: "dead",
};

const labelStatus = (value?: string | null) => statusText[value ?? ""] ?? value ?? "unknown";

const compactJson = (value: unknown) => {
  if (!value) return "";
  try {
    return JSON.stringify(value).slice(0, 180);
  } catch {
    return "";
  }
};

const formatTime = (raw?: string | null) => {
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const formatAge = (raw?: string | null) => {
  if (!raw) return "нет heartbeat";
  const date = new Date(raw);
  const ageMs = Date.now() - date.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return "";
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 90) return `${seconds}s назад`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}м назад`;
  return `${Math.round(minutes / 60)}ч назад`;
};

const timelineTimestamp = (item: AgentRunTimelineItem) => {
  if ("created_at" in item && item.created_at) return item.created_at;
  if ("createdAt" in item && item.createdAt) return item.createdAt;
  return null;
};

const timelineTitle = (item: AgentRunTimelineItem) => {
  if (item._type === "tool_invocation") {
    return item.toolId ?? "tool";
  }
  if (item._type === "approval") {
    return item.actionSummary || item.toolId || "approval";
  }
  return item.title || item.stepType || item.phase || "workflow step";
};

const timelineStatus = (item: AgentRunTimelineItem) => {
  if (item._type === "tool_invocation") return item.decision ?? item.status ?? "unknown";
  if (item._type === "approval") return item.decision ?? item.status ?? item.riskLevel ?? "unknown";
  return item.status ?? item.phase ?? "unknown";
};

const timelineDetail = (item: AgentRunTimelineItem) => {
  if (item._type === "tool_invocation") {
    return [item.riskLevel, item.status].filter(Boolean).join(" / ");
  }
  if (item._type === "approval") {
    return [item.toolId, item.riskLevel].filter(Boolean).join(" / ");
  }
  return [item.agentRole ?? item.role, item.phase, item.summary].filter(Boolean).join(" / ");
};

export default function OperatorReviewPanel({ officeId, selectedTaskId }: OperatorReviewPanelProps) {
  const [approvals, setApprovals] = useState<ApprovalRequestView[]>([]);
  const [run, setRun] = useState<AgentRunView | null>(null);
  const [trace, setTrace] = useState<TracePayload | null>(null);
  const [workerHealth, setWorkerHealth] = useState<AgentWorkerHealth | null>(null);
  const [toolDetails, setToolDetails] = useState<Record<string, string>>({});
  const [loadingDetailToken, setLoadingDetailToken] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const loadApprovals = useCallback(async () => {
    if (!officeId) {
      setApprovals([]);
      return;
    }
    const response = await fetch(`/api/approval-requests?officeId=${encodeURIComponent(officeId)}&status=pending&limit=8`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { approvalRequests?: ApprovalRequestView[] };
    setApprovals(Array.isArray(payload.approvalRequests) ? payload.approvalRequests : []);
  }, [officeId]);

  const loadTrace = useCallback(async () => {
    if (!officeId || !selectedTaskId) {
      setRun(null);
      setTrace(null);
      return;
    }

    const runsResponse = await fetch(
      `/api/agent-runs?officeId=${encodeURIComponent(officeId)}&taskId=${encodeURIComponent(selectedTaskId)}&limit=1`,
      { cache: "no-store" }
    );
    if (!runsResponse.ok) return;

    const runsPayload = (await runsResponse.json()) as { runs?: AgentRunView[] };
    const latestRun = Array.isArray(runsPayload.runs) ? runsPayload.runs[0] : null;
    setRun(latestRun ?? null);

    if (!latestRun?.id) {
      setTrace(null);
      return;
    }

    const traceResponse = await fetch(`/api/agent-runs/${encodeURIComponent(latestRun.id)}/trace?officeId=${encodeURIComponent(officeId)}`, {
      cache: "no-store",
    });
    if (!traceResponse.ok) return;
    setTrace((await traceResponse.json()) as TracePayload);
  }, [officeId, selectedTaskId]);

  const loadWorkerHealth = useCallback(async () => {
    if (!officeId) {
      setWorkerHealth(null);
      return;
    }
    const response = await fetch(`/api/agent-workers/health?officeId=${encodeURIComponent(officeId)}`, {
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = (await response.json()) as { health?: AgentWorkerHealth };
    setWorkerHealth(payload.health ?? null);
  }, [officeId]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      await Promise.all([loadApprovals(), loadTrace(), loadWorkerHealth()]);
    } finally {
      setIsLoading(false);
    }
  }, [loadApprovals, loadTrace, loadWorkerHealth]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const decide = useCallback(
    async (id: string, action: "approve" | "reject") => {
      if (!officeId || actingId) return;
      setActingId(id);
      try {
        await fetch(`/api/approval-requests/${encodeURIComponent(id)}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ officeId }),
        });
        await refresh();
      } finally {
        setActingId(null);
      }
    },
    [actingId, officeId, refresh]
  );

  const loadToolDetail = useCallback(
    async (detailToken: string) => {
      if (!officeId || !run?.id || toolDetails[detailToken] || loadingDetailToken) return;
      setLoadingDetailToken(detailToken);
      try {
        const response = await fetch(
          `/api/agent-runs/${encodeURIComponent(run.id)}/tool-details/${encodeURIComponent(detailToken)}?officeId=${encodeURIComponent(officeId)}`,
          { cache: "no-store" }
        );
        if (!response.ok) return;
        const payload = (await response.json()) as { detail?: { fullDetail?: string | null } };
        if (typeof payload.detail?.fullDetail === "string") {
          setToolDetails((current) => ({ ...current, [detailToken]: payload.detail?.fullDetail ?? "" }));
        }
      } finally {
        setLoadingDetailToken(null);
      }
    },
    [loadingDetailToken, officeId, run?.id, toolDetails]
  );

  const timeline = useMemo(() => trace?.timeline?.slice(-12) ?? [], [trace]);
  const taskGroups = trace?.taskGroups ?? [];
  const memoryHits = trace?.memoryHits ?? [];
  const swarm = trace?.swarm ?? null;
  const counters = useMemo(
    () => ({
      steps: trace?.steps?.length ?? 0,
      tools: trace?.toolInvocations?.length ?? 0,
      validations: trace?.validations?.length ?? 0,
      artifacts: trace?.artifacts?.length ?? 0,
    }),
    [trace]
  );
  const workerRun = workerHealth?.currentRun ?? null;

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-2xl border border-red-200/10 bg-black/40">
      <div className="flex items-center justify-between border-b border-red-200/10 px-3 py-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-rose-100/55">Supervised autopilot</div>
          <div className="text-xs font-semibold text-rose-50">Контроль выполнения</div>
        </div>
        {isLoading ? <IconSpinner /> : <span className="text-[10px] text-rose-100/45">{approvals.length} pending</span>}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 chat-scroll custom-scrollbar">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/55">Worker runtime</div>
              <div className="mt-0.5 text-xs text-rose-50">
                {workerRun?.workerId ?? "Нет активного worker"}
              </div>
            </div>
            {workerHealth ? (
              <span className={`rounded-md border px-2 py-1 text-[9px] uppercase ${chipClass(workerHealth.status)}`}>
                {labelStatus(workerHealth.status)}
              </span>
            ) : null}
          </div>

          {workerHealth ? (
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-4 gap-1.5 text-center text-[10px] text-rose-100/65">
                <span className="rounded-md bg-white/[0.04] px-2 py-1">{workerHealth.queuedCount} queue</span>
                <span className="rounded-md bg-white/[0.04] px-2 py-1">{workerHealth.runningCount} run</span>
                <span className="rounded-md bg-white/[0.04] px-2 py-1">{workerHealth.retryQueuedCount} retry</span>
                <span className="rounded-md bg-white/[0.04] px-2 py-1">{workerHealth.deadLetterCount} dead</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <span className="rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-1 text-[9px] uppercase text-rose-100/65">
                  hb {formatAge(workerHealth.lastHeartbeatAt)}
                </span>
                {workerHealth.waitingApprovalCount ? (
                  <span className={`rounded-md border px-2 py-1 text-[9px] uppercase ${chipClass("waiting_approval")}`}>
                    approvals {workerHealth.waitingApprovalCount}
                  </span>
                ) : null}
                {workerRun ? (
                  <span className={`rounded-md border px-2 py-1 text-[9px] uppercase ${chipClass(workerRun.isStale ? "stale" : workerRun.status)}`}>
                    run {workerRun.id.slice(0, 8)}
                  </span>
                ) : null}
              </div>
              {workerRun ? (
                <div className="truncate text-[10px] text-rose-100/55">
                  Task {workerRun.taskId.slice(0, 8)} / попытка {workerRun.attemptCount}/{workerRun.maxAttempts || "-"}
                </div>
              ) : null}
              {workerHealth.retryRuns.length || workerHealth.deadLetterRuns.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {workerHealth.retryRuns.slice(0, 2).map((retryRun) => (
                    <span key={retryRun.id} className={`rounded-md border px-2 py-1 text-[9px] ${chipClass("retryable")}`}>
                      retry {retryRun.id.slice(0, 8)}
                    </span>
                  ))}
                  {workerHealth.deadLetterRuns.slice(0, 2).map((deadRun) => (
                    <span key={deadRun.id} className={`rounded-md border px-2 py-1 text-[9px] ${chipClass("dead_letter")}`}>
                      dead {deadRun.id.slice(0, 8)}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-2 text-xs text-rose-100/45">Worker health пока недоступен.</div>
          )}
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/55">Выбранный run</div>
            {run ? <span className={`rounded-md border px-2 py-1 text-[9px] uppercase ${chipClass(run.status)}`}>{labelStatus(run.status)}</span> : null}
          </div>

          {!selectedTaskId ? (
            <div className="mt-2 text-xs text-rose-100/45">Выберите задачу, чтобы увидеть автономный run.</div>
          ) : !run ? (
            <div className="mt-2 text-xs text-rose-100/45">Для выбранной задачи пока нет durable run.</div>
          ) : (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {run.mode ? <span className={`rounded-md border px-2 py-1 text-[9px] uppercase ${chipClass(run.mode)}`}>{run.mode}</span> : null}
                {typeof run.attemptCount === "number" ? (
                  <span className="rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-1 text-[9px] uppercase text-rose-100/65">
                    attempts {run.attemptCount}
                  </span>
                ) : null}
                {run.heartbeatAt ? (
                  <span className="rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-1 text-[9px] uppercase text-rose-100/65">
                    hb {formatTime(run.heartbeatAt)}
                  </span>
                ) : null}
              </div>
              {run.blockedReason ? <div className="text-xs text-amber-100">Блокировка: {repairTextForDisplay(run.blockedReason)}</div> : null}
              {run.failureCategory ? <div className="text-xs text-red-100">Ошибка: {run.failureCategory}</div> : null}
              <div className="grid grid-cols-4 gap-1.5 text-center text-[10px] text-rose-100/65">
                <span className="rounded-md bg-white/[0.04] px-2 py-1">{counters.steps} steps</span>
                <span className="rounded-md bg-white/[0.04] px-2 py-1">{counters.tools} tools</span>
                <span className="rounded-md bg-white/[0.04] px-2 py-1">{counters.validations} checks</span>
                <span className="rounded-md bg-white/[0.04] px-2 py-1">{counters.artifacts} files</span>
              </div>
            </div>
          )}
        </div>

        {swarm ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/55">Swarm config</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-1 text-[9px] uppercase text-rose-100/65">
                {swarm.topology}
              </span>
              <span className="rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-1 text-[9px] uppercase text-rose-100/65">
                {swarm.strategy}
              </span>
              <span className="rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-1 text-[9px] uppercase text-rose-100/65">
                max {swarm.maxAgents}
              </span>
              <span className="rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-1 text-[9px] uppercase text-rose-100/65">
                {swarm.consensusMode}
              </span>
              <span className="rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-1 text-[9px] uppercase text-rose-100/65">
                ns:{swarm.memoryNamespace}
              </span>
              <span
                className={`rounded-md border px-2 py-1 text-[9px] uppercase ${chipClass(
                  swarm.antiDrift.coordinatorGate ? "completed" : "failed"
                )}`}
              >
                {swarm.antiDrift.coordinatorGate ? "coordinator gate" : "gate off"}
              </span>
              <span className="rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-1 text-[9px] uppercase text-rose-100/65">
                iter {swarm.antiDrift.maxIterations}
              </span>
              <span className="rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-1 text-[9px] uppercase text-rose-100/65">
                rework {swarm.antiDrift.reworkLimit}
              </span>
            </div>
          </div>
        ) : null}

        {taskGroups.length ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/55">Группы tool tasks</div>
            <div className="mt-2 space-y-2">
              {taskGroups.map((group) => {
                const isOpen = expandedGroups[group.id] ?? false;
                return (
                  <div key={group.id} className="rounded-lg border border-white/10 bg-black/20">
                    <button
                      type="button"
                      onClick={() => setExpandedGroups((current) => ({ ...current, [group.id]: !isOpen }))}
                      className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left"
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-[10px] text-rose-100/45">{isOpen ? "▾" : "▸"}</span>
                        <span className="text-xs font-semibold text-rose-50">Шаг {group.step}</span>
                        <span className="text-[10px] text-rose-100/45">{group.tasks.length} tool(s)</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        {group.durationMs ? (
                          <span className="text-[9px] text-rose-100/40">{group.durationMs}ms</span>
                        ) : null}
                        <span className={`rounded-md border px-2 py-0.5 text-[9px] uppercase ${chipClass(group.status)}`}>
                          {labelStatus(group.status)}
                        </span>
                      </span>
                    </button>
                    {isOpen ? (
                      <div className="space-y-1.5 border-t border-white/10 px-2.5 py-2">
                        {group.tasks.map((task) => (
                          <div key={task.id} className="rounded-md bg-white/[0.03] px-2 py-1.5">
                            <div className="flex items-start justify-between gap-2">
                              <span className="truncate font-mono text-[11px] text-rose-50">{task.toolName}</span>
                              <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] uppercase ${chipClass(task.decision ?? task.status)}`}>
                                {labelStatus(task.decision ?? task.status)}
                              </span>
                            </div>
                            {task.argsPreview ? (
                              <div className="mt-1 break-all rounded bg-black/30 px-2 py-1 font-mono text-[10px] text-rose-100/55">
                                {repairTextForDisplay(task.argsPreview)}
                              </div>
                            ) : null}
                            {task.summary ? (
                              <div className="mt-1 text-[10px] text-rose-100/60">{repairTextForDisplay(task.summary)}</div>
                            ) : null}
                            {task.detailToken ? (
                              toolDetails[task.detailToken] !== undefined ? (
                                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 px-2 py-1 font-mono text-[10px] text-rose-100/60">
                                  {repairTextForDisplay(toolDetails[task.detailToken])}
                                </pre>
                              ) : (
                                <button
                                  type="button"
                                  disabled={loadingDetailToken !== null}
                                  onClick={() => void loadToolDetail(task.detailToken as string)}
                                  className="mt-1 rounded-md border border-rose-100/15 bg-white/[0.03] px-2 py-0.5 text-[9px] uppercase text-rose-100/65 disabled:opacity-50"
                                >
                                  {loadingDetailToken === task.detailToken ? "Загрузка…" : "Показать вывод"}
                                </button>
                              )
                            ) : null}
                            <div className="mt-1 flex items-center gap-2 text-[9px] text-rose-100/35">
                              {task.riskLevel ? <span>{task.riskLevel}</span> : null}
                              {task.durationMs ? <span>{task.durationMs}ms</span> : null}
                              {task.createdAt ? <span>{formatTime(task.createdAt)}</span> : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {memoryHits.length ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/55">Память: совпадения</div>
            <div className="mt-2 space-y-1.5">
              {memoryHits.map((hit) => (
                <div key={hit.id} className="rounded-md bg-white/[0.03] px-2 py-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-[11px] font-semibold text-rose-50">{repairTextForDisplay(hit.summary || hit.key)}</span>
                    <span className="shrink-0 rounded-md border border-rose-100/15 bg-white/[0.03] px-1.5 py-0.5 text-[9px] text-rose-100/65">
                      {Math.round(hit.score * 100)}%
                    </span>
                  </div>
                  {hit.valuePreview ? (
                    <div className="mt-1 break-all text-[10px] text-rose-100/55">{repairTextForDisplay(hit.valuePreview)}</div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px] text-rose-100/35">
                    <span>ns:{hit.namespace}</span>
                    <span>conf {Math.round(hit.confidence * 100)}%</span>
                    {hit.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="rounded bg-white/[0.04] px-1.5 py-0.5">{tag}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          {approvals.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-rose-100/55">
              Нет tool actions, ожидающих approval.
            </div>
          ) : (
            approvals.map((approval) => (
              <div key={approval.id} className="rounded-xl border border-amber-300/20 bg-amber-500/10 px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-amber-50">{repairTextForDisplay(approval.actionSummary)}</div>
                    <div className="mt-1 truncate text-[10px] text-amber-100/65">{approval.toolId}</div>
                  </div>
                  <span className={`shrink-0 rounded-md border px-2 py-1 text-[9px] uppercase ${chipClass(approval.riskLevel)}`}>
                    {approval.riskLevel}
                  </span>
                </div>
                {compactJson(approval.arguments) ? (
                  <div className="mt-2 break-all rounded-lg bg-black/30 px-2 py-1 font-mono text-[10px] text-amber-50/70">
                    {compactJson(approval.arguments)}
                  </div>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={actingId === approval.id}
                    onClick={() => void decide(approval.id, "approve")}
                    className="rounded-md border border-emerald-300/25 bg-emerald-500/10 px-2 py-1 text-[10px] uppercase text-emerald-100 disabled:opacity-50"
                  >
                    Одобрить
                  </button>
                  <button
                    type="button"
                    disabled={actingId === approval.id}
                    onClick={() => void decide(approval.id, "reject")}
                    className="rounded-md border border-red-300/25 bg-red-500/10 px-2 py-1 text-[10px] uppercase text-red-100 disabled:opacity-50"
                  >
                    Отклонить
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
          <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/55">Timeline run</div>
          {timeline.length === 0 ? (
            <div className="mt-2 text-xs text-rose-100/45">Trace появится после записи шагов worker.</div>
          ) : (
            <div className="mt-3 space-y-2">
              {timeline.map((item, index) => {
                const status = timelineStatus(item);
                const detail = timelineDetail(item);
                return (
                  <div key={`${item._type}-${item.id}-${index}`} className="border-l border-red-200/15 pl-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-rose-50">{repairTextForDisplay(timelineTitle(item))}</div>
                        {detail ? <div className="mt-0.5 truncate text-[10px] text-rose-100/55">{repairTextForDisplay(detail)}</div> : null}
                      </div>
                      <span className={`shrink-0 rounded-md border px-2 py-1 text-[9px] uppercase ${chipClass(status)}`}>{labelStatus(status)}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-rose-100/40">
                      <span>{item._type.replace("_", " ")}</span>
                      {item.phase ? <span>{item.phase}</span> : null}
                      {timelineTimestamp(item) ? <span>{formatTime(timelineTimestamp(item))}</span> : null}
                      {item.durationMs ? <span>{item.durationMs}ms</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {trace?.artifacts?.length ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/55">Артефакты</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {trace.artifacts.map((artifact) => (
                <span key={artifact.id} className={`rounded-md border px-2 py-1 text-[9px] ${chipClass(artifact.status)}`}>
                  {artifact.artifact_type ? `${artifact.artifact_type}: ` : ""}
                  {repairTextForDisplay(artifact.title ?? artifact.id)}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
