import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

interface AgentContextRow {
  id: string;
  office_id: string;
  title: string;
  context_text: string;
  target_roles: string[] | null;
  target_agent_ids: string[] | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface UpdateAgentContextBody {
  officeId?: string;
  title?: string;
  contextText?: string;
  targetRoles?: unknown;
  targetAgentIds?: unknown;
  isActive?: boolean;
}

const normalizeText = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
};

const normalizeStringArray = (value: unknown, maxLength = 120): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim().slice(0, maxLength) : ""))
        .filter((item) => item.length > 0)
    )
  );
};

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

const mapContextRow = (row: AgentContextRow) => ({
  id: row.id,
  officeId: row.office_id,
  title: row.title,
  contextText: row.context_text,
  targetRoles: Array.isArray(row.target_roles) ? row.target_roles : [],
  targetAgentIds: Array.isArray(row.target_agent_ids) ? row.target_agent_ids : [],
  isActive: row.is_active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const resolveContext = async (contextId: string): Promise<AgentContextRow | null> => {
  const { data, error } = await supabase
    .from("agent_context_items")
    .select("id, office_id, title, context_text, target_roles, target_agent_ids, is_active, created_at, updated_at")
    .eq("id", contextId)
    .maybeSingle();

  if (error || !data) return null;
  return data as AgentContextRow;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: { contextId: string } }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const contextId = normalizeText(params.contextId, 120);
  if (!contextId) {
    return NextResponse.json({ error: "contextId is required" }, { status: 400 });
  }

  const current = await resolveContext(contextId);
  if (!current) {
    return NextResponse.json({ error: "Context not found" }, { status: 404 });
  }

  if (!hasOfficeAccess(current.office_id, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const body = (await req.json()) as UpdateAgentContextBody;
  if (body.officeId && body.officeId !== current.office_id) {
    return NextResponse.json({ error: "officeId mismatch" }, { status: 400 });
  }

  const title = normalizeText(body.title, 160) || current.title;
  const contextText = normalizeText(body.contextText, 12000) || current.context_text;
  const targetRoles =
    body.targetRoles !== undefined ? normalizeStringArray(body.targetRoles, 120) : current.target_roles ?? [];
  const targetAgentIds =
    body.targetAgentIds !== undefined
      ? normalizeStringArray(body.targetAgentIds, 120)
      : current.target_agent_ids ?? [];

  const { data: updated, error: updateError } = await supabase
    .from("agent_context_items")
    .update({
      title,
      context_text: contextText,
      target_roles: targetRoles,
      target_agent_ids: targetAgentIds,
      is_active: typeof body.isActive === "boolean" ? body.isActive : current.is_active,
      updated_at: new Date().toISOString(),
    })
    .eq("id", contextId)
    .eq("office_id", current.office_id)
    .select("id, office_id, title, context_text, target_roles, target_agent_ids, is_active, created_at, updated_at")
    .single();

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ context: mapContextRow(updated as AgentContextRow) }, { status: 200 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { contextId: string } }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const contextId = normalizeText(params.contextId, 120);
  const officeId = normalizeText(req.nextUrl.searchParams.get("officeId"), 120);
  if (!contextId || !officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const current = await resolveContext(contextId);
  if (!current || current.office_id !== officeId) {
    return NextResponse.json({ error: "Context not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("agent_context_items")
    .delete()
    .eq("id", contextId)
    .eq("office_id", officeId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
