import { NextRequest, NextResponse } from "next/server";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";
import { evaluateBudget } from "@/lib/agents/budgetGuard";

export async function GET(_req: NextRequest, { params }: { params: { officeId: string } }) {
  const officeId = params.officeId?.trim();
  if (!officeId) {
    return NextResponse.json({ error: "officeId is required" }, { status: 400 });
  }

  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const evaluation = await evaluateBudget(officeId);
  return NextResponse.json({ officeId, budget: evaluation });
}
