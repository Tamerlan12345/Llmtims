import "server-only";

import { randomUUID } from "node:crypto";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import type { AgentRun } from "./runService";
import {
  DEFAULT_MEMORY_MIN_CONFIDENCE,
  DEFAULT_MEMORY_NAMESPACE,
  MAX_MEMORY_SEARCH_LIMIT,
  TOOL_DETAIL_MAX_LENGTH,
  buildDefaultSwarmConfig,
  buildPlainTextSearchQuery,
  normalizeConfidence,
  normalizeMemoryLimit,
  normalizeMemoryNamespace,
  scoreMemoryPattern,
  type AgentMemoryHit,
  type SwarmTraceSummary,
} from "./rufloCoreShared";

interface MemoryPatternRecord {
  id: string;
  office_id: string | null;
  namespace: string;
  key: string;
  value: string;
  summary: string | null;
  tags: string[] | null;
  confidence: number | null;
  source_run_id: string | null;
  source_task_id: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface StoreAgentMemoryPatternInput {
  officeId?: string | null;
  namespace?: string | null;
  key: string;
  value: string;
  summary?: string | null;
  tags?: string[] | null;
  confidence?: number | null;
  sourceRunId?: string | null;
  sourceTaskId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PersistToolDetailInput {
  officeId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  toolName: string;
  toolCallId?: string | null;
  detail: string;
  preview?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface AgentRunToolDetail {
  detailToken: string;
  runId: string;
  taskId: string | null;
  toolName: string;
  toolCallId: string | null;
  preview: string | null;
  fullDetail: string;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

const memoryPatterns = new Map<string, MemoryPatternRecord>();
const memoryToolDetails = new Map<string, AgentRunToolDetail>();

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const normalizeString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const normalizeTags = (value: unknown): string[] =>
  Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
            .filter(Boolean)
        )
      ).slice(0, 16)
    : [];

const normalizeDetailText = (value: string): string => value.replace(/\s+$/g, "").slice(0, TOOL_DETAIL_MAX_LENGTH);

const buildMemoryMapKey = (officeId: string | null, namespace: string, key: string): string =>
  `${officeId ?? "local"}:${namespace}:${key}`;

const normalizeMemoryRecord = (row: Record<string, unknown> | null | undefined): MemoryPatternRecord | null => {
  const key = normalizeString(row?.key);
  const namespace = normalizeMemoryNamespace(row?.namespace);
  const value = normalizeString(row?.value);
  if (!key || !value) return null;

  return {
    id: normalizeString(row?.id) ?? randomUUID(),
    office_id: normalizeString(row?.office_id),
    namespace,
    key,
    value,
    summary: normalizeString(row?.summary),
    tags: normalizeTags(row?.tags),
    confidence: normalizeConfidence(row?.confidence, DEFAULT_MEMORY_MIN_CONFIDENCE),
    source_run_id: normalizeString(row?.source_run_id),
    source_task_id: normalizeString(row?.source_task_id),
    metadata: toRecord(row?.metadata),
    created_at: normalizeString(row?.created_at),
    updated_at: normalizeString(row?.updated_at),
  };
};

const toMemoryHit = (row: MemoryPatternRecord, query: string): AgentMemoryHit => ({
  id: row.id,
  key: row.key,
  namespace: row.namespace,
  summary: row.summary ?? row.key,
  valuePreview: row.value.replace(/\s+/g, " ").trim().slice(0, 260),
  confidence: normalizeConfidence(row.confidence, DEFAULT_MEMORY_MIN_CONFIDENCE),
  score: scoreMemoryPattern({
    query,
    summary: row.summary,
    value: row.value,
    tags: row.tags,
    confidence: row.confidence,
  }),
  tags: row.tags ?? [],
  sourceRunId: row.source_run_id,
  sourceTaskId: row.source_task_id,
  createdAt: row.created_at,
});

const searchMemoryRows = (
  rows: MemoryPatternRecord[],
  query: string,
  limit: number,
  minConfidence: number
): AgentMemoryHit[] =>
  rows
    .map((row) => toMemoryHit(row, query))
    .filter((hit) => hit.confidence >= minConfidence && hit.score > 0)
    .sort((left, right) => right.score - left.score || right.confidence - left.confidence)
    .slice(0, limit);

export const storeAgentMemoryPattern = async (
  input: StoreAgentMemoryPatternInput
): Promise<AgentMemoryHit | null> => {
  const officeId = normalizeString(input.officeId);
  const key = normalizeString(input.key);
  const value = normalizeString(input.value);
  if (!key || !value) return null;

  const namespace = normalizeMemoryNamespace(input.namespace);
  const confidence = normalizeConfidence(input.confidence, 0.8);
  const payload = {
    id: randomUUID(),
    office_id: officeId,
    namespace,
    key,
    value,
    summary: normalizeString(input.summary) ?? key,
    tags: normalizeTags(input.tags),
    confidence,
    source_run_id: normalizeString(input.sourceRunId),
    source_task_id: normalizeString(input.sourceTaskId),
    metadata: toRecord(input.metadata),
    updated_at: new Date().toISOString(),
  };

  if (!isServerSupabaseConfigured || !officeId) {
    const record = normalizeMemoryRecord({
      ...payload,
      created_at: payload.updated_at,
    });
    if (!record) return null;
    memoryPatterns.set(buildMemoryMapKey(officeId, namespace, key), record);
    return toMemoryHit(record, `${key} ${payload.summary ?? ""}`);
  }

  const { data, error } = await supabase
    .from("agent_memory_patterns")
    .upsert(payload, { onConflict: "office_id,namespace,key" })
    .select("id, office_id, namespace, key, value, summary, tags, confidence, source_run_id, source_task_id, metadata, created_at, updated_at")
    .maybeSingle();

  if (error) {
    console.warn("[ruflo-core] failed to store memory pattern:", error.message);
    return null;
  }

  const record = normalizeMemoryRecord(data as Record<string, unknown> | null);
  return record ? toMemoryHit(record, `${key} ${payload.summary ?? ""}`) : null;
};

export const searchAgentMemoryPatterns = async (input: {
  officeId?: string | null;
  namespace?: string | null;
  query: string;
  limit?: number | null;
  minConfidence?: number | null;
}): Promise<AgentMemoryHit[]> => {
  const officeId = normalizeString(input.officeId);
  const namespace = normalizeMemoryNamespace(input.namespace);
  const query = normalizeString(input.query);
  if (!query) return [];

  const limit = normalizeMemoryLimit(input.limit);
  const minConfidence = normalizeConfidence(input.minConfidence, DEFAULT_MEMORY_MIN_CONFIDENCE);

  if (!isServerSupabaseConfigured || !officeId) {
    const rows = Array.from(memoryPatterns.values()).filter(
      (row) => row.namespace === namespace && (!officeId || row.office_id === officeId)
    );
    return searchMemoryRows(rows, query, limit, minConfidence);
  }

  const columns =
    "id, office_id, namespace, key, value, summary, tags, confidence, source_run_id, source_task_id, metadata, created_at, updated_at";
  const textQuery = buildPlainTextSearchQuery(query);
  let rows: MemoryPatternRecord[] = [];

  if (textQuery) {
    const { data, error } = await supabase
      .from("agent_memory_patterns")
      .select(columns)
      .eq("office_id", officeId)
      .eq("namespace", namespace)
      .gte("confidence", minConfidence)
      .textSearch("search_text", textQuery, { type: "plain" })
      .order("updated_at", { ascending: false })
      .limit(Math.max(limit * 3, MAX_MEMORY_SEARCH_LIMIT));

    if (!error && Array.isArray(data)) {
      rows = data
        .map((row) => normalizeMemoryRecord(row as Record<string, unknown>))
        .filter((row): row is MemoryPatternRecord => Boolean(row));
    }
  }

  if (rows.length === 0) {
    const { data, error } = await supabase
      .from("agent_memory_patterns")
      .select(columns)
      .eq("office_id", officeId)
      .eq("namespace", namespace)
      .gte("confidence", minConfidence)
      .order("updated_at", { ascending: false })
      .limit(50);

    if (!error && Array.isArray(data)) {
      rows = data
        .map((row) => normalizeMemoryRecord(row as Record<string, unknown>))
        .filter((row): row is MemoryPatternRecord => Boolean(row));
    }
  }

  return searchMemoryRows(rows, query, limit, minConfidence);
};

export const retrieveAgentMemoryPattern = async (input: {
  officeId?: string | null;
  namespace?: string | null;
  key: string;
}): Promise<AgentMemoryHit | null> => {
  const officeId = normalizeString(input.officeId);
  const namespace = normalizeMemoryNamespace(input.namespace);
  const key = normalizeString(input.key);
  if (!key) return null;

  if (!isServerSupabaseConfigured || !officeId) {
    const record = memoryPatterns.get(buildMemoryMapKey(officeId, namespace, key));
    return record ? toMemoryHit(record, key) : null;
  }

  const { data, error } = await supabase
    .from("agent_memory_patterns")
    .select("id, office_id, namespace, key, value, summary, tags, confidence, source_run_id, source_task_id, metadata, created_at, updated_at")
    .eq("office_id", officeId)
    .eq("namespace", namespace)
    .eq("key", key)
    .maybeSingle();

  if (error) {
    console.warn("[ruflo-core] failed to retrieve memory pattern:", error.message);
    return null;
  }

  const record = normalizeMemoryRecord(data as Record<string, unknown> | null);
  return record ? toMemoryHit(record, key) : null;
};

export const persistAgentRunToolDetail = async (
  input: PersistToolDetailInput
): Promise<string | null> => {
  const officeId = normalizeString(input.officeId);
  const runId = normalizeString(input.runId);
  const toolName = normalizeString(input.toolName);
  if (!runId || !toolName) return null;

  const detailToken = randomUUID();
  const fullDetail = normalizeDetailText(input.detail);
  const preview = (normalizeString(input.preview) ?? fullDetail.replace(/\s+/g, " ").trim()).slice(0, 1200);
  const now = new Date().toISOString();
  const detail: AgentRunToolDetail = {
    detailToken,
    runId,
    taskId: normalizeString(input.taskId),
    toolName,
    toolCallId: normalizeString(input.toolCallId),
    preview,
    fullDetail,
    metadata: toRecord(input.metadata),
    createdAt: now,
  };

  if (!isServerSupabaseConfigured || !officeId) {
    memoryToolDetails.set(`${runId}:${detailToken}`, detail);
    return detailToken;
  }

  const { error } = await supabase.from("agent_run_tool_details").insert({
    office_id: officeId,
    run_id: runId,
    task_id: detail.taskId,
    tool_name: toolName,
    tool_call_id: detail.toolCallId,
    detail_token: detailToken,
    preview,
    full_detail: fullDetail,
    metadata: detail.metadata,
  });

  if (error) {
    console.warn("[ruflo-core] failed to persist tool detail:", error.message);
    return null;
  }

  return detailToken;
};

export const getAgentRunToolDetail = async (
  runId: string,
  detailToken: string,
  officeId?: string | null
): Promise<AgentRunToolDetail | null> => {
  const normalizedRunId = normalizeString(runId);
  const normalizedToken = normalizeString(detailToken);
  const normalizedOfficeId = normalizeString(officeId);
  if (!normalizedRunId || !normalizedToken) return null;

  if (!isServerSupabaseConfigured) {
    const detail = memoryToolDetails.get(`${normalizedRunId}:${normalizedToken}`) ?? null;
    return normalizedOfficeId && detail && detail.runId === normalizedRunId ? detail : detail;
  }

  let query = supabase
    .from("agent_run_tool_details")
    .select("detail_token, run_id, task_id, tool_name, tool_call_id, preview, full_detail, metadata, created_at")
    .eq("run_id", normalizedRunId)
    .eq("detail_token", normalizedToken);
  if (normalizedOfficeId) {
    query = query.eq("office_id", normalizedOfficeId);
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data) {
    if (error) console.warn("[ruflo-core] failed to load tool detail:", error.message);
    return null;
  }

  const row = data as Record<string, unknown>;
  return {
    detailToken: normalizeString(row.detail_token) ?? normalizedToken,
    runId: normalizeString(row.run_id) ?? normalizedRunId,
    taskId: normalizeString(row.task_id),
    toolName: normalizeString(row.tool_name) ?? "tool",
    toolCallId: normalizeString(row.tool_call_id),
    preview: normalizeString(row.preview),
    fullDetail: normalizeString(row.full_detail) ?? "",
    metadata: toRecord(row.metadata),
    createdAt: normalizeString(row.created_at),
  };
};

export const getRunSwarmSummary = async (input: {
  officeId?: string | null;
  runId?: string | null;
}): Promise<SwarmTraceSummary> => {
  const runId = normalizeString(input.runId);
  if (!isServerSupabaseConfigured || !runId) {
    return buildDefaultSwarmConfig();
  }

  const { data } = await supabase
    .from("agent_runs")
    .select("metadata")
    .eq("id", runId)
    .maybeSingle();

  return buildDefaultSwarmConfig(toRecord((data as Record<string, unknown> | null)?.metadata).swarm as Record<string, unknown>);
};

export const recordRunSuccessPattern = async (input: {
  run: AgentRun | null;
  workflow: { body?: Record<string, unknown> | null } | null;
}): Promise<void> => {
  const run = input.run;
  if (!run || run.status !== "completed") return;

  const result = toRecord(input.workflow?.body?.result);
  const workflowRoles = Array.isArray(result.workflow_roles)
    ? result.workflow_roles.filter((role): role is string => typeof role === "string")
    : [];
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const artifactSummary = artifacts
    .map((artifact) => toRecord(artifact).summary)
    .filter((summary): summary is string => typeof summary === "string" && summary.trim().length > 0)
    .join("\n")
    .slice(0, 2000);
  const toolNames = Array.isArray(result.executedTools)
    ? result.executedTools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const intent = run.input?.replace(/\s+/g, " ").trim().slice(0, 500) || run.targetRole || "agent run";
  const summary = `Successful run for: ${intent}`;

  await storeAgentMemoryPattern({
    officeId: run.officeId,
    namespace: DEFAULT_MEMORY_NAMESPACE,
    key: `run-${run.id}`,
    summary,
    value: [
      `intent: ${intent}`,
      `status: ${run.status}`,
      workflowRoles.length > 0 ? `workflow_roles: ${workflowRoles.join(", ")}` : null,
      toolNames.length > 0 ? `tools: ${toolNames.join(", ")}` : null,
      artifactSummary ? `artifacts:\n${artifactSummary}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    tags: ["run", "success", ...workflowRoles.map((role) => role.toLowerCase())],
    confidence: 0.8,
    sourceRunId: run.id,
    sourceTaskId: run.taskId,
    metadata: {
      targetRole: run.targetRole,
      mode: run.mode,
      finishedAt: run.finishedAt,
    },
  });
};
