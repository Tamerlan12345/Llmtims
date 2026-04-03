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

interface CheckpointConfig {
  configurable?: Record<string, unknown>;
}

interface LangGraphCheckpoint {
  v: number;
  ts: string;
  channelValues: Record<string, unknown>;
  channelVersions: Record<string, number>;
  versionsSeen: Record<string, Record<string, number>>;
}

interface LangGraphCheckpointRow {
  checkpoint?: unknown;
  metadata?: unknown;
  office_id?: string | null;
}

const memoryWorkflowStore = new Map<string, PersistedWorkflowState>();

const cloneJsonValue = <T>(value: T): T => {
  if (value === undefined) {
    return value;
  }

  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
};

const normalizeThreadValue = (value: unknown): string | null => {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

const toRecord = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const resolveCheckpointConfig = (config?: CheckpointConfig): Record<string, unknown> => {
  return config && typeof config === "object" && config.configurable && typeof config.configurable === "object"
    ? config.configurable
    : {};
};

const resolveThreadIdFromConfig = (config?: CheckpointConfig): string | null => {
  const configurable = resolveCheckpointConfig(config);
  const candidateValues = [
    configurable.threadId,
    configurable.thread_id,
    configurable.task_id,
    configurable.taskId,
  ];

  for (const value of candidateValues) {
    const normalized = normalizeThreadValue(value);
    if (normalized) return normalized;
  }

  return null;
};

const resolveOfficeIdFromConfig = (config?: CheckpointConfig): string | null => {
  const configurable = resolveCheckpointConfig(config);
  const candidateValues = [configurable.officeId, configurable.office_id, configurable.office];

  for (const value of candidateValues) {
    const normalized = normalizeThreadValue(value);
    if (normalized) return normalized;
  }

  return null;
};

const isLangGraphCheckpoint = (value: unknown): value is LangGraphCheckpoint => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.v === "number" &&
    typeof row.ts === "string" &&
    row.channelValues !== null &&
    typeof row.channelValues === "object" &&
    !Array.isArray(row.channelValues) &&
    row.channelVersions !== null &&
    typeof row.channelVersions === "object" &&
    !Array.isArray(row.channelVersions) &&
    row.versionsSeen !== null &&
    typeof row.versionsSeen === "object" &&
    !Array.isArray(row.versionsSeen)
  );
};

const getCheckpointStepIndex = (checkpoint: LangGraphCheckpoint): number => {
  const values = Object.values(checkpoint.channelVersions ?? {})
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (values.length === 0) return 0;
  return Math.max(...values);
};

const buildCheckpointFromState = (state: PersistedWorkflowState): LangGraphCheckpoint => {
  const normalizedState = cloneJsonValue(state);
  const stepIndex =
    typeof normalizedState.iterations === "number" && Number.isFinite(normalizedState.iterations)
      ? Math.max(0, Math.floor(normalizedState.iterations))
      : 0;

  return {
    v: 1,
    ts: new Date().toISOString(),
    channelValues: normalizedState,
    channelVersions: {
      __root__: stepIndex,
      iterations: stepIndex,
    },
    versionsSeen: {},
  };
};

const extractStateFromCheckpoint = (
  taskId: string,
  officeId: string | null,
  checkpoint: LangGraphCheckpoint
): PersistedWorkflowState => {
  const channelValues = toRecord(checkpoint.channelValues);
  return {
    ...channelValues,
    task_id: normalizeThreadValue(channelValues.task_id) ?? taskId,
    office_id: normalizeThreadValue(channelValues.office_id) ?? officeId,
  };
};

const persistLangGraphCheckpointRecord = async (
  taskId: string,
  officeId: string | null,
  checkpoint: LangGraphCheckpoint,
  metadata?: Record<string, unknown> | null
): Promise<void> => {
  if (!taskId || !isServerSupabaseConfigured) {
    return;
  }

  try {
    const payload = {
      thread_id: taskId,
      task_id: taskId,
      office_id: officeId,
      checkpoint: cloneJsonValue(checkpoint),
      metadata: metadata ?? {},
      step_index: getCheckpointStepIndex(checkpoint),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase.from("langgraph_checkpoints").upsert(payload, {
      onConflict: "thread_id",
    });
    if (error) {
      console.error("[workflow] failed to persist langgraph checkpoint:", error.message, payload);
    }
  } catch (error) {
    console.error("[workflow] unexpected langgraph checkpoint error:", error);
  }
};

const loadLangGraphCheckpointRecord = async (
  taskId: string,
  officeId?: string | null
): Promise<LangGraphCheckpointRow | null> => {
  if (!taskId || !isServerSupabaseConfigured) {
    return null;
  }

  try {
    let query = supabase
      .from("langgraph_checkpoints")
      .select("checkpoint, metadata, office_id")
      .eq("thread_id", taskId);
    if (officeId) {
      query = query.eq("office_id", officeId);
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.error("[workflow] failed to read langgraph checkpoint:", error.message);
      return null;
    }

    return (data as LangGraphCheckpointRow | null) ?? null;
  } catch (error) {
    console.error("[workflow] unexpected langgraph checkpoint read error:", error);
    return null;
  }
};

const loadLegacyWorkflowCheckpointState = async (
  taskId: string,
  officeId?: string | null
): Promise<PersistedWorkflowState | null> => {
  if (!taskId || !isServerSupabaseConfigured) {
    return null;
  }

  try {
    let query = supabase.from("workflow_checkpoints").select("state").eq("task_id", taskId);
    if (officeId) {
      query = query.eq("office_id", officeId);
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.error("[workflow] failed to read legacy checkpoint:", error.message);
      return null;
    }

    const state = data?.state;
    return state && typeof state === "object" && !Array.isArray(state)
      ? (state as PersistedWorkflowState)
      : null;
  } catch (error) {
    console.error("[workflow] unexpected legacy checkpoint read error:", error);
    return null;
  }
};

class OfficeWorkflowCheckpointer {
  at: "end_of_step" | "end_of_run" = "end_of_step";
  private storage = new Map<string, LangGraphCheckpoint>();

  get(config: CheckpointConfig): LangGraphCheckpoint | undefined {
    const threadId = resolveThreadIdFromConfig(config);
    if (!threadId) return undefined;
    const checkpoint = this.storage.get(threadId);
    return checkpoint ? cloneJsonValue(checkpoint) : undefined;
  }

  put(config: CheckpointConfig, checkpoint: unknown): void {
    const threadId = resolveThreadIdFromConfig(config);
    if (!threadId || !isLangGraphCheckpoint(checkpoint)) return;

    const officeId =
      resolveOfficeIdFromConfig(config) ??
      normalizeThreadValue((checkpoint.channelValues as Record<string, unknown>)?.office_id) ??
      null;
    const cloned = cloneJsonValue(checkpoint);
    this.storage.set(threadId, cloned);
    memoryWorkflowStore.set(threadId, extractStateFromCheckpoint(threadId, officeId, cloned));

    void persistLangGraphCheckpointRecord(threadId, officeId, cloned, {
      source: "langgraph",
      persistedAt: new Date().toISOString(),
    });
  }

  hydrate(threadId: string, checkpoint: LangGraphCheckpoint): void {
    if (!threadId) return;
    this.storage.set(threadId, cloneJsonValue(checkpoint));
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

export const hydrateWorkflowCheckpoint = async (
  taskId: string,
  officeId?: string | null
): Promise<PersistedWorkflowState | null> => {
  if (!taskId) return null;

  const inMemoryState = memoryWorkflowStore.get(taskId);
  if (inMemoryState) {
    return cloneJsonValue(inMemoryState);
  }

  const inMemoryCheckpoint = checkpointer.get({ configurable: { thread_id: taskId, office_id: officeId ?? null } });
  if (inMemoryCheckpoint && isLangGraphCheckpoint(inMemoryCheckpoint)) {
    const state = extractStateFromCheckpoint(taskId, officeId ?? null, inMemoryCheckpoint);
    memoryWorkflowStore.set(taskId, state);
    return cloneJsonValue(state);
  }

  if (!isServerSupabaseConfigured) {
    return null;
  }

  const langGraphRow = await loadLangGraphCheckpointRecord(taskId, officeId);
  if (langGraphRow && isLangGraphCheckpoint(langGraphRow.checkpoint)) {
    const normalizedOfficeId = normalizeThreadValue(langGraphRow.office_id) ?? officeId ?? null;
    const state = extractStateFromCheckpoint(taskId, normalizedOfficeId, langGraphRow.checkpoint);
    checkpointer.hydrate(taskId, langGraphRow.checkpoint);
    memoryWorkflowStore.set(taskId, state);
    return cloneJsonValue(state);
  }

  const legacyState = await loadLegacyWorkflowCheckpointState(taskId, officeId);
  if (!legacyState) {
    return null;
  }

  const normalizedState: PersistedWorkflowState = {
    ...legacyState,
    task_id: normalizeThreadValue(legacyState.task_id) ?? taskId,
    office_id: normalizeThreadValue(legacyState.office_id) ?? officeId ?? null,
  };
  const checkpoint = buildCheckpointFromState(normalizedState);
  checkpointer.hydrate(taskId, checkpoint);
  memoryWorkflowStore.set(taskId, normalizedState);
  await persistLangGraphCheckpointRecord(taskId, normalizedState.office_id ?? null, checkpoint, {
    source: "legacy_workflow_checkpoints",
    migratedAt: new Date().toISOString(),
  });

  return cloneJsonValue(normalizedState);
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
  const normalizedState: PersistedWorkflowState = {
    ...state,
    task_id: taskId,
    office_id: officeId,
    room_key: roomKey,
    workflow_status: status ?? String(state.workflow_status ?? "running"),
    waiting_for_human:
      typeof waitingForHuman === "boolean" ? waitingForHuman : Boolean(state.waiting_for_human),
    current_assignee:
      currentAssignee ??
      (typeof state.current_assignee === "string" ? state.current_assignee : null),
  };

  memoryWorkflowStore.set(taskId, cloneJsonValue(normalizedState));

  const checkpoint = buildCheckpointFromState(normalizedState);
  checkpointer.hydrate(taskId, checkpoint);
  await persistLangGraphCheckpointRecord(taskId, officeId, checkpoint, {
    source: "state_snapshot",
    status: normalizedState.workflow_status ?? "running",
    waitingForHuman: normalizedState.waiting_for_human ?? false,
    currentAssignee: normalizedState.current_assignee ?? null,
  });
};

export const getWorkflowCheckpoint = async (
  taskId: string,
  officeId?: string | null
): Promise<PersistedWorkflowState | null> => {
  return hydrateWorkflowCheckpoint(taskId, officeId);
};

export const clearWorkflowCheckpoint = async (
  taskId: string,
  officeId?: string | null
): Promise<void> => {
  if (!taskId) return;

  checkpointer.clear(taskId);
  memoryWorkflowStore.delete(taskId);

  if (!isServerSupabaseConfigured) {
    return;
  }

  try {
    let nextCheckpointQuery = supabase.from("langgraph_checkpoints").delete().eq("thread_id", taskId);
    if (officeId) {
      nextCheckpointQuery = nextCheckpointQuery.eq("office_id", officeId);
    }
    const { error: nextCheckpointError } = await nextCheckpointQuery;
    if (nextCheckpointError) {
      console.error("[workflow] failed to clear langgraph checkpoint:", nextCheckpointError.message);
    }
  } catch (error) {
    console.error("[workflow] unexpected langgraph checkpoint delete error:", error);
  }

  try {
    let legacyQuery = supabase.from("workflow_checkpoints").delete().eq("task_id", taskId);
    if (officeId) {
      legacyQuery = legacyQuery.eq("office_id", officeId);
    }
    const { error } = await legacyQuery;
    if (error) {
      console.error("[workflow] failed to clear legacy checkpoint:", error.message);
    }
  } catch (error) {
    console.error("[workflow] unexpected legacy checkpoint delete error:", error);
  }
};

