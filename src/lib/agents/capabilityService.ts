import "server-only";

import { buildOfficeRoomKey } from "@/lib/offices/utils";
import { provisionMcpServer, type McpConfigType } from "@/lib/mcp/client";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { publishTeamEvent } from "./realtime";
import { loadRoleSkillContextFromDb } from "./skillProfiles";

export type CapabilityRequestStatus =
  | "proposed"
  | "waiting_approval"
  | "approved"
  | "provisioning"
  | "active"
  | "rejected"
  | "failed";

interface CapabilityRequestRow {
  id: string;
  office_id: string;
  task_id?: string | null;
  run_id?: string | null;
  requested_by_role?: string | null;
  target_role?: string | null;
  kind: string;
  query: string;
  reason?: string | null;
  status: CapabilityRequestStatus | string;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface CapabilityRequest {
  id: string;
  officeId: string;
  taskId: string | null;
  runId: string | null;
  requestedByRole: string | null;
  targetRole: string | null;
  kind: string;
  query: string;
  reason: string | null;
  status: CapabilityRequestStatus;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CreateCapabilityRequestInput {
  officeId: string;
  taskId?: string | null;
  runId?: string | null;
  requestedByRole?: string | null;
  targetRole?: string | null;
  kind: "mcp" | "api" | "secret" | "tool" | "search";
  query: string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  roomKey?: string | null;
}

const selectCapabilityColumns =
  "id, office_id, task_id, run_id, requested_by_role, target_role, kind, query, reason, status, metadata, created_at, updated_at";

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const normalizeString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const normalizeStatus = (value: unknown): CapabilityRequestStatus => {
  const normalized = normalizeString(value)?.toLowerCase();
  if (
    normalized === "proposed" ||
    normalized === "waiting_approval" ||
    normalized === "approved" ||
    normalized === "provisioning" ||
    normalized === "active" ||
    normalized === "rejected" ||
    normalized === "failed"
  ) {
    return normalized;
  }
  return "waiting_approval";
};

const normalizeMcpName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const normalizeCapability = (row: CapabilityRequestRow | null | undefined): CapabilityRequest | null => {
  if (!row?.id || !row.office_id || !row.kind || !row.query) return null;
  return {
    id: row.id,
    officeId: row.office_id,
    taskId: normalizeString(row.task_id),
    runId: normalizeString(row.run_id),
    requestedByRole: normalizeString(row.requested_by_role),
    targetRole: normalizeString(row.target_role),
    kind: row.kind,
    query: row.query,
    reason: normalizeString(row.reason),
    status: normalizeStatus(row.status),
    metadata: toRecord(row.metadata),
    createdAt: normalizeString(row.created_at),
    updatedAt: normalizeString(row.updated_at),
  };
};

export const createCapabilityRequest = async (
  input: CreateCapabilityRequestInput
): Promise<CapabilityRequest> => {
  if (!isServerSupabaseConfigured) {
    throw new Error("Supabase is not configured.");
  }

  const officeId = normalizeString(input.officeId);
  const query = normalizeString(input.query);
  if (!officeId || !query) {
    throw new Error("officeId and query are required.");
  }

  const { data, error } = await supabase
    .from("capability_requests")
    .insert({
      office_id: officeId,
      task_id: normalizeString(input.taskId),
      run_id: normalizeString(input.runId),
      requested_by_role: normalizeString(input.requestedByRole),
      target_role: normalizeString(input.targetRole),
      kind: input.kind,
      query,
      reason: normalizeString(input.reason),
      status: "waiting_approval",
      approval_required: true,
      metadata: input.metadata ?? {},
      updated_at: new Date().toISOString(),
    })
    .select(selectCapabilityColumns)
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "capability_request_insert_failed");
  }

  const request = normalizeCapability(data as CapabilityRequestRow);
  if (!request) {
    throw new Error("capability_request_normalization_failed");
  }

  await publishTeamEvent({
    roomKey: input.roomKey ?? buildOfficeRoomKey(officeId),
    eventName: "capability.requested",
    scope: "broadcast",
    senderRole: request.requestedByRole ?? "Agent",
    senderName: request.requestedByRole ?? "Agent",
    targetRole: request.targetRole ?? "PM",
    requiresAck: true,
    payload: {
      requestId: request.id,
      taskId: request.taskId,
      runId: request.runId,
      kind: request.kind,
      query: request.query,
      reason: request.reason,
      status: request.status,
      officeId,
    },
  });

  return request;
};

export const getCapabilityRequest = async (requestId: string): Promise<CapabilityRequest | null> => {
  if (!isServerSupabaseConfigured) return null;
  const { data, error } = await supabase
    .from("capability_requests")
    .select(selectCapabilityColumns)
    .eq("id", requestId)
    .maybeSingle();

  if (error) {
    console.error("[capabilities] failed to load request:", error.message);
    return null;
  }

  return normalizeCapability(data as CapabilityRequestRow | null);
};

const assignSkillToRoles = async (
  officeId: string,
  skillName: string,
  roles: Array<string | null | undefined>
): Promise<void> => {
  const requestedRoles = Array.from(new Set(roles.map((role) => normalizeString(role)).filter(Boolean))) as string[];
  if (requestedRoles.length === 0) return;

  const { data: skillRow } = await supabase
    .from("skills_catalog")
    .select("id")
    .eq("name", skillName)
    .maybeSingle();
  const skillId = normalizeString(skillRow?.id);
  if (!skillId) return;

  const { data: agents } = await supabase
    .from("agents")
    .select("id, role")
    .eq("office_id", officeId)
    .in("role", requestedRoles);
  const agentIds = (agents ?? [])
    .map((agent) => normalizeString((agent as Record<string, unknown>).id))
    .filter((agentId): agentId is string => Boolean(agentId));
  if (agentIds.length === 0) return;

  const rows = agentIds.map((agentId) => ({
    agent_id: agentId,
    skill_id: skillId,
    office_id: officeId,
    is_enabled: true,
    config: {
      source: "capability_request",
      assignedAt: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from("agent_skills").upsert(rows, {
    onConflict: "agent_id,skill_id",
  });
  if (error) {
    console.error("[capabilities] failed to assign MCP skill:", error.message);
  }
};

export const approveCapabilityRequest = async (
  requestId: string,
  approvedBy?: string | null
): Promise<CapabilityRequest | null> => {
  const request = await getCapabilityRequest(requestId);
  if (!request) return null;

  const metadata = request.metadata;
  const provision = toRecord(metadata.provision);
  const now = new Date().toISOString();
  let nextStatus: CapabilityRequestStatus = "approved";
  let nextMetadata: Record<string, unknown> = {
    ...metadata,
    approvedAt: now,
  };

  await supabase
    .from("capability_requests")
    .update({
      status: "provisioning",
      approved_by: normalizeString(approvedBy),
      approved_at: now,
      updated_at: now,
    })
    .eq("id", request.id);

  if (request.kind === "mcp" && normalizeString(provision.name)) {
    const type = provision.type === "sse" ? "sse" : "stdio";
    const result = await provisionMcpServer({
      officeId: request.officeId,
      name: String(provision.name),
      type: type as McpConfigType,
      command: normalizeString(provision.command),
      url: normalizeString(provision.url),
      envVars: toRecord(provision.envVars) as Record<string, string>,
    });
    nextStatus = result.success ? "active" : "failed";
    nextMetadata = {
      ...nextMetadata,
      provisionResult: result,
    };

    if (result.success && result.tools.length > 0) {
      const context = await loadRoleSkillContextFromDb(request.officeId);
      const skillName = `mcp_${normalizeMcpName(String(provision.name))}`;
      await assignSkillToRoles(request.officeId, skillName, [
        request.targetRole,
        request.requestedByRole,
        context.coordinatorRole,
      ]);

      // Resume the workflow that requested this capability (fire-and-forget)
      if (request.taskId) {
        const { runAgentWorkflow } = await import("./workflowRunner");
        runAgentWorkflow({
          taskId: request.taskId,
          officeId: request.officeId,
          approved: true,
        }).catch((err: unknown) =>
          console.error("[capabilities] failed to resume workflow after MCP provision:", err instanceof Error ? err.message : err)
        );
      }
    }
  }

  const { data, error } = await supabase
    .from("capability_requests")
    .update({
      status: nextStatus,
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq("id", request.id)
    .select(selectCapabilityColumns)
    .maybeSingle();

  if (error) {
    console.error("[capabilities] failed to approve request:", error.message);
    return null;
  }

  const updated = normalizeCapability(data as CapabilityRequestRow | null);
  await publishTeamEvent({
    roomKey: buildOfficeRoomKey(request.officeId),
    eventName: nextStatus === "active" ? "capability.active" : "capability.approved",
    scope: "broadcast",
    senderRole: "Coordinator",
    senderName: "Coordinator",
    targetRole: request.targetRole ?? request.requestedByRole ?? "All",
    payload: {
      requestId: request.id,
      kind: request.kind,
      query: request.query,
      status: nextStatus,
      officeId: request.officeId,
    },
  });

  return updated;
};

export const rejectCapabilityRequest = async (
  requestId: string,
  rejectedBy?: string | null
): Promise<CapabilityRequest | null> => {
  const request = await getCapabilityRequest(requestId);
  if (!request) return null;

  const { data, error } = await supabase
    .from("capability_requests")
    .update({
      status: "rejected",
      rejected_by: normalizeString(rejectedBy),
      rejected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", request.id)
    .select(selectCapabilityColumns)
    .maybeSingle();

  if (error) {
    console.error("[capabilities] failed to reject request:", error.message);
    return null;
  }

  await publishTeamEvent({
    roomKey: buildOfficeRoomKey(request.officeId),
    eventName: "capability.rejected",
    scope: "broadcast",
    senderRole: "Coordinator",
    senderName: "Coordinator",
    targetRole: request.requestedByRole ?? "All",
    payload: {
      requestId: request.id,
      kind: request.kind,
      query: request.query,
      status: "rejected",
      officeId: request.officeId,
    },
  });

  return normalizeCapability(data as CapabilityRequestRow | null);
};
