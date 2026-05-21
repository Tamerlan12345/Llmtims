import { NextRequest, NextResponse } from "next/server";
import { getAgentRun } from "@/lib/agents/runService";
import { getAgentRunToolDetail } from "@/lib/agents/rufloCore";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";

export async function GET(
  req: NextRequest,
  { params }: { params: { runId: string; detailToken: string } }
) {
  const run = await getAgentRun(params.runId);
  if (!run) {
    return NextResponse.json({ error: "agent_run_not_found" }, { status: 404 });
  }

  const requestedOfficeId = new URL(req.url).searchParams.get("officeId")?.trim();
  if (requestedOfficeId && requestedOfficeId !== run.officeId) {
    return NextResponse.json({ error: "agent_run_office_mismatch" }, { status: 403 });
  }

  const guard = await requireAdminOfficeAccess(run.officeId);
  if (guard.response) {
    return guard.response;
  }

  const detail = await getAgentRunToolDetail(params.runId, params.detailToken, run.officeId);
  if (!detail) {
    return NextResponse.json({ error: "tool_detail_not_found" }, { status: 404 });
  }

  return NextResponse.json({ detail });
}
