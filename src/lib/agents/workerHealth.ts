import "server-only";

import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

export type AgentWorkerHealthStatus = "idle" | "running" | "stale";

interface AgentRunHealthRow {
  id: string;
  task_id: string;
  status: string;
  locked_by?: string | null;
  locked_at?: string | null;
  heartbeat_at?: string | null;
  attempt_count?: number | null;
  max_attempts?: number | null;
  failure_category?: string | null;
  last_error?: string | null;
  blocked_reason?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export interface AgentWorkerRunHealth {
  id: string;
  taskId: string;
  status: string;
  workerId: string | null;
  lockedAt: string | null;
  heartbeatAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  failureCategory: string | null;
  lastError: string | null;
  blockedReason: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  isStale: boolean;
}

export interface AgentWorkerHealth {
  status: AgentWorkerHealthStatus;
  staleAfterMs: number;
  now: string;
  runningCount: number;
  queuedCount: number;
  waitingApprovalCount: number;
  retryQueuedCount: number;
  deadLetterCount: number;
  lastHeartbeatAt: string | null;
  currentRun: AgentWorkerRunHealth | null;
  activeRuns: AgentWorkerRunHealth[];
  retryRuns: AgentWorkerRunHealth[];
  deadLetterRuns: AgentWorkerRunHealth[];
}

const RUN_HEALTH_COLUMNS =
  "id, task_id, status, locked_by, locked_at, heartbeat_at, attempt_count, max_attempts, failure_category, last_error, blocked_reason, updated_at, created_at";

const normalizeString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const resolveStaleAfterMs = (): number => {
  const configured = Number(process.env.AGENT_RUN_LOCK_TTL_MS ?? 600_000);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 600_000;
};

const heartbeatIsStale = (heartbeatAt: string | null, staleBeforeMs: number): boolean => {
  if (!heartbeatAt) return true;
  const heartbeatMs = new Date(heartbeatAt).getTime();
  return !Number.isFinite(heartbeatMs) || heartbeatMs < staleBeforeMs;
};

const mapRun = (row: AgentRunHealthRow, staleBeforeMs: number): AgentWorkerRunHealth => {
  const heartbeatAt = normalizeString(row.heartbeat_at);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    status: String(row.status ?? "unknown"),
    workerId: normalizeString(row.locked_by),
    lockedAt: normalizeString(row.locked_at),
    heartbeatAt,
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 0),
    failureCategory: normalizeString(row.failure_category),
    lastError: normalizeString(row.last_error),
    blockedReason: normalizeString(row.blocked_reason),
    updatedAt: normalizeString(row.updated_at),
    createdAt: normalizeString(row.created_at),
    isStale: heartbeatIsStale(heartbeatAt, staleBeforeMs),
  };
};

const countRuns = async (
  officeId: string,
  status: string,
  failureCategory?: string
): Promise<number> => {
  let query = supabase
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("office_id", officeId)
    .eq("status", status);

  if (failureCategory) {
    query = query.eq("failure_category", failureCategory);
  }

  const { count, error } = await query;
  if (error) {
    console.error("[worker-health] failed to count runs:", error.message);
    return 0;
  }
  return Number(count ?? 0);
};

export const getAgentWorkerHealth = async (officeId: string): Promise<AgentWorkerHealth> => {
  const staleAfterMs = resolveStaleAfterMs();
  const now = new Date();
  const staleBeforeMs = now.getTime() - staleAfterMs;

  if (!isServerSupabaseConfigured) {
    return {
      status: "idle",
      staleAfterMs,
      now: now.toISOString(),
      runningCount: 0,
      queuedCount: 0,
      waitingApprovalCount: 0,
      retryQueuedCount: 0,
      deadLetterCount: 0,
      lastHeartbeatAt: null,
      currentRun: null,
      activeRuns: [],
      retryRuns: [],
      deadLetterRuns: [],
    };
  }

  const [runningResult, retryResult, deadLetterResult, queuedCount, waitingApprovalCount, retryQueuedCount, deadLetterCount] =
    await Promise.all([
      supabase
        .from("agent_runs")
        .select(RUN_HEALTH_COLUMNS)
        .eq("office_id", officeId)
        .eq("status", "running")
        .order("heartbeat_at", { ascending: false, nullsFirst: false })
        .limit(20),
      supabase
        .from("agent_runs")
        .select(RUN_HEALTH_COLUMNS)
        .eq("office_id", officeId)
        .eq("status", "queued")
        .eq("failure_category", "retryable")
        .order("updated_at", { ascending: false })
        .limit(5),
      supabase
        .from("agent_runs")
        .select(RUN_HEALTH_COLUMNS)
        .eq("office_id", officeId)
        .eq("status", "failed")
        .eq("failure_category", "dead_letter")
        .order("updated_at", { ascending: false })
        .limit(5),
      countRuns(officeId, "queued"),
      countRuns(officeId, "waiting_approval"),
      countRuns(officeId, "queued", "retryable"),
      countRuns(officeId, "failed", "dead_letter"),
    ]);

  if (runningResult.error) {
    console.error("[worker-health] failed to load running runs:", runningResult.error.message);
  }
  if (retryResult.error) {
    console.error("[worker-health] failed to load retry runs:", retryResult.error.message);
  }
  if (deadLetterResult.error) {
    console.error("[worker-health] failed to load dead-letter runs:", deadLetterResult.error.message);
  }

  const activeRuns = ((runningResult.data ?? []) as AgentRunHealthRow[]).map((row) => mapRun(row, staleBeforeMs));
  const retryRuns = ((retryResult.data ?? []) as AgentRunHealthRow[]).map((row) => mapRun(row, staleBeforeMs));
  const deadLetterRuns = ((deadLetterResult.data ?? []) as AgentRunHealthRow[]).map((row) => mapRun(row, staleBeforeMs));
  const freshRuns = activeRuns.filter((run) => !run.isStale);
  const staleRuns = activeRuns.filter((run) => run.isStale);
  const currentRun = freshRuns[0] ?? staleRuns[0] ?? null;
  const lastHeartbeatAt = activeRuns.find((run) => run.heartbeatAt)?.heartbeatAt ?? null;

  return {
    status: freshRuns.length > 0 ? "running" : staleRuns.length > 0 ? "stale" : "idle",
    staleAfterMs,
    now: now.toISOString(),
    runningCount: activeRuns.length,
    queuedCount,
    waitingApprovalCount,
    retryQueuedCount,
    deadLetterCount,
    lastHeartbeatAt,
    currentRun,
    activeRuns,
    retryRuns,
    deadLetterRuns,
  };
};
