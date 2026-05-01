import { NextRequest, NextResponse } from "next/server";
import { claimNextAgentRun } from "@/lib/agents/runService";
import { isValidAgentWorkerRequest } from "@/lib/auth/workerAuth";

export async function POST(req: NextRequest) {
  if (!isValidAgentWorkerRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as { workerId?: string; officeId?: string };
  const run = await claimNextAgentRun({
    workerId: body.workerId,
    officeId: body.officeId,
  });
  return NextResponse.json({ run });
}
