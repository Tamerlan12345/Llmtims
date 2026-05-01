import { NextRequest, NextResponse } from "next/server";
import { getAgentRun, processAgentRun } from "@/lib/agents/runService";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";
import { isValidAgentWorkerRequest } from "@/lib/auth/workerAuth";

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  const body = (await req.json().catch(() => ({}))) as { workerId?: string; officeId?: string };
  const isWorker = isValidAgentWorkerRequest(req);
  if (!isWorker) {
    const run = await getAgentRun(params.runId);
    const officeId = body.officeId?.trim() || run?.officeId || "";
    const guard = await requireAdminOfficeAccess(officeId);
    if (guard.response) {
      return guard.response;
    }
  }

  const result = await processAgentRun(params.runId, { workerId: body.workerId });
  return NextResponse.json(result);
}
