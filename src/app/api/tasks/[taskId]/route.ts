import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

const normalizeText = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
};

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

export async function DELETE(
  req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const taskId = normalizeText(params.taskId, 120);
  const officeId = normalizeText(req.nextUrl.searchParams.get("officeId"), 120);
  if (!taskId || !officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const { data: taskRow, error: taskError } = await supabase
    .from("tasks")
    .select("id")
    .eq("id", taskId)
    .eq("office_id", officeId)
    .maybeSingle();

  if (taskError || !taskRow) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  await supabase.from("sub_tasks").delete().eq("task_id", taskId).eq("office_id", officeId);
  await supabase
    .from("team_events")
    .delete()
    .eq("office_id", officeId)
    .or(`task_id.eq.${taskId},payload->>taskId.eq.${taskId}`);

  const { error: deleteError } = await supabase
    .from("tasks")
    .delete()
    .eq("id", taskId)
    .eq("office_id", officeId);

  if (!deleteError) {
    return NextResponse.json({ success: true, mode: "deleted" }, { status: 200 });
  }

  const { error: archiveError } = await supabase
    .from("tasks")
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("office_id", officeId);

  if (archiveError) {
    return NextResponse.json({ error: archiveError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, mode: "archived" }, { status: 200 });
}
