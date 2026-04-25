import { NextRequest, NextResponse } from "next/server";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";
import { runAgentWorkflow, type RunAgentWorkflowInput } from "@/lib/agents/workflowRunner";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as RunAgentWorkflowInput;
  const officeId = typeof body.officeId === "string" ? body.officeId.trim() : "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const result = await runAgentWorkflow({
    ...body,
    officeId,
  });
  return NextResponse.json(result.body, { status: result.status });
}
