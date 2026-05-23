import "server-only";

import { randomUUID } from "node:crypto";
import { buildOfficeRoomKey } from "@/lib/offices/utils";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { runAgentWorkflow, type RunAgentWorkflowInput, type RunAgentWorkflowResponse } from "./workflowRunner";
import { logSystemEvent } from "./persistence";
import { patchRoomState, publishTeamEvent } from "./realtime";
import { recordRunSuccessPattern } from "./rufloCore";
import { dispatchBackgroundTriggers } from "./backgroundTriggers";
import { evaluateBudget } from "./budgetGuard";
import { buildDefaultSwarmConfig, detectWorkerTriggers } from "./rufloCoreShared";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentRunMode =
  | "plan"
  | "auto"
  | "manual"
  | "review"
  | "autofix"
  | "approval_required";

export type AgentRunStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

interface AgentRunRow {
  id: string;
  office_id: string;
  task_id: string;
  thread_id?: string | null;
  room_key?: string | null;
  input?: string | null;
  target_role?: string | null;
  mode?: AgentRunMode | string | null;
  status?: AgentRunStatus | string | null;
  attempt_count?: number | null;
  max_attempts?: number | null;
  locked_by?: string | null;
  locked_at?: string | null;
  heartbeat_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  last_error?: string | null;
  failure_category?: string | null;
  blocked_reason?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface AgentRun {
  id: string;
  officeId: string;
  taskId: string;
  threadId: string | null;
  roomKey: string | null;
  input: string | null;
  targetRole: string | null;
  mode: AgentRunMode;
  status: AgentRunStatus;
  attemptCount: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  failureCategory: string | null;
  blockedReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CreateAgentRunInput {
  officeId: string;
  taskId: string;
  input?: string | null;
  targetRole?: string | null;
  threadId?: string | null;
  roomKey?: string | null;
  mode?: AgentRunMode | null;
  metadata?: Record<string, unknown> | null;
}

export interface ProcessAgentRunResult {
  run: AgentRun | null;
  workflow: RunAgentWorkflowResponse | null;
}

const VALID_RUN_MODES = new Set<AgentRunMode>([
  "plan",
  "auto",
  "manual",
  "review",
  "autofix",
  "approval_required",
]);

const DEFAULT_MAX_ATTEMPTS = 2;

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const normalizeString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const normalizeRunMode = (value: unknown): AgentRunMode => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_RUN_MODES.has(normalized as AgentRunMode) ? (normalized as AgentRunMode) : "auto";
};

const normalizeRunStatus = (value: unknown): AgentRunStatus => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    normalized === "queued" ||
    normalized === "running" ||
    normalized === "waiting_approval" ||
    normalized === "completed" ||
    normalized === "failed" ||
    normalized === "cancelled"
  ) {
    return normalized;
  }
  return "queued";
};

const resolveMaxAttempts = (): number => {
  const configured = Number(process.env.AGENT_RUN_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_ATTEMPTS;
};

const normalizeRun = (row: AgentRunRow | null | undefined): AgentRun | null => {
  if (!row?.id || !row.office_id || !row.task_id) return null;
  return {
    id: row.id,
    officeId: row.office_id,
    taskId: row.task_id,
    threadId: normalizeString(row.thread_id),
    roomKey: normalizeString(row.room_key),
    input: typeof row.input === "string" ? row.input : null,
    targetRole: normalizeString(row.target_role),
    mode: normalizeRunMode(row.mode),
    status: normalizeRunStatus(row.status),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? resolveMaxAttempts()),
    lockedBy: normalizeString(row.locked_by),
    lockedAt: normalizeString(row.locked_at),
    heartbeatAt: normalizeString(row.heartbeat_at),
    startedAt: normalizeString(row.started_at),
    finishedAt: normalizeString(row.finished_at),
    lastError: normalizeString(row.last_error),
    failureCategory: normalizeString(row.failure_category),
    blockedReason: normalizeString(row.blocked_reason),
    metadata: toRecord(row.metadata),
    createdAt: normalizeString(row.created_at),
    updatedAt: normalizeString(row.updated_at),
  };
};

const selectRunColumns =
  "id, office_id, task_id, thread_id, room_key, input, target_role, mode, status, attempt_count, max_attempts, locked_by, locked_at, heartbeat_at, started_at, finished_at, last_error, failure_category, blocked_reason, metadata, created_at, updated_at";

export type WorkflowPhase = "routing" | "execution" | "tool_call" | "approval" | "validation" | "result";

export const recordAgentRunStep = async (input: {
  runId: string;
  officeId: string;
  taskId?: string | null;
  stepType: string;
  role?: string | null;
  status: AgentRunStepStatus;
  title?: string | null;
  stepInput?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  phase?: WorkflowPhase | null;
}): Promise<string | null> => {
  if (!isServerSupabaseConfigured) return null;

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("agent_run_steps")
    .insert({
      run_id: input.runId,
      office_id: input.officeId,
      task_id: input.taskId ?? null,
      step_type: input.stepType,
      role: input.role ?? null,
      status: input.status,
      title: input.title ?? null,
      input: input.stepInput ?? {},
      output: input.output ?? {},
      error: input.error ?? null,
      phase: input.phase ?? "execution",
      started_at: input.startedAt ?? (input.status === "running" ? now : null),
      finished_at:
        input.finishedAt ??
        (input.status === "completed" || input.status === "failed" || input.status === "skipped" ? now : null),
      updated_at: now,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[agent-runs] failed to record step:", error.message);
    return null;
  }

  return typeof data?.id === "string" ? data.id : null;
};

export const createAgentRun = async (input: CreateAgentRunInput): Promise<AgentRun> => {
  if (!isServerSupabaseConfigured) {
    throw new Error("Supabase is not configured.");
  }

  const officeId = normalizeString(input.officeId);
  const taskId = normalizeString(input.taskId);
  if (!officeId || !taskId) {
    throw new Error("officeId and taskId are required.");
  }

  // Hard budget gate: refuse new runs when the office is over its token cap.
  // The warn-state downgrade is handled per-call inside invokeAgentModel so
  // in-flight runs are never killed mid-task — only new ones are blocked.
  const budgetEvaluation = await evaluateBudget(officeId).catch((error) => {
    console.warn("[agent-runs] budget evaluation failed:", error);
    return null;
  });
  if (budgetEvaluation?.state === "block") {
    throw new Error("budget_exceeded");
  }

  const roomKey = normalizeString(input.roomKey) ?? buildOfficeRoomKey(officeId);
  const mode = normalizeRunMode(input.mode);
  const status: AgentRunStatus = mode === "approval_required" ? "waiting_approval" : "queued";
  const now = new Date().toISOString();
  const inputMetadata = toRecord(input.metadata);
  const triggerDetection = detectWorkerTriggers(input.input ?? "");
  const metadata = {
    ...inputMetadata,
    swarm: buildDefaultSwarmConfig(toRecord(inputMetadata.swarm)),
    ...(triggerDetection.detected
      ? {
          backgroundTriggers: triggerDetection.triggers,
          backgroundTriggerConfidence: triggerDetection.confidence,
        }
      : {}),
  };

  const { data, error } = await supabase
    .from("agent_runs")
    .insert({
      office_id: officeId,
      task_id: taskId,
      thread_id: normalizeString(input.threadId),
      room_key: roomKey,
      input: typeof input.input === "string" ? input.input : null,
      target_role: normalizeString(input.targetRole) ?? "All",
      mode,
      status,
      max_attempts: resolveMaxAttempts(),
      metadata,
      created_at: now,
      updated_at: now,
    })
    .select(selectRunColumns)
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "agent_run_insert_failed");
  }

  const run = normalizeRun(data as AgentRunRow);
  if (!run) {
    throw new Error("agent_run_normalization_failed");
  }

  await recordAgentRunStep({
    runId: run.id,
    officeId,
    taskId,
    stepType: "run",
    status: status === "queued" ? "pending" : "skipped",
    title: status === "queued" ? "Run queued" : "Run waiting for approval",
    stepInput: {
      targetRole: run.targetRole,
      mode: run.mode,
      threadId: run.threadId,
    },
  });

  await publishTeamEvent({
    roomKey,
    eventName: "agent_run.queued",
    scope: "broadcast",
    senderRole: "Coordinator",
    senderName: "Coordinator",
    targetRole: run.targetRole ?? "All",
    payload: {
      runId: run.id,
      taskId,
      threadId: run.threadId,
      targetRole: run.targetRole,
      mode: run.mode,
      status: run.status,
      officeId,
    },
  });

  return run;
};

export const queueAgentWorkflow = async (input: CreateAgentRunInput): Promise<AgentRun> =>
  createAgentRun({
    ...input,
    mode: input.mode ?? "auto",
    metadata: {
      source: "durable_agent_run",
      queuedAt: new Date().toISOString(),
      validationPolicy: {
        commands: ["npm.cmd run typecheck", "npm.cmd test"],
        sandboxPreferred: true,
        missingSandboxStatus: "approval_required",
      },
      ...(input.metadata ?? {}),
    },
  });

export const listAgentRuns = async (input: {
  officeId: string;
  taskId?: string | null;
  limit?: number | null;
}): Promise<AgentRun[]> => {
  if (!isServerSupabaseConfigured) return [];

  const officeId = normalizeString(input.officeId);
  if (!officeId) return [];

  let query = supabase
    .from("agent_runs")
    .select(selectRunColumns)
    .eq("office_id", officeId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(Number(input.limit ?? 25), 1), 100));

  const taskId = normalizeString(input.taskId);
  if (taskId) {
    query = query.eq("task_id", taskId);
  }

  const { data, error } = await query;
  if (error || !Array.isArray(data)) {
    if (error) console.error("[agent-runs] failed to list runs:", error.message);
    return [];
  }

  return data.map((row) => normalizeRun(row as AgentRunRow)).filter((run): run is AgentRun => Boolean(run));
};

export const getAgentRun = async (runId: string): Promise<AgentRun | null> => {
  if (!isServerSupabaseConfigured) return null;
  const { data, error } = await supabase
    .from("agent_runs")
    .select(selectRunColumns)
    .eq("id", runId)
    .maybeSingle();

  if (error) {
    console.error("[agent-runs] failed to load run:", error.message);
    return null;
  }

  return normalizeRun(data as AgentRunRow | null);
};

const updateRunStatus = async (
  runId: string,
  status: AgentRunStatus,
  patch: Record<string, unknown> = {}
): Promise<AgentRun | null> => {
  const payload = {
    status,
    updated_at: new Date().toISOString(),
    ...patch,
  };
  const { data, error } = await supabase
    .from("agent_runs")
    .update(payload)
    .eq("id", runId)
    .select(selectRunColumns)
    .maybeSingle();

  if (error) {
    console.error("[agent-runs] failed to update run:", error.message);
    return null;
  }

  return normalizeRun(data as AgentRunRow | null);
};

export const heartbeatAgentRun = async (
  runId: string,
  workerId?: string | null
): Promise<void> => {
  if (!isServerSupabaseConfigured) return;
  const payload: Record<string, unknown> = {
    heartbeat_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (normalizeString(workerId)) {
    payload.locked_by = normalizeString(workerId);
  }
  const { error } = await supabase
    .from("agent_runs")
    .update(payload)
    .eq("id", runId)
    .eq("status", "running");
  if (error) {
    console.error("[agent-runs] failed to heartbeat run:", error.message);
  }
};

const claimCandidate = async (
  runId: string,
  workerId: string,
  currentStatus: AgentRunStatus,
  currentLockedAt?: string | null
): Promise<AgentRun | null> => {
  const existing = await getAgentRun(runId);
  if (!existing || existing.attemptCount >= existing.maxAttempts) {
    return null;
  }

  const now = new Date().toISOString();
  let query = supabase
    .from("agent_runs")
    .update({
      status: "running",
      locked_by: workerId,
      locked_at: now,
      heartbeat_at: now,
      started_at: existing.startedAt ?? now,
      attempt_count: existing.attemptCount + 1,
      updated_at: now,
    })
    .eq("id", runId)
    .eq("status", currentStatus);

  if (currentLockedAt) {
    query = query.eq("locked_at", currentLockedAt);
  }

  const { data, error } = await query
    .select(selectRunColumns)
    .maybeSingle();

  if (error) {
    console.error("[agent-runs] failed to claim run:", error.message);
    return null;
  }

  return normalizeRun(data as AgentRunRow | null);
};

export const claimNextAgentRun = async (input: {
  workerId?: string | null;
  officeId?: string | null;
} = {}): Promise<AgentRun | null> => {
  if (!isServerSupabaseConfigured) return null;

  const workerId = normalizeString(input.workerId) ?? `worker-${randomUUID()}`;
  const officeId = normalizeString(input.officeId);
  const lockTtlMs = Number(process.env.AGENT_RUN_LOCK_TTL_MS ?? 600_000);
  const staleBefore = new Date(Date.now() - (Number.isFinite(lockTtlMs) ? lockTtlMs : 600_000)).toISOString();

  let queuedQuery = supabase
    .from("agent_runs")
    .select(selectRunColumns)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(5);
  if (officeId) queuedQuery = queuedQuery.eq("office_id", officeId);

  const { data: queuedRows } = await queuedQuery;
  for (const row of (queuedRows ?? []) as AgentRunRow[]) {
    const claimed = await claimCandidate(row.id, workerId, "queued");
    if (claimed) return claimed;
  }

  let staleQuery = supabase
    .from("agent_runs")
    .select(selectRunColumns)
    .eq("status", "running")
    .lt("heartbeat_at", staleBefore)
    .order("locked_at", { ascending: true })
    .limit(5);
  if (officeId) staleQuery = staleQuery.eq("office_id", officeId);

  const { data: staleRows } = await staleQuery;
  for (const row of (staleRows ?? []) as AgentRunRow[]) {
    const claimed = await claimCandidate(row.id, workerId, "running", row.locked_at ?? null);
    if (claimed) return claimed;
  }

  return null;
};

export const processAgentRun = async (
  runId: string,
  options: { workerId?: string | null } = {}
): Promise<ProcessAgentRunResult> => {
  const run = await getAgentRun(runId);
  if (!run) {
    throw new Error("agent_run_not_found");
  }
  if (run.status === "cancelled" || run.status === "completed") {
    return { run, workflow: null };
  }
  if (run.status === "waiting_approval") {
    return { run, workflow: null };
  }

  const workerId = normalizeString(options.workerId) ?? run.lockedBy ?? `process-${randomUUID()}`;
  const runningRun =
    run.status === "running"
      ? run
      : await updateRunStatus(run.id, "running", {
        locked_by: workerId,
        locked_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        started_at: run.startedAt ?? new Date().toISOString(),
        attempt_count: run.attemptCount + 1,
      });

  if (!runningRun) {
    throw new Error("agent_run_start_failed");
  }

  const stepId = await recordAgentRunStep({
    runId: runningRun.id,
    officeId: runningRun.officeId,
    taskId: runningRun.taskId,
    stepType: "workflow",
    status: "running",
    title: "Worker processing run",
    stepInput: {
      targetRole: runningRun.targetRole,
      mode: runningRun.mode,
      workerId,
    },
  });

  await patchRoomState({
    roomKey: runningRun.roomKey ?? buildOfficeRoomKey(runningRun.officeId),
    mode: "execution",
    taskStatus: "in_progress",
    pendingTaskId: runningRun.taskId,
    metadata: {
      agentRunId: runningRun.id,
      agentRunStatus: "running",
      agentRunMode: runningRun.mode,
      workerId,
    },
  });

  await publishTeamEvent({
    roomKey: runningRun.roomKey ?? buildOfficeRoomKey(runningRun.officeId),
    eventName: "agent_run.started",
    scope: "broadcast",
    senderRole: "Worker",
    senderName: workerId,
    targetRole: runningRun.targetRole ?? "All",
    payload: {
      runId: runningRun.id,
      taskId: runningRun.taskId,
      threadId: runningRun.threadId,
      status: "running",
      officeId: runningRun.officeId,
    },
  });

  const heartbeatMs = Number(process.env.AGENT_RUN_HEARTBEAT_MS ?? 30_000);
  const heartbeatTimer =
    Number.isFinite(heartbeatMs) && heartbeatMs > 0
      ? setInterval(() => {
          void heartbeatAgentRun(runningRun.id, workerId);
        }, heartbeatMs)
      : null;

  let workflowResult: RunAgentWorkflowResponse | null = null;
  try {
    const workflowInput: RunAgentWorkflowInput = {
      taskId: runningRun.taskId,
      input: runningRun.input ?? "",
      targetRole: runningRun.targetRole ?? "All",
      approved: runningRun.mode !== "approval_required",
      officeId: runningRun.officeId,
      roomKey: runningRun.roomKey ?? buildOfficeRoomKey(runningRun.officeId),
      threadId: runningRun.threadId ?? undefined,
      runMetadata: runningRun.metadata,
    };

    workflowResult = await runAgentWorkflow({ ...workflowInput, runId: runningRun.id });

    if (workflowResult.status >= 400) {
      const reason = String(workflowResult.body.error ?? `workflow_status_${workflowResult.status}`);
      const canRetry = runningRun.attemptCount < runningRun.maxAttempts;
      const nextStatus: AgentRunStatus = canRetry ? "queued" : "failed";
      const failedRun = await updateRunStatus(runningRun.id, nextStatus, {
        finished_at: canRetry ? null : new Date().toISOString(),
        last_error: reason,
        failure_category: canRetry ? "retryable" : "dead_letter",
        locked_by: null,
        locked_at: null,
        heartbeat_at: null,
      });
      await recordAgentRunStep({
        runId: runningRun.id,
        officeId: runningRun.officeId,
        taskId: runningRun.taskId,
        stepType: "workflow",
        status: "failed",
        title: "Workflow failed",
        output: { status: workflowResult.status },
        error: reason,
      });
      await logSystemEvent({
        level: "error",
        scope: "agent-runs",
        event: "agent_run_failed",
        taskId: runningRun.taskId,
        metadata: { runId: runningRun.id, reason, stepId },
      });
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      return { run: failedRun, workflow: workflowResult };
    }

    const waitingForApproval = Boolean(workflowResult.body.paused);
    const nextStatus: AgentRunStatus = waitingForApproval ? "waiting_approval" : "completed";
    const finishedRun = await updateRunStatus(runningRun.id, nextStatus, {
      finished_at: waitingForApproval ? null : new Date().toISOString(),
      locked_by: null,
      locked_at: null,
      heartbeat_at: null,
      last_error: null,
      blocked_reason: waitingForApproval ? "waiting_for_human_or_validation" : null,
    });

    if (!waitingForApproval) {
      await recordRunSuccessPattern({ run: finishedRun, workflow: workflowResult }).catch((error) => {
        console.warn("[agent-runs] success memory pattern skipped:", error);
      });
      // Background trigger dispatch is gated by ENABLE_BACKGROUND_TRIGGERS so the
      // default behaviour stays supervised. Failures here must never tank the
      // primary run's completion path.
      await dispatchBackgroundTriggers({ run: finishedRun }).catch((error) => {
        console.warn("[agent-runs] background trigger dispatch skipped:", error);
      });
    }

    await recordAgentRunStep({
      runId: runningRun.id,
      officeId: runningRun.officeId,
      taskId: runningRun.taskId,
      stepType: "workflow",
      status: "completed",
      title: waitingForApproval ? "Workflow paused for approval" : "Workflow completed",
      output: {
        status: workflowResult.status,
        paused: waitingForApproval,
      },
    });

    await publishTeamEvent({
      roomKey: runningRun.roomKey ?? buildOfficeRoomKey(runningRun.officeId),
      eventName: waitingForApproval ? "agent_run.waiting_approval" : "agent_run.completed",
      scope: "broadcast",
      senderRole: "Worker",
      senderName: workerId,
      targetRole: runningRun.targetRole ?? "All",
      payload: {
        runId: runningRun.id,
        taskId: runningRun.taskId,
        threadId: runningRun.threadId,
        status: nextStatus,
        officeId: runningRun.officeId,
      },
      requiresAck: waitingForApproval,
    });

    if (heartbeatTimer) clearInterval(heartbeatTimer);
    return { run: finishedRun, workflow: workflowResult };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "agent_run_failed";
    const canRetry = runningRun.attemptCount < runningRun.maxAttempts;
    const nextStatus: AgentRunStatus = canRetry ? "queued" : "failed";
    const failedRun = await updateRunStatus(runningRun.id, nextStatus, {
      finished_at: canRetry ? null : new Date().toISOString(),
      last_error: reason,
      failure_category: canRetry ? "retryable" : "dead_letter",
      locked_by: null,
      locked_at: null,
      heartbeat_at: null,
    });
    await recordAgentRunStep({
      runId: runningRun.id,
      officeId: runningRun.officeId,
      taskId: runningRun.taskId,
      stepType: "workflow",
      status: "failed",
      title: "Worker error",
      error: reason,
    });
    await publishTeamEvent({
      roomKey: runningRun.roomKey ?? buildOfficeRoomKey(runningRun.officeId),
      eventName: canRetry ? "agent_run.retry_queued" : "agent_run.failed",
      scope: "broadcast",
      senderRole: "Worker",
      senderName: workerId,
      targetRole: runningRun.targetRole ?? "All",
      payload: {
        runId: runningRun.id,
        taskId: runningRun.taskId,
        reason,
        retryQueued: canRetry,
        officeId: runningRun.officeId,
      },
    });
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    return { run: failedRun, workflow: workflowResult };
  }
};

export const approveAgentRun = async (runId: string): Promise<AgentRun | null> => {
  const existingRun = await getAgentRun(runId);
  if (existingRun && isServerSupabaseConfigured) {
    const { data: taskRow } = await supabase
      .from("tasks")
      .select("metadata")
      .eq("id", existingRun.taskId)
      .eq("office_id", existingRun.officeId)
      .maybeSingle();
    await supabase
      .from("tasks")
      .update({
        status: "pending",
        metadata: {
          ...toRecord(taskRow?.metadata),
          approved: true,
          approved_at: new Date().toISOString(),
          approvalSource: "agent_run_approval",
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingRun.taskId)
      .eq("office_id", existingRun.officeId);
  }
  const run = await updateRunStatus(runId, "queued", {
    locked_by: null,
    locked_at: null,
    heartbeat_at: null,
    finished_at: null,
    last_error: null,
    blocked_reason: null,
  });
  if (run) {
    await recordAgentRunStep({
      runId: run.id,
      officeId: run.officeId,
      taskId: run.taskId,
      stepType: "approval",
      status: "completed",
      title: "Run approved",
    });
  }
  return run;
};

export const cancelAgentRun = async (runId: string): Promise<AgentRun | null> => {
  const run = await updateRunStatus(runId, "cancelled", {
    finished_at: new Date().toISOString(),
    locked_by: null,
    locked_at: null,
    heartbeat_at: null,
  });
  if (run) {
    await recordAgentRunStep({
      runId: run.id,
      officeId: run.officeId,
      taskId: run.taskId,
      stepType: "cancel",
      status: "completed",
      title: "Run cancelled",
    });
  }
  return run;
};
