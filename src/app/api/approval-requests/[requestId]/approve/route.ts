import { NextRequest, NextResponse } from "next/server";
import { decideApprovalRequest, getApprovalRequest } from "@/lib/agents/toolPolicy";
import { activateMcpProvisionFromApproval } from "@/lib/mcp/client";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";

export async function POST(req: NextRequest, { params }: { params: { requestId: string } }) {
  const body = (await req.json().catch(() => ({}))) as { officeId?: string; decidedBy?: string };
  const existing = await getApprovalRequest(params.requestId);
  const officeId = body.officeId?.trim() || existing?.officeId || "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const approval = await decideApprovalRequest(params.requestId, "approve", {
    decidedBy: body.decidedBy ?? guard.session.email,
  });
  const mcp =
    approval && existing?.status === "pending"
      ? await activateMcpProvisionFromApproval(approval)
      : null;

  return NextResponse.json({ approval, mcp });
}
