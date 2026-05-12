import { NextRequest, NextResponse } from "next/server";
import { getAgentWorkerHealth } from "@/lib/agents/workerHealth";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const officeId = searchParams.get("officeId")?.trim() ?? "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const health = await getAgentWorkerHealth(officeId);
  return NextResponse.json({ health });
}
