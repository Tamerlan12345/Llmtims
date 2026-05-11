"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconSpinner } from "@/components/icons";

interface OperatorReviewPanelProps {
  officeId: string | null;
  selectedTaskId: string | null;
}

interface ApprovalRequestView {
  id: string;
  runId?: string | null;
  taskId?: string | null;
  toolId: string;
  riskLevel: string;
  actionSummary: string;
  arguments?: unknown;
  resource?: string | null;
  status: string;
}

interface AgentRunView {
  id: string;
  taskId?: string | null;
  status: string;
  blockedReason?: string | null;
  failureCategory?: string | null;
}

interface TracePayload {
  run?: AgentRunView | null;
  steps?: Array<{ id: string; title?: string | null; stepType?: string | null; status?: string | null }>;
  validations?: Array<{ id: string; status?: string | null; toolName?: string | null }>;
  approvals?: ApprovalRequestView[];
  toolInvocations?: Array<{ id: string; toolId?: string | null; decision?: string | null; riskLevel?: string | null; status?: string | null }>;
  artifacts?: Array<{ id: string; title?: string | null; artifact_type?: string | null; status?: string | null }>;
}

const chipClass = (value?: string | null) => {
  if (value === "allowed" || value === "approved" || value === "completed" || value === "passed") {
    return "border-emerald-300/25 bg-emerald-500/10 text-emerald-100";
  }
  if (value === "approval_required" || value === "pending" || value === "waiting_approval" || value === "skipped") {
    return "border-amber-300/25 bg-amber-500/10 text-amber-100";
  }
  if (value === "denied" || value === "rejected" || value === "failed") {
    return "border-red-300/25 bg-red-500/10 text-red-100";
  }
  return "border-rose-100/15 bg-white/[0.03] text-rose-100/65";
};

const compactJson = (value: unknown) => {
  if (!value) return "";
  try {
    return JSON.stringify(value).slice(0, 180);
  } catch {
    return "";
  }
};

export default function OperatorReviewPanel({ officeId, selectedTaskId }: OperatorReviewPanelProps) {
  const [approvals, setApprovals] = useState<ApprovalRequestView[]>([]);
  const [run, setRun] = useState<AgentRunView | null>(null);
  const [trace, setTrace] = useState<TracePayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const loadApprovals = useCallback(async () => {
    if (!officeId) {
      setApprovals([]);
      return;
    }
    const response = await fetch(`/api/approval-requests?officeId=${encodeURIComponent(officeId)}&status=pending&limit=6`);
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
      `/api/agent-runs?officeId=${encodeURIComponent(officeId)}&taskId=${encodeURIComponent(selectedTaskId)}&limit=1`
    );
    if (!runsResponse.ok) return;
    const runsPayload = (await runsResponse.json()) as { runs?: AgentRunView[] };
    const latestRun = Array.isArray(runsPayload.runs) ? runsPayload.runs[0] : null;
    setRun(latestRun ?? null);
    if (!latestRun?.id) {
      setTrace(null);
      return;
    }
    const traceResponse = await fetch(`/api/agent-runs/${encodeURIComponent(latestRun.id)}/trace?officeId=${encodeURIComponent(officeId)}`);
    if (!traceResponse.ok) return;
    setTrace((await traceResponse.json()) as TracePayload);
  }, [officeId, selectedTaskId]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      await Promise.all([loadApprovals(), loadTrace()]);
    } finally {
      setIsLoading(false);
    }
  }, [loadApprovals, loadTrace]);

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

  const traceItems = useMemo(() => {
    const items: Array<{ id: string; label: string; value: string }> = [];
    for (const invocation of trace?.toolInvocations?.slice(0, 5) ?? []) {
      items.push({
        id: invocation.id,
        label: invocation.toolId ?? "tool",
        value: invocation.decision ?? invocation.status ?? "unknown",
      });
    }
    for (const validation of trace?.validations?.slice(0, 3) ?? []) {
      items.push({
        id: validation.id,
        label: validation.toolName ?? "validation",
        value: validation.status ?? "unknown",
      });
    }
    return items.slice(0, 6);
  }, [trace]);

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-2xl border border-red-200/10 bg-black/40">
      <div className="flex items-center justify-between border-b border-red-200/10 px-3 py-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-rose-100/55">Оператор</div>
          <div className="text-xs font-semibold text-rose-50">Approvals и trace</div>
        </div>
        {isLoading ? <IconSpinner /> : <span className="text-[10px] text-rose-100/45">{approvals.length} pending</span>}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 chat-scroll custom-scrollbar">
        <div className="space-y-2">
          {approvals.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-rose-100/55">
              Нет действий, ожидающих подтверждения.
            </div>
          ) : (
            approvals.map((approval) => (
              <div key={approval.id} className="rounded-xl border border-amber-300/20 bg-amber-500/10 px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold text-amber-50">{approval.actionSummary}</div>
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
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={actingId === approval.id}
                    onClick={() => void decide(approval.id, "reject")}
                    className="rounded-md border border-red-300/25 bg-red-500/10 px-2 py-1 text-[10px] uppercase text-red-100 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-[0.16em] text-rose-100/55">Selected run</div>
            {run ? <span className={`rounded-md border px-2 py-1 text-[9px] uppercase ${chipClass(run.status)}`}>{run.status}</span> : null}
          </div>
          {!selectedTaskId ? (
            <div className="mt-2 text-xs text-rose-100/45">Выберите задачу, чтобы увидеть trace.</div>
          ) : !run ? (
            <div className="mt-2 text-xs text-rose-100/45">Для задачи пока нет run.</div>
          ) : (
            <div className="mt-2 space-y-2">
              {run.blockedReason ? <div className="text-xs text-amber-100">Blocked: {run.blockedReason}</div> : null}
              {traceItems.length === 0 ? (
                <div className="text-xs text-rose-100/45">Trace пока пуст.</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {traceItems.map((item) => (
                    <span key={item.id} className={`rounded-md border px-2 py-1 text-[9px] ${chipClass(item.value)}`}>
                      {item.label}: {item.value}
                    </span>
                  ))}
                </div>
              )}
              {trace?.artifacts?.length ? (
                <div className="text-[10px] text-rose-100/60">
                  Artifacts: {trace.artifacts.map((artifact) => artifact.title ?? artifact.id).join(", ")}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
