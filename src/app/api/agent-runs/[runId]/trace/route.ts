import { NextRequest, NextResponse } from "next/server";
import { getAgentRun } from "@/lib/agents/runService";
import { listApprovalRequests, listToolInvocations } from "@/lib/agents/toolPolicy";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import {
  buildDefaultSwarmConfig,
  extractMemoryHitsFromToolInvocations,
  normalizeToolTaskGroups,
} from "@/lib/agents/rufloCoreShared";

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const normalizeToolInvocation = (row: Record<string, unknown>): Record<string, unknown> => ({
  ...row,
  toolId: typeof row.toolId === "string" ? row.toolId : typeof row.tool_id === "string" ? row.tool_id : null,
  riskLevel:
    typeof row.riskLevel === "string" ? row.riskLevel : typeof row.risk_level === "string" ? row.risk_level : null,
  createdAt:
    typeof row.createdAt === "string" ? row.createdAt : typeof row.created_at === "string" ? row.created_at : null,
  metadata: toRecord(row.metadata),
});

export async function GET(req: NextRequest, { params }: { params: { runId: string } }) {
  const run = await getAgentRun(params.runId);
  const { searchParams } = new URL(req.url);
  const officeId = searchParams.get("officeId")?.trim() || run?.officeId || "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const [approvals, toolInvocations] = await Promise.all([
    listApprovalRequests({ officeId, status: "all", limit: 100 }),
    listToolInvocations({ officeId, runId: params.runId, limit: 150 }),
  ]);
  const normalizedToolInvocations = toolInvocations.map((row) => normalizeToolInvocation(row));
  const swarm = buildDefaultSwarmConfig(toRecord(run?.metadata?.swarm));
  const memoryHits = extractMemoryHitsFromToolInvocations(normalizedToolInvocations);
  const taskGroups = normalizeToolTaskGroups(normalizedToolInvocations);

  if (!isServerSupabaseConfigured || !run) {
    return NextResponse.json({
      run,
      steps: [],
      validations: [],
      approvals,
      toolInvocations: normalizedToolInvocations,
      artifacts: [],
      swarm,
      memoryHits,
      taskGroups,
    });
  }

  const [stepsResult, validationsResult, artifactsResult] = await Promise.all([
    supabase
      .from("agent_run_steps")
      .select("*")
      .eq("run_id", run.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("validation_results")
      .select("*")
      .eq("run_id", run.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("task_artifacts")
      .select("id, task_id, title, artifact_type, mime_type, status, created_at")
      .eq("task_id", run.taskId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const steps = stepsResult.data ?? [];
  const validations = validationsResult.data ?? [];
  const artifacts = artifactsResult.data ?? [];
  const runApprovals = approvals.filter((approval) => approval.runId === run.id || approval.taskId === run.taskId);

  // Build unified chronological timeline for E2E trace visualization
  const timeline = [
    ...steps.map((s: Record<string, unknown>) => ({
      ...s,
      _type: "step" as const,
      phase: (s.phase as string | null) ?? "execution",
      durationMs: s.started_at && s.finished_at
        ? new Date(s.finished_at as string).getTime() - new Date(s.started_at as string).getTime()
        : null,
    })),
    ...normalizedToolInvocations.map((t) => ({
      ...t,
      _type: "tool_invocation" as const,
      phase: "tool_call" as const,
      durationMs: toRecord(t.metadata).durationMs ?? null,
    })),
    ...runApprovals.map((a) => ({
      ...a,
      _type: "approval" as const,
      phase: "approval" as const,
      durationMs: a.decisionAt && a.createdAt
        ? new Date(a.decisionAt).getTime() - new Date(a.createdAt).getTime()
        : null,
    })),
  ].sort((a, b) => {
    const getTs = (item: { created_at?: unknown; createdAt?: unknown }) => {
      const raw = (item as Record<string, unknown>).created_at ?? (item as Record<string, unknown>).createdAt;
      return raw ? new Date(raw as string).getTime() : 0;
    };
    return getTs(a) - getTs(b);
  });

  return NextResponse.json({
    run,
    steps,
    validations,
    approvals: runApprovals,
    toolInvocations: normalizedToolInvocations,
    artifacts,
    timeline,
    swarm,
    memoryHits,
    taskGroups,
  });
}
