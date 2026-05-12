import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { publishTeamEvent } from "@/lib/agents/realtime";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

interface RouteContext {
  params: {
    taskId?: string;
  };
}

const ALLOWED_TASK_STATUSES = new Set([
  "pending",
  "waiting_approval",
  "in_progress",
  "review",
  "done",
  "failed",
]);

const normalizeStatus = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

export async function PATCH(req: NextRequest, context: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const taskId = context.params?.taskId?.trim() ?? "";
  if (!taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    status?: unknown;
    officeId?: unknown;
  };
  const nextStatus = normalizeStatus(body.status);
  if (!ALLOWED_TASK_STATUSES.has(nextStatus)) {
    return NextResponse.json({ error: "Unsupported task status" }, { status: 400 });
  }

  const { data: taskRow, error: taskError } = await supabase
    .from("tasks")
    .select("id, office_id, status")
    .eq("id", taskId)
    .maybeSingle();

  if (taskError) {
    return NextResponse.json({ error: taskError.message }, { status: 500 });
  }

  if (!taskRow?.id || typeof taskRow.office_id !== "string") {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const requestedOfficeId = typeof body.officeId === "string" ? body.officeId.trim() : "";
  if (requestedOfficeId && requestedOfficeId !== taskRow.office_id) {
    return NextResponse.json({ error: "Office mismatch" }, { status: 403 });
  }

  const hasOfficeAccess = session.offices.some((office) => office.id === taskRow.office_id);
  if (!hasOfficeAccess) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const previousStatus = typeof taskRow.status === "string" ? taskRow.status : null;
  if (previousStatus === "archived") {
    return NextResponse.json({ error: "Archived task cannot be moved" }, { status: 409 });
  }

  const updatedAt = new Date().toISOString();
  const { data: updatedTask, error: updateError } = await supabase
    .from("tasks")
    .update({
      status: nextStatus,
      updated_at: updatedAt,
    })
    .eq("id", taskId)
    .eq("office_id", taskRow.office_id)
    .select("*")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  await publishTeamEvent({
    eventName: "task.status_changed",
    scope: "system",
    payload: {
      taskId,
      officeId: taskRow.office_id,
      previousStatus,
      nextStatus,
      source: "tasks.patch",
    },
  });

  return NextResponse.json({
    ok: true,
    task: updatedTask ?? {
      ...taskRow,
      status: nextStatus,
      updated_at: updatedAt,
    },
  });
}

export async function DELETE(_req: NextRequest, context: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const taskId = context.params?.taskId?.trim() ?? "";
  if (!taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  const { data: taskRow, error: taskError } = await supabase
    .from("tasks")
    .select("id, office_id, status")
    .eq("id", taskId)
    .maybeSingle();

  if (taskError) {
    return NextResponse.json({ error: taskError.message }, { status: 500 });
  }

  if (!taskRow?.id || typeof taskRow.office_id !== "string") {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const hasOfficeAccess = session.offices.some((office) => office.id === taskRow.office_id);
  if (!hasOfficeAccess) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const updatedAt = new Date().toISOString();
  const { data: archivedTask, error: updateError } = await supabase
    .from("tasks")
    .update({
      status: "archived",
      updated_at: updatedAt,
    })
    .eq("id", taskId)
    .eq("office_id", taskRow.office_id)
    .select("*")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    task: archivedTask ?? {
      ...taskRow,
      status: "archived",
      updated_at: updatedAt,
    },
  });
}
