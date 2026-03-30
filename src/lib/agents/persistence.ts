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

export const checkpointer = null;
