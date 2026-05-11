import { NextRequest, NextResponse } from "next/server";
import { decideApprovalRequest, getApprovalRequest } from "@/lib/agents/toolPolicy";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";

export async function POST(req: NextRequest, { params }: { params: { requestId: string } }) {
  const body = (await req.json().catch(() => ({}))) as {
    officeId?: string;
    decidedBy?: string;
    reason?: string;
  };
  const existing = await getApprovalRequest(params.requestId);
  const officeId = body.officeId?.trim() || existing?.officeId || "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const approval = await decideApprovalRequest(params.requestId, "reject", {
    decidedBy: body.decidedBy ?? guard.session.email,
    reason: body.reason,
  });
  return NextResponse.json({ approval });
}
