import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import {
  parseAgentContextReferenceAssets,
  type AgentContextReferenceAsset,
} from "@/lib/agentContextAssets";
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

const CONTEXT_ASSETS_BUCKET = process.env.SKILL_ARTIFACTS_BUCKET ?? "office-artifacts";

interface CreateAgentContextBody {
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

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const createSignedStorageUrl = async (
  bucketName: string,
  storagePath: string
): Promise<string | null> => {
  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 30);

    if (error || typeof data?.signedUrl !== "string" || data.signedUrl.trim().length === 0) {
      return null;
    }

    return data.signedUrl;
  } catch {
    return null;
  }
};

const hydrateReferenceAssets = async (
  contextText: string
): Promise<AgentContextReferenceAsset[]> => {
  const parsedAssets = parseAgentContextReferenceAssets(contextText);
  return Promise.all(
    parsedAssets.map(async (asset) => ({
      ...asset,
      url:
        (await createSignedStorageUrl(
          asset.storageBucket || CONTEXT_ASSETS_BUCKET,
          asset.storagePath
        )) ?? asset.url ?? null,
    }))
  );
};

const mapContextRow = async (row: AgentContextRow) => ({
  id: row.id,
  officeId: row.office_id,
  title: row.title,
  contextText: row.context_text,
  targetRoles: Array.isArray(row.target_roles) ? row.target_roles : [],
  targetAgentIds: Array.isArray(row.target_agent_ids) ? row.target_agent_ids : [],
  isActive: row.is_active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  referenceAssets: await hydrateReferenceAssets(row.context_text),
});

export async function GET(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const officeId = normalizeText(req.nextUrl.searchParams.get("officeId"), 120);
  if (!officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("agent_context_items")
    .select("id, office_id, title, context_text, target_roles, target_agent_ids, is_active, created_at, updated_at")
    .eq("office_id", officeId)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      contexts: await Promise.all(((data ?? []) as AgentContextRow[]).map((row) => mapContextRow(row))),
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

  const body = (await req.json()) as CreateAgentContextBody;
  const officeId = normalizeText(body.officeId, 120);
  if (!officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const title = normalizeText(body.title, 160);
  const contextText = normalizeText(body.contextText, 12000);
  if (!title || !contextText) {
    return NextResponse.json({ error: "Title and contextText are required" }, { status: 400 });
  }

  const { data: created, error: createError } = await supabase
    .from("agent_context_items")
    .insert({
      office_id: officeId,
      title,
      context_text: contextText,
      target_roles: normalizeStringArray(body.targetRoles, 120),
      target_agent_ids: normalizeStringArray(body.targetAgentIds, 120),
      is_active: body.isActive !== false,
      created_by: isUuid(session.id) ? session.id : null,
      updated_at: new Date().toISOString(),
    })
    .select("id, office_id, title, context_text, target_roles, target_agent_ids, is_active, created_at, updated_at")
    .single();

  if (createError) {
    return NextResponse.json({ error: createError.message }, { status: 500 });
  }

  return NextResponse.json({ context: await mapContextRow(created as AgentContextRow) }, { status: 201 });
}
