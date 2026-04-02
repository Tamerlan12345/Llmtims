import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { DEFAULT_ROOM_KEY } from "@/lib/offices/utils";

export type TeamRole = string;
export type TeamEventScope = "broadcast" | "targeted" | "system";
export type RoomMode = "discussion" | "approval" | "execution";
export type PlayerStatus = "idle" | "typing" | "working" | "waiting" | "monitoring" | "offline";
export type AgentRuntimeStatus = "idle" | "working" | "error";

interface PublishTeamEventInput {
  roomKey?: string;
  eventName: string;
  scope: TeamEventScope;
  senderRole?: TeamRole | null;
  senderName?: string | null;
  targetRole?: TeamRole | null;
  payload?: Record<string, unknown> | null;
  requiresAck?: boolean;
  ttlMs?: number | null;
}

interface RoomStatePatch {
  roomKey?: string;
  mode?: RoomMode;
  taskStatus?: string;
  activeRole?: TeamRole | null;
  activeAgentId?: string | null;
  pendingTaskId?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface AgentRow {
  id: string;
  role: string;
  name?: string | null;
}

interface PlayerStatePatch {
  roomKey?: string;
  officeId?: string | null;
  status?: PlayerStatus;
  isOnline?: boolean;
  typingUntil?: string | null;
  metadata?: Record<string, unknown> | null;
  tokensTotal?: number;
}

interface AgentRuntimePatch {
  officeId?: string | null;
  status?: AgentRuntimeStatus;
  currentAction?: string | null;
  currentSkill?: string | null;
  currentTargetX?: number | null;
  currentTargetY?: number | null;
  metadata?: Record<string, unknown> | null;
}

interface RoomStateRow {
  mode: RoomMode;
  task_status: string;
  active_role: string | null;
  active_agent_id: string | null;
  pending_task_id: string | null;
  revision: number;
  metadata: Record<string, unknown> | null;
}

const sanitizeRole = (role?: string | null): string | null => {
  if (typeof role !== "string") return null;
  const normalized = role.trim();
  return normalized.length > 0 ? normalized : null;
};

const isMissingPlayerStateOfficeIdError = (message?: string): boolean => {
  const normalized = String(message ?? "").toLowerCase();
  return (
    normalized.includes("office_id") &&
    normalized.includes("player_state") &&
    (normalized.includes("schema cache") || normalized.includes("does not exist"))
  );
};

const getAgentByRole = async (role: string, officeId?: string | null): Promise<AgentRow | null> => {
  if (!isServerSupabaseConfigured || role === "All") return null;

  let query = supabase.from("agents").select("id, role, name").eq("role", role);
  if (officeId) {
    query = query.eq("office_id", officeId);
  }

  const { data, error } = await query.limit(1);
  if (error) {
    console.error(`[realtime] failed to resolve role ${role}:`, error.message);
    return null;
  }

  const first = Array.isArray(data) ? data[0] : null;
  return (first as AgentRow | null) ?? null;
};

export const publishTeamEvent = async ({
  roomKey = DEFAULT_ROOM_KEY,
  eventName,
  scope,
  senderRole,
  senderName,
  targetRole,
  payload,
  requiresAck = false,
  ttlMs = null,
}: PublishTeamEventInput): Promise<string | null> => {
  if (!isServerSupabaseConfigured) return null;

  const row = {
    room_key: roomKey,
    event_name: eventName,
    scope,
    sender_role: sanitizeRole(senderRole),
    sender_name: senderName ?? null,
    target_role: sanitizeRole(targetRole),
    payload: payload ?? {},
    requires_ack: requiresAck,
    ttl_ms: ttlMs,
  };

  const { data, error } = await supabase.from("team_events").insert(row).select("id").single();
  if (error) {
    console.error("[realtime] failed to publish event:", error.message, row);
    return null;
  }

  return String((data as { id?: string } | null)?.id ?? "");
};

export const patchRoomState = async ({
  roomKey = DEFAULT_ROOM_KEY,
  mode,
  taskStatus,
  activeRole,
  activeAgentId,
  pendingTaskId,
  metadata,
}: RoomStatePatch): Promise<void> => {
  if (!isServerSupabaseConfigured) return;

  const { data: currentData } = await supabase
    .from("room_state")
    .select("mode, task_status, active_role, active_agent_id, pending_task_id, revision, metadata")
    .eq("room_key", roomKey)
    .maybeSingle();

  const current = (currentData as RoomStateRow | null) ?? null;
  const nextRevision = Number(current?.revision ?? 0) + 1;
  const nextMetadata = {
    ...(current?.metadata ?? {}),
    ...(metadata ?? {}),
  };

  const payload = {
    room_key: roomKey,
    mode: mode ?? current?.mode ?? "discussion",
    task_status: taskStatus ?? current?.task_status ?? "pending",
    active_role: sanitizeRole(activeRole ?? current?.active_role),
    active_agent_id: activeAgentId ?? current?.active_agent_id ?? null,
    pending_task_id: pendingTaskId ?? current?.pending_task_id ?? null,
    metadata: nextMetadata,
    revision: nextRevision,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("room_state").upsert(payload, { onConflict: "room_key" });
  if (error) {
    console.error("[realtime] failed to patch room state:", error.message, payload);
  }
};

export const patchPlayerStateByRole = async (
  role: string,
  patch: PlayerStatePatch = {}
): Promise<void> => {
  if (!isServerSupabaseConfigured || role === "All") return;

  const agent = await getAgentByRole(role, patch.officeId);
  if (!agent?.id) return;

  await patchPlayerStateByAgent(agent.id, agent.role, patch);
};

export const patchPlayerStateByAgent = async (
  agentId: string,
  role: string,
  {
    roomKey = DEFAULT_ROOM_KEY,
    officeId = null,
    status = "idle",
    isOnline = true,
    typingUntil = null,
    metadata = null,
    tokensTotal,
  }: PlayerStatePatch = {}
): Promise<void> => {
  if (!isServerSupabaseConfigured) return;

  const { data: currentData } = await supabase
    .from("player_state")
    .select("metadata, tokens_total")
    .eq("room_key", roomKey)
    .eq("agent_id", agentId)
    .maybeSingle();

  const current =
    (currentData as { metadata?: Record<string, unknown> | null; tokens_total?: number } | null) ?? null;
  const nextMetadata = {
    ...(current?.metadata ?? {}),
    ...(metadata ?? {}),
  };

  const payload = {
    room_key: roomKey,
    agent_id: agentId,
    role,
    office_id: officeId,
    status,
    is_online: isOnline,
    typing_until: typingUntil,
    metadata: nextMetadata,
    tokens_total:
      Number.isFinite(tokensTotal) && tokensTotal !== undefined
        ? Math.max(0, Math.round(tokensTotal))
        : Number(current?.tokens_total ?? 0),
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const runUpsert = (row: Record<string, unknown>) =>
    supabase.from("player_state").upsert(row, {
      onConflict: "room_key,agent_id",
    });

  let { error } = await runUpsert(payload as Record<string, unknown>);
  if (error && isMissingPlayerStateOfficeIdError(error.message)) {
    const fallbackPayload = { ...(payload as Record<string, unknown>) };
    delete fallbackPayload.office_id;
    const fallbackResult = await runUpsert(fallbackPayload);
    error = fallbackResult.error;
  }

  if (error) {
    console.error("[realtime] failed to patch player state:", error.message, payload);
  }
};

export const patchAgentRuntimeByRole = async (
  role: string,
  patch: AgentRuntimePatch = {}
): Promise<void> => {
  if (!isServerSupabaseConfigured || role === "All") return;

  const agent = await getAgentByRole(role, patch.officeId);
  if (!agent?.id) return;

  await patchAgentRuntimeByAgent(agent.id, patch);
};

export const patchAgentRuntimeByAgent = async (
  agentId: string,
  {
    officeId = null,
    status = "idle",
    currentAction = null,
    currentSkill = null,
    currentTargetX = null,
    currentTargetY = null,
    metadata = null,
  }: AgentRuntimePatch = {}
): Promise<void> => {
  if (!isServerSupabaseConfigured) return;

  const { data: currentData } = await supabase
    .from("agent_states")
    .select("metadata")
    .eq("agent_id", agentId)
    .maybeSingle();

  const current = (currentData as { metadata?: Record<string, unknown> | null } | null) ?? null;
  const nextMetadata = {
    ...(current?.metadata ?? {}),
    ...(metadata ?? {}),
  };

  const payload = {
    agent_id: agentId,
    office_id: officeId,
    status,
    current_action: currentAction,
    current_skill: currentSkill,
    current_target_x: Number.isFinite(currentTargetX) ? Math.round(currentTargetX ?? 0) : null,
    current_target_y: Number.isFinite(currentTargetY) ? Math.round(currentTargetY ?? 0) : null,
    metadata: nextMetadata,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("agent_states").upsert(payload, {
    onConflict: "agent_id",
  });

  if (error) {
    console.error("[realtime] failed to patch agent runtime:", error.message, payload);
  }
};

export const setRoleTypingState = async (
  role: string,
  typing: boolean,
  roomKey = DEFAULT_ROOM_KEY,
  officeId?: string | null
): Promise<void> => {
  if (role === "All") return;

  const typingUntil = typing ? new Date(Date.now() + 6000).toISOString() : null;
  await patchPlayerStateByRole(role, {
    roomKey,
    officeId,
    status: typing ? "typing" : "working",
    typingUntil,
    metadata: { typing },
  });
};

export const syncRoleTokenUsage = async (
  role: string,
  tokensTotal: number,
  roomKey = DEFAULT_ROOM_KEY,
  officeId?: string | null
): Promise<void> => {
  if (!Number.isFinite(tokensTotal)) return;
  await patchPlayerStateByRole(role, {
    roomKey,
    officeId,
    status: "working",
    tokensTotal,
    metadata: { tokenUsageSyncedAt: new Date().toISOString() },
  });
};
