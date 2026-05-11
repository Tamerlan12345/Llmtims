import { NextRequest, NextResponse } from "next/server";
import { getAgentRun } from "@/lib/agents/runService";
import { listApprovalRequests, listToolInvocations } from "@/lib/agents/toolPolicy";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

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

  if (!isServerSupabaseConfigured || !run) {
    return NextResponse.json({
      run,
      steps: [],
      validations: [],
      approvals,
      toolInvocations,
      artifacts: [],
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

  return NextResponse.json({
    run,
    steps: stepsResult.data ?? [],
    validations: validationsResult.data ?? [],
    approvals: approvals.filter((approval) => approval.runId === run.id || approval.taskId === run.taskId),
    toolInvocations,
    artifacts: artifactsResult.data ?? [],
  });
}
