import "server-only";

import { buildOfficeRoomKey } from "@/lib/offices/utils";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { queueAgentWorkflow, type AgentRun, type AgentRunMode } from "./runService";
import { patchRoomState, publishTeamEvent, type TeamEventScope } from "./realtime";

interface TaskRunTaskRow {
  id: string;
  description: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
  office_id?: string | null;
}

export interface QueueTaskRunInput {
  officeId: string;
  input: string;
  targetRole?: string | null;
  taskId?: string | null;
  threadId?: string | null;
  roomKey?: string | null;
  mode?: AgentRunMode | null;
  source?: string | null;
  clientMessageId?: string | null;
  coordinatorRole?: string | null;
  coordinatorName?: string | null;
  scope?: TeamEventScope | null;
  metadata?: Record<string, unknown> | null;
}

export interface QueueTaskRunResult {
  taskId: string;
  taskDescription: string;
  run: AgentRun;
}

const normalizeString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const createTaskTitle = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Agent task";
  return normalized.length > 90 ? `${normalized.slice(0, 87)}...` : normalized;
};

const bindThreadToTask = async (threadId: string | null, officeId: string, taskId: string): Promise<void> => {
  if (!threadId || !isServerSupabaseConfigured) return;

  const { data } = await supabase
    .from("chat_threads")
    .select("metadata")
    .eq("id", threadId)
    .eq("office_id", officeId)
    .maybeSingle();

  const currentMetadata =
    data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : {};

  await supabase
    .from("chat_threads")
    .update({
      metadata: {
        ...currentMetadata,
        activeTaskId: taskId,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", threadId)
    .eq("office_id", officeId);
};

const resolveTaskForRun = async ({
  officeId,
  taskId,
  input,
  targetRole,
  threadId,
  coordinatorRole,
  source,
  clientMessageId,
  metadata,
  approvedAt,
}: {
  officeId: string;
  taskId: string | null;
  input: string;
  targetRole: string;
  threadId: string | null;
  coordinatorRole: string;
  source: string;
  clientMessageId: string | null;
  metadata: Record<string, unknown>;
  approvedAt: string;
}): Promise<{ taskId: string; taskDescription: string }> => {
  if (taskId) {
    const { data: existingTask, error: existingTaskError } = await supabase
      .from("tasks")
      .select("id, description, status, metadata, office_id")
      .eq("id", taskId)
      .eq("office_id", officeId)
      .maybeSingle();

    if (existingTaskError) {
      throw new Error(existingTaskError.message);
    }

    if (existingTask?.id) {
      const taskRow = existingTask as TaskRunTaskRow;
      const currentStatus = String(taskRow.status ?? "pending");
      if (currentStatus === "done" || currentStatus === "failed" || currentStatus === "archived") {
        throw new Error("task_not_actionable");
      }

      const taskDescription = taskRow.description?.trim() || input;
      const { error: updateError } = await supabase
        .from("tasks")
        .update({
          status: "pending",
          current_assignee: coordinatorRole,
          office_id: officeId,
          metadata: {
            ...(taskRow.metadata ?? {}),
            ...metadata,
            approved: true,
            approved_at: approvedAt,
            targetRole,
            initiatedBy: source,
            threadId,
            clientMessageId,
          },
          updated_at: approvedAt,
        })
        .eq("id", taskRow.id)
        .eq("office_id", officeId);

      if (updateError) {
        throw new Error(updateError.message);
      }

      return { taskId: taskRow.id, taskDescription };
    }
  }

  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .insert({
      title: createTaskTitle(input),
      description: input,
      status: "pending",
      office_id: officeId,
      current_assignee: coordinatorRole,
      metadata: {
        ...metadata,
        approved: true,
        approved_at: approvedAt,
        targetRole,
        initiatedBy: source,
        threadId,
        clientMessageId,
      },
    })
    .select("id")
    .single();

  if (taskError || !task?.id) {
    throw new Error(taskError?.message ?? "task_insert_failed");
  }

  return { taskId: task.id as string, taskDescription: input };
};

export const queueTaskRun = async (input: QueueTaskRunInput): Promise<QueueTaskRunResult> => {
  if (!isServerSupabaseConfigured) {
    throw new Error("Supabase is not configured.");
  }

  const officeId = normalizeString(input.officeId);
  const taskInput = normalizeString(input.input);
  if (!officeId || !taskInput) {
    throw new Error("officeId and input are required.");
  }

  const approvedAt = new Date().toISOString();
  const targetRole = normalizeString(input.targetRole) ?? "All";
  const roomKey = normalizeString(input.roomKey) ?? buildOfficeRoomKey(officeId);
  const source = normalizeString(input.source) ?? "task-runs";
  const coordinatorRole = normalizeString(input.coordinatorRole) ?? "Coordinator";
  const coordinatorName = normalizeString(input.coordinatorName) ?? coordinatorRole;
  const threadId = normalizeString(input.threadId);
  const clientMessageId = normalizeString(input.clientMessageId);
  const scope = input.scope ?? "broadcast";

  const task = await resolveTaskForRun({
    officeId,
    taskId: normalizeString(input.taskId),
    input: taskInput,
    targetRole,
    threadId,
    coordinatorRole,
    source,
    clientMessageId,
    metadata: input.metadata ?? {},
    approvedAt,
  });

  await bindThreadToTask(threadId, officeId, task.taskId);

  const run = await queueAgentWorkflow({
    taskId: task.taskId,
    input: task.taskDescription,
    targetRole,
    roomKey,
    officeId,
    threadId,
    mode: input.mode ?? "auto",
    metadata: {
      source,
      clientMessageId,
      ...(input.metadata ?? {}),
    },
  });

  await patchRoomState({
    roomKey,
    mode: "execution",
    taskStatus: "in_progress",
    activeRole: coordinatorRole,
    pendingTaskId: task.taskId,
    metadata: {
      executionQueuedBy: source,
      executionQueuedAt: approvedAt,
      targetRole,
      lastContextTaskId: task.taskId,
      officeId,
      agentRunId: run.id,
      agentRunStatus: run.status,
    },
  });

  await publishTeamEvent({
    roomKey,
    eventName: "workflow.execution_queued",
    scope,
    senderRole: coordinatorRole,
    senderName: coordinatorName,
    targetRole,
    payload: {
      taskId: task.taskId,
      threadId,
      targetRole,
      sourceMessage: task.taskDescription,
      clientMessageId,
      officeId,
      runId: run.id,
    },
  });

  return {
    taskId: task.taskId,
    taskDescription: task.taskDescription,
    run,
  };
};
