import { NextRequest, NextResponse } from "next/server";
import { queueTaskRun } from "@/lib/agents/taskRunCommand";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    officeId?: string;
    input?: string;
    targetRole?: string | null;
    taskId?: string | null;
    threadId?: string | null;
    roomKey?: string | null;
    mode?: "plan" | "auto" | "manual" | "review" | "autofix" | "approval_required" | null;
    metadata?: Record<string, unknown> | null;
  };

  const officeId = body.officeId?.trim() ?? "";
  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  try {
    const result = await queueTaskRun({
      officeId,
      input: body.input ?? "",
      targetRole: body.targetRole,
      taskId: body.taskId,
      threadId: body.threadId,
      roomKey: body.roomKey,
      mode: body.mode,
      source: "task-runs.api",
      metadata: body.metadata ?? {},
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "task_run_queue_failed";
    const status = reason === "officeId and input are required." ? 400 : 500;
    return NextResponse.json({ error: reason }, { status });
  }
}
