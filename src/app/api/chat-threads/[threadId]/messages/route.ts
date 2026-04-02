import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

interface ChatThreadRow {
  id: string;
  office_id: string;
  is_archived: boolean;
}

interface ChatMessageRow {
  id: string;
  sender: "user" | "agent" | "system";
  content: string;
  role: string | null;
  agent_name: string | null;
  scope: string | null;
  target_role: string | null;
  client_message_id: string | null;
  task_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface CreateChatMessageBody {
  officeId?: string;
  sender?: "user" | "agent" | "system";
  content?: string;
  role?: string | null;
  agentName?: string | null;
  scope?: string | null;
  targetRole?: string | null;
  clientMessageId?: string | null;
  taskId?: string | null;
  metadata?: Record<string, unknown> | null;
}

const normalizeText = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
};

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

const mapMessageRow = (row: ChatMessageRow) => ({
  id: row.id,
  sender: row.sender,
  content: row.content,
  role: row.role,
  agentName: row.agent_name,
  scope: row.scope,
  targetRole: row.target_role,
  clientMessageId: row.client_message_id,
  taskId: row.task_id,
  metadata: row.metadata,
  createdAt: row.created_at,
});

const resolveThread = async (threadId: string): Promise<ChatThreadRow | null> => {
  const { data, error } = await supabase
    .from("chat_threads")
    .select("id, office_id, is_archived")
    .eq("id", threadId)
    .maybeSingle();

  if (error || !data) return null;
  return data as ChatThreadRow;
};

export async function GET(
  req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const threadId = normalizeText(params.threadId, 120);
  const officeId = normalizeText(req.nextUrl.searchParams.get("officeId"), 120);
  if (!threadId || !officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const thread = await resolveThread(threadId);
  if (!thread || thread.office_id !== officeId || thread.is_archived) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const { data, error } = await supabase
    .from("chat_messages")
    .select(
      "id, sender, content, role, agent_name, scope, target_role, client_message_id, task_id, metadata, created_at"
    )
    .eq("thread_id", threadId)
    .eq("office_id", officeId)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      messages: ((data ?? []) as ChatMessageRow[]).map(mapMessageRow),
    },
    { status: 200 }
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: { threadId: string } }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const threadId = normalizeText(params.threadId, 120);
  const body = (await req.json()) as CreateChatMessageBody;
  const officeId = normalizeText(body.officeId, 120);
  if (!threadId || !officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const thread = await resolveThread(threadId);
  if (!thread || thread.office_id !== officeId || thread.is_archived) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const sender = body.sender === "user" || body.sender === "agent" || body.sender === "system" ? body.sender : "user";
  const content = normalizeText(body.content, 20000);
  if (!content) {
    return NextResponse.json({ error: "Message content is required" }, { status: 400 });
  }

  const clientMessageId = normalizeText(body.clientMessageId, 200) || null;
  if (clientMessageId) {
    const existing = await supabase
      .from("chat_messages")
      .select(
        "id, sender, content, role, agent_name, scope, target_role, client_message_id, task_id, metadata, created_at"
      )
      .eq("thread_id", threadId)
      .eq("office_id", officeId)
      .eq("sender", sender)
      .eq("client_message_id", clientMessageId)
      .maybeSingle();

    if (existing.data) {
      return NextResponse.json({ message: mapMessageRow(existing.data as ChatMessageRow) }, { status: 200 });
    }
  }

  const insertPayload = {
    thread_id: threadId,
    office_id: officeId,
    sender,
    content,
    role: normalizeText(body.role, 120) || null,
    agent_name: normalizeText(body.agentName, 120) || null,
    scope: normalizeText(body.scope, 40) || null,
    target_role: normalizeText(body.targetRole, 120) || null,
    client_message_id: clientMessageId,
    task_id: normalizeText(body.taskId, 120) || null,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
  };

  const { data: created, error: createError } = await supabase
    .from("chat_messages")
    .insert(insertPayload)
    .select(
      "id, sender, content, role, agent_name, scope, target_role, client_message_id, task_id, metadata, created_at"
    )
    .single();

  if (createError) {
    return NextResponse.json({ error: createError.message }, { status: 500 });
  }

  await supabase
    .from("chat_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId)
    .eq("office_id", officeId);

  return NextResponse.json({ message: mapMessageRow(created as ChatMessageRow) }, { status: 201 });
}
