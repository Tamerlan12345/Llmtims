import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

interface CreateChatThreadBody {
  officeId?: string;
  title?: string;
}

interface ChatThreadRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  is_archived: boolean;
  metadata?: Record<string, unknown> | null;
}

const DEFAULT_THREAD_TITLE = "Оперативный чат";

const normalizeText = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
};

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const mapThreadRow = (row: ChatThreadRow) => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  isArchived: row.is_archived,
  activeTaskId:
    typeof row.metadata?.activeTaskId === "string" && row.metadata.activeTaskId.trim().length > 0
      ? row.metadata.activeTaskId.trim()
      : null,
});

export async function GET(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const officeIdParam = normalizeText(req.nextUrl.searchParams.get("officeId"), 120);
  const officeId = officeIdParam || session.activeOfficeId || session.offices[0]?.id || "";
  if (!officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const query = await supabase
    .from("chat_threads")
    .select("id, title, created_at, updated_at, is_archived, metadata")
    .eq("office_id", officeId)
    .eq("is_archived", false)
    .order("updated_at", { ascending: false });

  if (query.error) {
    return NextResponse.json({ error: query.error.message }, { status: 500 });
  }

  let rows = (query.data ?? []) as ChatThreadRow[];
  if (rows.length === 0) {
    const { data: created, error: createError } = await supabase
      .from("chat_threads")
      .insert({
        office_id: officeId,
        title: DEFAULT_THREAD_TITLE,
        created_by: isUuid(session.id) ? session.id : null,
      })
      .select("id, title, created_at, updated_at, is_archived, metadata")
      .single();

    if (createError) {
      return NextResponse.json({ error: createError.message }, { status: 500 });
    }

    rows = [created as ChatThreadRow];
  }

  return NextResponse.json(
    {
      threads: rows.map(mapThreadRow),
    },
    { status: 200 }
  );
}

export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const body = (await req.json()) as CreateChatThreadBody;
  const officeId = normalizeText(body.officeId, 120);
  if (!officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const title = normalizeText(body.title, 160) || DEFAULT_THREAD_TITLE;
  const { data: created, error: createError } = await supabase
    .from("chat_threads")
    .insert({
      office_id: officeId,
      title,
      created_by: isUuid(session.id) ? session.id : null,
      updated_at: new Date().toISOString(),
      metadata: {},
    })
    .select("id, title, created_at, updated_at, is_archived, metadata")
    .single();

  if (createError) {
    return NextResponse.json({ error: createError.message }, { status: 500 });
  }

  return NextResponse.json({ thread: mapThreadRow(created as ChatThreadRow) }, { status: 201 });
}
