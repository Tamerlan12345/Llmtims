import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface SystemLogEvent {
  level?: LogLevel;
  scope: string;
  event: string;
  actorEmail?: string | null;
  taskId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PersistedWorkflowState {
  task_id: string;
  office_id?: string | null;
  room_key?: string | null;
  workflow_status?: string | null;
  waiting_for_human?: boolean;
  current_assignee?: string | null;
  [key: string]: unknown;
}

interface SaveWorkflowCheckpointInput {
  taskId: string;
  officeId?: string | null;
  roomKey?: string | null;
  state: PersistedWorkflowState;
  status?: string | null;
  waitingForHuman?: boolean;
  currentAssignee?: string | null;
}

const memoryWorkflowStore = new Map<string, PersistedWorkflowState>();

interface CheckpointConfig {
  configurable?: Record<string, unknown>;
}

class OfficeWorkflowCheckpointer {
  at: "end_of_step" | "end_of_run" = "end_of_step";
  private storage = new Map<string, unknown>();

  private resolveThreadId(config: CheckpointConfig | undefined): string | null {
    const configurable =
      config && typeof config === "object" && config.configurable && typeof config.configurable === "object"
        ? config.configurable
        : {};
    const candidateValues = [
      configurable.threadId,
      configurable.thread_id,
      configurable.task_id,
      configurable.taskId,
    ];

    for (const value of candidateValues) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }

    return null;
  }

  get(config: CheckpointConfig): unknown | undefined {
    const threadId = this.resolveThreadId(config);
    if (!threadId) return undefined;
    return this.storage.get(threadId);
  }

  put(config: CheckpointConfig, checkpoint: unknown): void {
    const threadId = this.resolveThreadId(config);
    if (!threadId) return;
    this.storage.set(threadId, checkpoint);
  }

  clear(threadId: string): void {
    if (!threadId) return;
    this.storage.delete(threadId);
  }
}

export const checkpointer = new OfficeWorkflowCheckpointer();

const normalizeLevel = (level?: LogLevel): LogLevel => {
  if (!level) return "info";
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    return level;
  }
  return "info";
};

export const logSystemEvent = async ({
  level,
  scope,
  event,
  actorEmail,
  taskId,
  metadata,
}: SystemLogEvent): Promise<void> => {
  const logLevel = normalizeLevel(level);
  const payload = {
    level: logLevel,
    scope,
    event,
    actor_email: actorEmail ?? null,
    task_id: taskId ?? null,
    metadata: metadata ?? {},
  };

  if (!isServerSupabaseConfigured) {
    const method = logLevel === "error" ? "error" : logLevel === "warn" ? "warn" : "log";
    console[method](`[log:${scope}] ${event}`, payload.metadata);
    return;
  }

  try {
    const { error } = await supabase.from("system_logs").insert(payload);
    if (error) {
      console.error("[log] failed to persist event:", error.message, payload);
    }
  } catch (writeError) {
    console.error("[log] unexpected persistence error:", writeError, payload);
  }
};

export const saveWorkflowCheckpoint = async ({
  taskId,
  officeId = null,
  roomKey = null,
  state,
  status = null,
  waitingForHuman,
  currentAssignee = null,
}: SaveWorkflowCheckpointInput): Promise<void> => {
  const normalizedState = {
    ...state,
    task_id: taskId,
    office_id: officeId,
    room_key: roomKey,
  };

  if (!isServerSupabaseConfigured) {
    memoryWorkflowStore.set(taskId, normalizedState);
    return;
  }

  const payload = {
    task_id: taskId,
    office_id: officeId,
    room_key: roomKey,
    status: status ?? String(state.workflow_status ?? "running"),
    waiting_for_human:
      typeof waitingForHuman === "boolean"
        ? waitingForHuman
        : Boolean(state.waiting_for_human),
    current_assignee:
      currentAssignee ??
      (typeof state.current_assignee === "string" ? state.current_assignee : null),
    state: normalizedState,
    updated_at: new Date().toISOString(),
  };

  try {
    const { error } = await supabase.from("workflow_checkpoints").upsert(payload, {
      onConflict: "task_id",
    });
    if (error) {
      console.error("[workflow] failed to persist checkpoint:", error.message, payload);
    }
  } catch (error) {
    console.error("[workflow] unexpected checkpoint error:", error, payload);
  }
};

export const getWorkflowCheckpoint = async (
  taskId: string,
  officeId?: string | null
): Promise<PersistedWorkflowState | null> => {
  if (!taskId) return null;

  if (!isServerSupabaseConfigured) {
    return memoryWorkflowStore.get(taskId) ?? null;
  }

  try {
    let query = supabase.from("workflow_checkpoints").select("state").eq("task_id", taskId);
    if (officeId) {
      query = query.eq("office_id", officeId);
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.error("[workflow] failed to read checkpoint:", error.message);
      return null;
    }

    return (data?.state as PersistedWorkflowState | null) ?? null;
  } catch (error) {
    console.error("[workflow] unexpected checkpoint read error:", error);
    return null;
  }
};

export const clearWorkflowCheckpoint = async (
  taskId: string,
  officeId?: string | null
): Promise<void> => {
  if (!taskId) return;

  checkpointer.clear(taskId);

  if (!isServerSupabaseConfigured) {
    memoryWorkflowStore.delete(taskId);
    return;
  }

  try {
    let query = supabase.from("workflow_checkpoints").delete().eq("task_id", taskId);
    if (officeId) {
      query = query.eq("office_id", officeId);
    }
    const { error } = await query;
    if (error) {
      console.error("[workflow] failed to clear checkpoint:", error.message);
    }
  } catch (error) {
    console.error("[workflow] unexpected checkpoint delete error:", error);
  }
};
