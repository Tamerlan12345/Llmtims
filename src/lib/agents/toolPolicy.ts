import "server-only";

import { randomUUID } from "node:crypto";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { logSystemEvent } from "./persistence";

export type ToolRiskLevel = "low" | "medium" | "high" | "critical";
export type ToolPolicyDecision = "allowed" | "denied" | "approval_required";
export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "edited" | "expired";

export interface ApprovalRequest {
  id: string;
  officeId: string;
  runId: string | null;
  taskId: string | null;
  toolId: string;
  riskLevel: ToolRiskLevel;
  actionSummary: string;
  arguments: Record<string, unknown>;
  resource: string | null;
  status: ApprovalRequestStatus;
  decisionBy: string | null;
  decisionAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ToolPolicy {
  id: string;
  officeId: string | null;
  toolId: string;
  riskLevel: ToolRiskLevel;
  approvalRequired: boolean;
  allowedRoles: string[];
  allowedOffices: string[];
  envAllowlist: string[];
  networkAllowlist: string[];
  metadata: Record<string, unknown>;
}

interface ToolAuthorizationInput {
  officeId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  role?: string | null;
  toolId: string;
  actionType?: string | null;
  arguments?: Record<string, unknown> | null;
  resource?: string | null;
  actionSummary?: string | null;
  metadata?: Record<string, unknown> | null;
  // Approve Mode: when enabled, all tools at or above minRisk require approval
  approveModeEnabled?: boolean;
  approveModeMinRisk?: ToolRiskLevel;
}

interface ToolAuthorizationResult {
  decision: ToolPolicyDecision;
  riskLevel: ToolRiskLevel;
  policyId: string | null;
  reason: string;
  approvalRequest: ApprovalRequest | null;
}

interface ApprovalRequestInput {
  officeId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  toolId: string;
  riskLevel: ToolRiskLevel;
  actionSummary: string;
  arguments?: Record<string, unknown> | null;
  resource?: string | null;
  metadata?: Record<string, unknown> | null;
}

const memoryApprovalRequests = new Map<string, ApprovalRequest>();
const memoryToolInvocations: Array<Record<string, unknown>> = [];

// Hot-path TTL cache for approval requests when Supabase IS configured.
// Avoids a DB round-trip for the common case of checking a just-created request.
const APPROVAL_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
interface ApprovalCacheEntry { request: ApprovalRequest; expiresAt: number }
const approvalRequestCache = new Map<string, ApprovalCacheEntry>();

const cacheApprovalRequest = (request: ApprovalRequest) => {
  approvalRequestCache.set(request.id, { request, expiresAt: Date.now() + APPROVAL_CACHE_TTL_MS });
};

const getCachedApprovalRequest = (id: string): ApprovalRequest | null => {
  const entry = approvalRequestCache.get(id);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    approvalRequestCache.delete(id);
    return null;
  }
  return entry.request;
};

const normalizeString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const normalizeRisk = (value: unknown): ToolRiskLevel => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low"
    ? normalized
    : "high";
};

const normalizeApprovalStatus = (value: unknown): ApprovalRequestStatus => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "approved" ||
    normalized === "rejected" ||
    normalized === "edited" ||
    normalized === "expired"
    ? normalized
    : "pending";
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
    : [];

export const redactSensitiveValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|api[_-]?key|authorization|cookie/i.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = redactSensitiveValue(raw);
  }
  return output;
};

const inferActionType = (toolId: string, args: Record<string, unknown>): string => {
  const haystack = `${toolId} ${Object.keys(args).join(" ")} ${Object.values(args)
    .filter((value) => typeof value === "string")
    .join(" ")}`.toLowerCase();
  if (/\b(delete|remove|destroy|drop|rm)\b/.test(haystack)) return "delete";
  if (/\b(deploy|publish|send|post|release)\b/.test(haystack)) return "publish";
  if (/\b(env|secret|config|permission)\b/.test(haystack)) return "config";
  if (/\b(write|create|update|edit|patch|commit|upload)\b/.test(haystack)) return "write";
  if (/\b(read|list|get|search|fetch|query)\b/.test(haystack)) return "read";
  return "execute";
};

const defaultPolicyForTool = (
  toolId: string,
  actionType: string
): Pick<ToolPolicy, "id" | "riskLevel" | "approvalRequired" | "envAllowlist" | "networkAllowlist"> | null => {
  const normalizedTool = toolId.trim().toLowerCase();
  const normalizedAction = actionType.trim().toLowerCase();

  if (
    normalizedTool === "delegate_task" ||
    normalizedTool === "request_capability" ||
    normalizedTool === "plan_gsd_project" ||
    normalizedTool === "memory_search" ||
    normalizedTool === "memory_store" ||
    normalizedTool === "memory_retrieve" ||
    normalizedTool === "swarm_status" ||
    normalizedTool === "agent_status"
  ) {
    return {
      id: `default:${normalizedTool}`,
      riskLevel: "low",
      approvalRequired: false,
      envAllowlist: [],
      networkAllowlist: [],
    };
  }

  if (normalizedTool === "create_site_preview") {
    return {
      id: "default:create_site_preview",
      riskLevel: "medium",
      approvalRequired: false,
      envAllowlist: [],
      networkAllowlist: [],
    };
  }

  if (normalizedTool.includes("sandbox_execution")) {
    return {
      id: "default:sandbox_execution",
      riskLevel: "medium",
      approvalRequired: false,
      envAllowlist: [],
      networkAllowlist: [],
    };
  }

  if (normalizedTool.startsWith("filesystem__") || normalizedTool.startsWith("mcp_filesystem__")) {
    const readOnly = /(^|__)(read|list|get|stat|search)/.test(normalizedTool) || normalizedAction === "read";
    return {
      id: "default:mcp_filesystem",
      riskLevel: readOnly ? "low" : "high",
      approvalRequired: !readOnly,
      envAllowlist: [],
      networkAllowlist: [],
    };
  }

  if (normalizedTool.includes("instagram") || normalizedTool.includes("publish")) {
    return {
      id: `default:${normalizedTool}`,
      riskLevel: "high",
      approvalRequired: true,
      envAllowlist: [],
      networkAllowlist: ["graph.facebook.com"],
    };
  }

  if (
    normalizedTool.includes("railway") ||
    normalizedTool.includes("vercel") ||
    normalizedTool.includes("deploy") ||
    normalizedAction === "publish" ||
    normalizedAction === "config" ||
    normalizedAction === "delete"
  ) {
    return {
      id: `default:${normalizedTool}`,
      riskLevel: normalizedAction === "delete" ? "critical" : "high",
      approvalRequired: true,
      envAllowlist: [],
      networkAllowlist: [],
    };
  }

  // Unknown tools are denied by default; callers surface this as tool_denied.
  return null;
};

const normalizeApprovalRequest = (row: Record<string, unknown> | null | undefined): ApprovalRequest | null => {
  const id = normalizeString(row?.id);
  const officeId = normalizeString(row?.office_id);
  const toolId = normalizeString(row?.tool_id);
  if (!id || !officeId || !toolId) return null;

  return {
    id,
    officeId,
    runId: normalizeString(row?.run_id),
    taskId: normalizeString(row?.task_id),
    toolId,
    riskLevel: normalizeRisk(row?.risk_level),
    actionSummary: normalizeString(row?.action_summary) ?? toolId,
    arguments: toRecord(row?.arguments),
    resource: normalizeString(row?.resource),
    status: normalizeApprovalStatus(row?.status),
    decisionBy: normalizeString(row?.decision_by),
    decisionAt: normalizeString(row?.decision_at),
    metadata: toRecord(row?.metadata),
    createdAt: normalizeString(row?.created_at),
    updatedAt: normalizeString(row?.updated_at),
  };
};

const selectApprovalColumns =
  "id, office_id, run_id, task_id, tool_id, risk_level, action_summary, arguments, resource, status, decision_by, decision_at, metadata, created_at, updated_at";

export const createApprovalRequest = async (input: ApprovalRequestInput): Promise<ApprovalRequest> => {
  const officeId = normalizeString(input.officeId) ?? "diagnostic-office";
  const now = new Date().toISOString();
  const payload = {
    office_id: officeId,
    run_id: normalizeString(input.runId),
    task_id: normalizeString(input.taskId),
    tool_id: input.toolId.trim(),
    risk_level: input.riskLevel,
    action_summary: input.actionSummary.trim() || input.toolId.trim(),
    arguments: redactSensitiveValue(input.arguments ?? {}) as Record<string, unknown>,
    resource: normalizeString(input.resource),
    status: "pending" as ApprovalRequestStatus,
    metadata: redactSensitiveValue(input.metadata ?? {}) as Record<string, unknown>,
    created_at: now,
    updated_at: now,
  };

  if (!isServerSupabaseConfigured) {
    console.warn("[tool-policy] Supabase not configured; approval stored in-memory only — will be lost on restart.");
    const request = normalizeApprovalRequest({ id: randomUUID(), ...payload });
    if (!request) throw new Error("approval_request_normalization_failed");
    memoryApprovalRequests.set(request.id, request);
    return request;
  }

  const { data, error } = await supabase
    .from("approval_requests")
    .insert(payload)
    .select(selectApprovalColumns)
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "approval_request_insert_failed");
  }

  const request = normalizeApprovalRequest(data as Record<string, unknown>);
  if (!request) throw new Error("approval_request_normalization_failed");
  cacheApprovalRequest(request);

  await logSystemEvent({
    level: "warn",
    scope: "tool-policy",
    event: "approval_requested",
    taskId: request.taskId,
    metadata: {
      requestId: request.id,
      officeId,
      toolId: request.toolId,
      riskLevel: request.riskLevel,
      actionSummary: request.actionSummary,
    },
  });

  return request;
};

export const listApprovalRequests = async (input: {
  officeId?: string | null;
  status?: ApprovalRequestStatus | "all" | null;
  limit?: number | null;
}): Promise<ApprovalRequest[]> => {
  const officeId = normalizeString(input.officeId);
  const status = input.status ?? "pending";
  const limit = Math.min(Math.max(Number(input.limit ?? 50), 1), 100);

  if (!isServerSupabaseConfigured) {
    return Array.from(memoryApprovalRequests.values())
      .filter((request) => (!officeId || request.officeId === officeId) && (status === "all" || request.status === status))
      .slice(0, limit);
  }

  let query = supabase
    .from("approval_requests")
    .select(selectApprovalColumns)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (officeId) query = query.eq("office_id", officeId);
  if (status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error || !Array.isArray(data)) {
    if (error) console.error("[tool-policy] failed to list approval requests:", error.message);
    return [];
  }
  return data
    .map((row) => normalizeApprovalRequest(row as Record<string, unknown>))
    .filter((request): request is ApprovalRequest => Boolean(request));
};

export const getApprovalRequest = async (requestId: string): Promise<ApprovalRequest | null> => {
  const normalizedId = normalizeString(requestId);
  if (!normalizedId) return null;
  if (!isServerSupabaseConfigured) {
    return memoryApprovalRequests.get(normalizedId) ?? null;
  }

  // Check hot-path TTL cache first
  const cached = getCachedApprovalRequest(normalizedId);
  if (cached) return cached;

  const { data, error } = await supabase
    .from("approval_requests")
    .select(selectApprovalColumns)
    .eq("id", normalizedId)
    .maybeSingle();
  if (error) {
    console.error("[tool-policy] failed to load approval request:", error.message);
    return null;
  }
  const request = normalizeApprovalRequest(data as Record<string, unknown> | null);
  if (request) cacheApprovalRequest(request);
  return request;
};

export const decideApprovalRequest = async (
  requestId: string,
  decision: "approve" | "reject" | "edit",
  input: { decidedBy?: string | null; editedArguments?: Record<string, unknown> | null; reason?: string | null } = {}
): Promise<ApprovalRequest | null> => {
  const existing = await getApprovalRequest(requestId);
  if (!existing) return null;
  if (existing.status !== "pending") return existing;

  const now = new Date().toISOString();
  const nextStatus: ApprovalRequestStatus =
    decision === "approve" ? "approved" : decision === "edit" ? "edited" : "rejected";
  const nextArguments =
    decision === "edit" && input.editedArguments ? redactSensitiveValue(input.editedArguments) : existing.arguments;
  const metadata = {
    ...existing.metadata,
    decisionReason: normalizeString(input.reason),
  };

  if (!isServerSupabaseConfigured) {
    const updated: ApprovalRequest = {
      ...existing,
      arguments: nextArguments as Record<string, unknown>,
      status: nextStatus,
      decisionBy: normalizeString(input.decidedBy),
      decisionAt: now,
      metadata,
      updatedAt: now,
    };
    memoryApprovalRequests.set(updated.id, updated);
    return updated;
  }

  const { data, error } = await supabase
    .from("approval_requests")
    .update({
      status: nextStatus,
      arguments: nextArguments,
      decision_by: normalizeString(input.decidedBy),
      decision_at: now,
      metadata,
      updated_at: now,
    })
    .eq("id", existing.id)
    .eq("status", "pending")
    .select(selectApprovalColumns)
    .maybeSingle();
  if (error) {
    console.error("[tool-policy] failed to decide approval request:", error.message);
    return null;
  }
  const decided = normalizeApprovalRequest(data as Record<string, unknown> | null);
  if (decided) cacheApprovalRequest(decided);
  return decided;
};

export const authorizeToolInvocation = async (
  input: ToolAuthorizationInput
): Promise<ToolAuthorizationResult> => {
  const args = input.arguments ?? {};
  const actionType = normalizeString(input.actionType) ?? inferActionType(input.toolId, args);
  const policy = defaultPolicyForTool(input.toolId, actionType);
  const officeId = normalizeString(input.officeId);

  if (!policy) {
    await recordToolInvocation({
      ...input,
      actionType,
      riskLevel: "critical",
      decision: "denied",
      status: "failed",
      error: "policy_missing",
    });
    return {
      decision: "denied",
      riskLevel: "critical",
      policyId: null,
      reason: "policy_missing",
      approvalRequest: null,
    };
  }

  // Approve Mode: check if office-level setting gates this risk level
  const RISK_ORDER: Record<ToolRiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  const approveModeGated =
    input.approveModeEnabled === true &&
    input.approveModeMinRisk &&
    RISK_ORDER[policy.riskLevel] >= RISK_ORDER[input.approveModeMinRisk];

  if (policy.approvalRequired || approveModeGated) {
    const reason = approveModeGated && !policy.approvalRequired ? "approve_mode_gated" : "approval_required";
    const request = await createApprovalRequest({
      officeId,
      runId: input.runId,
      taskId: input.taskId,
      toolId: input.toolId,
      riskLevel: policy.riskLevel,
      actionSummary:
        normalizeString(input.actionSummary) ??
        `${actionType} via ${input.toolId}`,
      arguments: args,
      resource: input.resource,
      metadata: {
        ...(input.metadata ?? {}),
        actionType,
        policyId: policy.id,
        role: input.role ?? null,
        approveMode: approveModeGated,
      },
    });
    await recordToolInvocation({
      ...input,
      actionType,
      riskLevel: policy.riskLevel,
      decision: "approval_required",
      status: "pending",
      approvalRequestId: request.id,
    });
    return {
      decision: "approval_required",
      riskLevel: policy.riskLevel,
      policyId: policy.id,
      reason,
      approvalRequest: request,
    };
  }

  await recordToolInvocation({
    ...input,
    actionType,
    riskLevel: policy.riskLevel,
    decision: "allowed",
    status: "started",
  });
  return {
    decision: "allowed",
    riskLevel: policy.riskLevel,
    policyId: policy.id,
    reason: "allowed",
    approvalRequest: null,
  };
};

export const recordToolInvocation = async (input: ToolAuthorizationInput & {
  actionType?: string | null;
  riskLevel: ToolRiskLevel;
  decision: ToolPolicyDecision;
  status: "started" | "completed" | "failed" | "pending";
  output?: Record<string, unknown> | null;
  error?: string | null;
  approvalRequestId?: string | null;
}): Promise<void> => {
  const payload = {
    office_id: normalizeString(input.officeId),
    run_id: normalizeString(input.runId),
    task_id: normalizeString(input.taskId),
    tool_id: input.toolId,
    action_type: normalizeString(input.actionType) ?? inferActionType(input.toolId, input.arguments ?? {}),
    risk_level: input.riskLevel,
    decision: input.decision,
    status: input.status,
    approval_request_id: normalizeString(input.approvalRequestId),
    input: redactSensitiveValue(input.arguments ?? {}) as Record<string, unknown>,
    output: redactSensitiveValue(input.output ?? {}) as Record<string, unknown>,
    error: normalizeString(input.error),
    metadata: redactSensitiveValue(input.metadata ?? {}) as Record<string, unknown>,
    created_at: new Date().toISOString(),
  };

  if (!isServerSupabaseConfigured) {
    memoryToolInvocations.push(payload);
    return;
  }

  const { error } = await supabase.from("tool_invocations").insert(payload);
  if (error) {
    console.error("[tool-policy] failed to record tool invocation:", error.message);
  }
};

export const listToolPolicies = async (officeId?: string | null): Promise<ToolPolicy[]> => {
  const defaults: ToolPolicy[] = [
    "delegate_task",
    "request_capability",
    "plan_gsd_project",
    "create_site_preview",
    "sandbox_execution",
    "memory_search",
    "memory_store",
    "memory_retrieve",
    "swarm_status",
    "agent_status",
  ].map((toolId) => {
    const policy = defaultPolicyForTool(toolId, "execute")!;
    return {
      id: policy.id,
      officeId: null,
      toolId,
      riskLevel: policy.riskLevel,
      approvalRequired: policy.approvalRequired,
      allowedRoles: [],
      allowedOffices: [],
      envAllowlist: policy.envAllowlist,
      networkAllowlist: policy.networkAllowlist,
      metadata: { source: "default" },
    };
  });

  if (!isServerSupabaseConfigured) return defaults;

  let query = supabase
    .from("tool_policies")
    .select("id, office_id, tool_id, risk_level, approval_required, allowed_roles, allowed_offices, env_allowlist, network_allowlist, metadata");
  const normalizedOfficeId = normalizeString(officeId);
  if (normalizedOfficeId) {
    query = query.or(`office_id.is.null,office_id.eq.${normalizedOfficeId}`);
  }
  const { data, error } = await query;
  if (error || !Array.isArray(data)) {
    if (error) console.error("[tool-policy] failed to list policies:", error.message);
    return defaults;
  }

  const custom = data.map((row: Record<string, unknown>) => ({
    id: normalizeString(row.id) ?? randomUUID(),
    officeId: normalizeString(row.office_id),
    toolId: normalizeString(row.tool_id) ?? "unknown",
    riskLevel: normalizeRisk(row.risk_level),
    approvalRequired: row.approval_required !== false,
    allowedRoles: toStringArray(row.allowed_roles),
    allowedOffices: toStringArray(row.allowed_offices),
    envAllowlist: toStringArray(row.env_allowlist),
    networkAllowlist: toStringArray(row.network_allowlist),
    metadata: toRecord(row.metadata),
  }));

  return [...defaults, ...custom];
};

export const listToolInvocations = async (input: {
  officeId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  limit?: number | null;
}): Promise<Array<Record<string, unknown>>> => {
  const limit = Math.min(Math.max(Number(input.limit ?? 100), 1), 250);
  if (!isServerSupabaseConfigured) {
    return memoryToolInvocations.slice(-limit);
  }

  let query = supabase
    .from("tool_invocations")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(limit);
  const officeId = normalizeString(input.officeId);
  const runId = normalizeString(input.runId);
  const taskId = normalizeString(input.taskId);
  if (officeId) query = query.eq("office_id", officeId);
  if (runId) query = query.eq("run_id", runId);
  if (taskId) query = query.eq("task_id", taskId);

  const { data, error } = await query;
  if (error || !Array.isArray(data)) {
    if (error) console.error("[tool-policy] failed to list tool invocations:", error.message);
    return [];
  }
  return data as Array<Record<string, unknown>>;
};
