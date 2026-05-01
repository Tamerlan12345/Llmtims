import { NextRequest, NextResponse } from "next/server";
import { createAgentRun, listAgentRuns, type AgentRunMode } from "@/lib/agents/runService";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const officeId = searchParams.get("officeId")?.trim() ?? "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const runs = await listAgentRuns({
    officeId,
    taskId: searchParams.get("taskId"),
    limit: Number(searchParams.get("limit") ?? 25),
  });
  return NextResponse.json({ runs });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    officeId?: string;
    taskId?: string;
    input?: string | null;
    targetRole?: string | null;
    threadId?: string | null;
    roomKey?: string | null;
    mode?: AgentRunMode | null;
    metadata?: Record<string, unknown> | null;
  };
  const officeId = body.officeId?.trim() ?? "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const run = await createAgentRun({
    officeId,
    taskId: body.taskId ?? "",
    input: body.input,
    targetRole: body.targetRole,
    threadId: body.threadId,
    roomKey: body.roomKey,
    mode: body.mode,
    metadata: body.metadata,
  });
  return NextResponse.json({ run }, { status: 201 });
}
