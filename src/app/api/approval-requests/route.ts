import { NextRequest, NextResponse } from "next/server";
import { listApprovalRequests, type ApprovalRequestStatus } from "@/lib/agents/toolPolicy";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const officeId = searchParams.get("officeId")?.trim() ?? "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const rawStatus = searchParams.get("status")?.trim() ?? "pending";
  const status = (rawStatus === "all" ? "all" : rawStatus) as ApprovalRequestStatus | "all";
  const approvals = await listApprovalRequests({
    officeId,
    status,
    limit: Number(searchParams.get("limit") ?? 50),
  });

  return NextResponse.json({ approvals });
}
