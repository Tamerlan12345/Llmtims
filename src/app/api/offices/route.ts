import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

interface CreateOfficeBody {
  name?: string;
}

interface OfficeRow {
  id: string;
  name: string | null;
}

const MAX_OFFICE_NAME_LENGTH = 120;

const normalizeOfficeName = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, MAX_OFFICE_NAME_LENGTH);
};

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({ offices: session.offices }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const body = (await req.json()) as CreateOfficeBody;
  const name = normalizeOfficeName(body.name);
  if (!name) {
    return NextResponse.json({ error: "Office name is required" }, { status: 400 });
  }

  // Basic UUID validation for owner_id
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.id);
  const ownerId = isUuid ? session.id : null;

  if (!ownerId) {
    return NextResponse.json({ error: "Invalid owner account for database operations. Please re-login." }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("offices")
    .insert({
      owner_id: ownerId,
      name,
    })
    .select("id, name")
    .single();

  if (error || !data?.id) {
    console.error(`[api/offices] insert failed for owner ${ownerId}:`, error?.message || "No data returned");
    return NextResponse.json({ 
      error: error?.message ?? "office_create_failed",
      detail: "Убедитесь, что название департамента уникально и ваш аккаунт активен."
    }, { status: 500 });
  }

  const office = data as OfficeRow;
  return NextResponse.json(
    {
      office: {
        id: office.id,
        name: office.name?.trim() || name,
        accessRole: "owner" as const,
      },
    },
    { status: 201 }
  );
}

