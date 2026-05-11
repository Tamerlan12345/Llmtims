import { NextRequest, NextResponse } from "next/server";
import { listToolPolicies } from "@/lib/agents/toolPolicy";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const officeId = searchParams.get("officeId")?.trim() ?? "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const policies = await listToolPolicies(officeId);
  return NextResponse.json({ policies });
}
