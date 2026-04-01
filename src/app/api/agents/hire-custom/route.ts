import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import {
  collectOccupiedDeskKeys,
  deskKey,
  getFreeDesk,
  type OfficeDesk,
} from "@/lib/offices/desks";

interface HireCustomAgentBody {
  officeId: string;
  name: string;
  profession: string;
  avatarIndex: number;
  skills: string[]; // skill IDs
  saveAsPreset?: boolean;
}

interface ExistingAgentRow {
  metadata?: unknown;
}

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

const buildAgentMetadata = (
  roleName: string,
  desk: OfficeDesk,
  paletteIndex: number
): Record<string, unknown> => {
  const action = `Агент ${roleName} нанят в офис.`;

  return {
    x: desk.x,
    y: desk.y,
    default_x: desk.x,
    default_y: desk.y,
    action,
    action_description: action,
    paletteIndex,
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

  const body = (await req.json()) as HireCustomAgentBody;
  const { officeId, name, profession, avatarIndex, skills, saveAsPreset } = body;

  if (!officeId || !hasOfficeAccess(officeId, session.offices.map((o) => o.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  if (!name || !profession) {
    return NextResponse.json({ error: "Name and Profession are required" }, { status: 400 });
  }

  const { data: existingAgents, error: existingAgentsError } = await supabase
    .from("agents")
    .select("metadata")
    .eq("office_id", officeId);

  if (existingAgentsError) {
    return NextResponse.json({ error: existingAgentsError.message }, { status: 500 });
  }

  const occupiedDesks = collectOccupiedDeskKeys((existingAgents ?? []) as ExistingAgentRow[]);
  const desk = getFreeDesk(occupiedDesks);
  if (!desk) {
    return NextResponse.json({ error: "Нет свободных столов в этом офисе" }, { status: 409 });
  }

  const metadata = buildAgentMetadata(profession, desk, avatarIndex);

  const { data: createdAgent, error: createdAgentError } = await supabase
    .from("agents")
    .insert({
      office_id: officeId,
      role: profession,
      name: name,
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

  if (skills && skills.length > 0) {
    const assignments = skills.map((skillId) => ({
      agent_id: createdAgent.id,
      skill_id: skillId,
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

  const { error: runtimeStateError } = await supabase.from("agent_states").upsert(
    {
      agent_id: createdAgent.id,
      office_id: officeId,
      status: "idle",
      current_action: String(metadata.action_description ?? "Агент ожидает задачу"),
      current_skill: null,
      current_target_x: desk.x,
      current_target_y: desk.y,
      metadata: { source: "manual-hire-custom", ...metadata },
    },
    { onConflict: "agent_id" }
  );

  if (runtimeStateError) {
    return NextResponse.json({ error: runtimeStateError.message }, { status: 500 });
  }

  if (saveAsPreset) {
    const { data: skillRows } = await supabase
      .from("skills_catalog")
      .select("id, name")
      .in("id", skills || []);

    const skillNames = (skillRows ?? []).map((s) => s.name);

    await supabase.from("team_templates").insert({
      name: `Специалист ${profession}: ${name}`,
      description: `Пользовательский шаблон сотрудника с навыками: ${skillNames.join(", ")}`,
      roles_json: [
        {
          roleKey: profession.toLowerCase().replace(/\s+/g, "_"),
          displayName: name,
          runtimeRole: profession,
          skills: skillNames,
          metadata: { paletteIndex: avatarIndex },
        },
      ],
      created_by: session.id,
    });
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
