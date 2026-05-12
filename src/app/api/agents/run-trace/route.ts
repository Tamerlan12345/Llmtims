import { NextRequest, NextResponse } from "next/server";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";
import { runAgentWorkflow, type RunAgentWorkflowInput } from "@/lib/agents/workflowRunner";
import { listAgentRuns } from "@/lib/agents/runService";
import { listApprovalRequests, listToolInvocations } from "@/lib/agents/toolPolicy";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

/**
 * POST /api/agents/run-trace
 * Runs the agent workflow and returns the full execution result + structured E2E trace in one response.
 * Useful for debugging, testing, and understanding the complete user-story cycle.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as RunAgentWorkflowInput;
  const officeId = typeof body.officeId === "string" ? body.officeId.trim() : "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  // Execute the workflow
  const workflowResult = await runAgentWorkflow({ ...body, officeId });

  // Fetch the trace after completion
  let trace: Record<string, unknown> = { available: false };

  if (isServerSupabaseConfigured && body.taskId) {
    try {
      // Find the most recent run for this task
      const runs = await listAgentRuns({ taskId: body.taskId, officeId, limit: 1 });
      const run = runs[0] ?? null;

      if (run) {
        const [approvals, toolInvocations, stepsResult, artifactsResult] = await Promise.all([
          listApprovalRequests({ officeId, status: "all", limit: 100 }),
          listToolInvocations({ officeId, runId: run.id, limit: 150 }),
          supabase
            .from("agent_run_steps")
            .select("*")
            .eq("run_id", run.id)
            .order("created_at", { ascending: true }),
          supabase
            .from("task_artifacts")
            .select("id, task_id, title, artifact_type, mime_type, status, created_at")
            .eq("task_id", body.taskId)
            .order("created_at", { ascending: false })
            .limit(50),
        ]);

        const steps = stepsResult.data ?? [];
        const runApprovals = approvals.filter(
          (a) => a.runId === run.id || a.taskId === body.taskId
        );

        // Build chronological unified timeline
        const timeline = [
          ...steps.map((s: Record<string, unknown>) => ({
            ...s,
            _type: "step" as const,
            phase: (s.phase as string | null) ?? "execution",
            durationMs:
              s.started_at && s.finished_at
                ? new Date(s.finished_at as string).getTime() -
                  new Date(s.started_at as string).getTime()
                : null,
          })),
          ...toolInvocations.map((t) => ({
            ...t,
            _type: "tool_invocation" as const,
            phase: "tool_call" as const,
            durationMs: null,
          })),
          ...runApprovals.map((a) => ({
            ...a,
            _type: "approval" as const,
            phase: "approval" as const,
            durationMs:
              a.decisionAt && a.createdAt
                ? new Date(a.decisionAt).getTime() - new Date(a.createdAt).getTime()
                : null,
          })),
        ].sort((a, b) => {
          const getTs = (item: Record<string, unknown>) => {
            const raw = item.created_at ?? item.createdAt;
            return raw ? new Date(raw as string).getTime() : 0;
          };
          return getTs(a as Record<string, unknown>) - getTs(b as Record<string, unknown>);
        });

        trace = {
          available: true,
          runId: run.id,
          taskId: body.taskId,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          steps,
          approvals: runApprovals,
          toolInvocations,
          artifacts: artifactsResult.data ?? [],
          timeline,
          summary: {
            totalSteps: steps.length,
            totalToolCalls: toolInvocations.length,
            totalApprovals: runApprovals.length,
            phases: [...new Set(timeline.map((item) => (item as { phase: string }).phase))],
          },
        };
      }
    } catch (traceError) {
      console.error("[run-trace] failed to fetch trace:", traceError instanceof Error ? traceError.message : traceError);
      trace = { available: false, error: "trace_fetch_failed" };
    }
  }

  return NextResponse.json(
    { ...workflowResult.body, trace },
    { status: workflowResult.status }
  );
}
