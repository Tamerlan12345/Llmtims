import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

interface RouteContext {
  params: {
    taskId?: string;
  };
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
