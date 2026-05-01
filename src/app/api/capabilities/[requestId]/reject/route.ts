import { NextRequest, NextResponse } from "next/server";
import { getCapabilityRequest, rejectCapabilityRequest } from "@/lib/agents/capabilityService";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";

export async function POST(req: NextRequest, { params }: { params: { requestId: string } }) {
  const body = (await req.json().catch(() => ({}))) as { officeId?: string; rejectedBy?: string };
  const existingRequest = await getCapabilityRequest(params.requestId);
  const officeId = body.officeId?.trim() || existingRequest?.officeId || "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const request = await rejectCapabilityRequest(params.requestId, body.rejectedBy ?? guard.session.email);
  return NextResponse.json({ request });
}
