import { randomUUID } from "node:crypto";
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

interface SupabaseInsertErrorLike {
  code?: string;
  message?: string;
}

const MAX_OFFICE_NAME_LENGTH = 120;

const normalizeOfficeName = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, MAX_OFFICE_NAME_LENGTH);
};

const mapCreateOfficeError = (
  error: SupabaseInsertErrorLike | null | undefined
): { status: number; error: string; detail: string } => {
  const code = String(error?.code ?? "").trim();
  const message = String(error?.message ?? "").toLowerCase();

  if (code === "23505") {
    return {
      status: 409,
      error: "office_name_conflict",
      detail: "Департамент с таким названием уже существует.",
    };
  }

  if (code === "23503") {
    return {
      status: 403,
      error: "owner_not_found",
      detail: "Администратор не найден в БД. Войдите заново.",
    };
  }

  if (code === "42501" || message.includes("row-level security")) {
    return {
      status: 503,
      error: "supabase_service_role_required",
      detail:
        "Для создания департамента нужен SUPABASE_SERVICE_ROLE_KEY в server env (config.env/Railway). ANON-ключа недостаточно.",
    };
  }

  return {
    status: 500,
    error: error?.message ?? "office_create_failed",
    detail: "Не удалось создать департамент. Проверьте конфигурацию БД и права доступа.",
  };
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

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return NextResponse.json(
      {
        error: "supabase_service_role_required",
        detail:
          "Добавьте SUPABASE_SERVICE_ROLE_KEY в server env (config.env/Railway). Иначе создание департамента блокируется RLS.",
      },
      { status: 503 }
    );
  }

  const body = (await req.json()) as CreateOfficeBody;
  const name = normalizeOfficeName(body.name);
  if (!name) {
    return NextResponse.json({ error: "Office name is required" }, { status: 400 });
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.id);
  const ownerId = isUuid ? session.id : null;

  if (!ownerId) {
    return NextResponse.json(
      { error: "Invalid owner account for database operations. Please re-login." },
      { status: 403 }
    );
  }

  const officeId = randomUUID();
  const { error } = await supabase.from("offices").insert({
    id: officeId,
    owner_id: ownerId,
    name,
  });

  if (error) {
    console.error(`[api/offices] insert failed for owner ${ownerId}:`, error.message);
    const mapped = mapCreateOfficeError(error as SupabaseInsertErrorLike);
    return NextResponse.json(
      {
        error: mapped.error,
        detail: mapped.detail,
      },
      { status: mapped.status }
    );
  }

  const { error: memberError } = await supabase.from("office_members").upsert(
    {
      office_id: officeId,
      admin_id: ownerId,
      role: "owner",
      is_active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "office_id,admin_id" }
  );

  if (memberError) {
    console.error(`[api/offices] owner membership upsert failed for office ${officeId}:`, memberError.message);
  }

  const office: OfficeRow = {
    id: officeId,
    name,
  };

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

