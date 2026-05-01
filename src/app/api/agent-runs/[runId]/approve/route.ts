import { NextRequest, NextResponse } from "next/server";
import { approveAgentRun, getAgentRun } from "@/lib/agents/runService";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  const body = (await req.json().catch(() => ({}))) as { officeId?: string };
  const existingRun = await getAgentRun(params.runId);
  const officeId = body.officeId?.trim() || existingRun?.officeId || "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const run = await approveAgentRun(params.runId);
  return NextResponse.json({ run });
}
