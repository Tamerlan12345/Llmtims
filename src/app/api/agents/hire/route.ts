import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import {
  collectOccupiedDeskKeys,
  deskKey,
  pickFirstFreeDesk,
  type OfficeDesk,
} from "@/lib/offices/desks";

interface HireAgentBody {
  officeId?: string;
  roleName?: string;
  displayName?: string;
  roleMarkdown?: string;
  skills?: unknown;
  metadata?: unknown;
}

interface ExistingAgentRow {
  metadata?: unknown;
}

interface SkillRow {
  id: string;
  name: string;
}

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

const normalizeText = (value: unknown, maxLength = 4000): string => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
};

const normalizeSkillNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0)
    )
  );
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const buildAgentMetadata = (
  roleName: string,
  desk: OfficeDesk,
  metadataInput?: unknown
): Record<string, unknown> => {
  const existing = isObjectRecord(metadataInput) ? metadataInput : {};
  const action =
    normalizeText(existing.action_description, 800) ||
    normalizeText(existing.action, 800) ||
    `Агент ${roleName} выполняет задачу`;

  return {
    ...existing,
    x: desk.x,
    y: desk.y,
    default_x: desk.x,
    default_y: desk.y,
    action,
    action_description: action,
  };
};

export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const body = (await req.json()) as HireAgentBody;
  const officeId = normalizeText(body.officeId, 120);
  const roleName = normalizeText(body.roleName, 120);
  const displayName = normalizeText(body.displayName, 120) || roleName;
  const roleMarkdown = normalizeText(body.roleMarkdown, 12000);
  const skillNames = normalizeSkillNames(body.skills);

  if (!officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  if (!roleName) {
    return NextResponse.json({ error: "Role name is required" }, { status: 400 });
  }

  const { data: existingAgents, error: existingAgentsError } = await supabase
    .from("agents")
    .select("metadata")
    .eq("office_id", officeId);

  if (existingAgentsError) {
    return NextResponse.json({ error: existingAgentsError.message }, { status: 500 });
  }

  const occupiedDesks = collectOccupiedDeskKeys((existingAgents ?? []) as ExistingAgentRow[]);
  const desk = pickFirstFreeDesk(occupiedDesks);
  if (!desk) {
    return NextResponse.json({ error: "Нет свободных столов в этом офисе" }, { status: 409 });
  }

  occupiedDesks.add(deskKey(desk));
  const metadata = buildAgentMetadata(roleName, desk, body.metadata);

  const { data: createdAgent, error: createdAgentError } = await supabase
    .from("agents")
    .insert({
      office_id: officeId,
      role: roleName,
      name: displayName,
      role_md: roleMarkdown || null,
      is_active: false,
      metadata,
    })
    .select("id, role, name")
    .single();

  if (createdAgentError || !createdAgent?.id) {
    return NextResponse.json(
      { error: createdAgentError?.message ?? "agent_create_failed" },
      { status: 500 }
    );
  }

  if (skillNames.length > 0) {
    const { data: skillRows, error: skillRowsError } = await supabase
      .from("skills_catalog")
      .select("id, name")
      .in("name", skillNames)
      .eq("is_active", true);

    if (skillRowsError) {
      return NextResponse.json({ error: skillRowsError.message }, { status: 500 });
    }

    const skillRecords = (skillRows ?? []) as SkillRow[];
    if (skillRecords.length > 0) {
      const assignments = skillRecords.map((skill) => ({
        agent_id: createdAgent.id,
        skill_id: skill.id,
        office_id: officeId,
        is_enabled: true,
      }));

      const { error: assignmentError } = await supabase
        .from("agent_skills")
        .upsert(assignments, { onConflict: "agent_id,skill_id" });

      if (assignmentError) {
        return NextResponse.json({ error: assignmentError.message }, { status: 500 });
      }
    }
  }

  const { error: runtimeStateError } = await supabase.from("agent_states").upsert(
    {
      agent_id: createdAgent.id,
      office_id: officeId,
      status: "idle",
      current_action: String(metadata.action_description ?? metadata.action ?? "Агент ожидает задачу"),
      current_skill: null,
      current_target_x: desk.x,
      current_target_y: desk.y,
      metadata: { source: "manual-hire", ...metadata },
    },
    { onConflict: "agent_id" }
  );

  if (runtimeStateError) {
    return NextResponse.json({ error: runtimeStateError.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      success: true,
      agent: {
        id: createdAgent.id,
        role: createdAgent.role,
        name: createdAgent.name,
        desk,
      },
    },
    { status: 201 }
  );
}

