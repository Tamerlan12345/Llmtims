import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import {
  parseTeamTemplateRoles,
  type TeamTemplateRoleEntry,
} from "@/lib/teamTemplates";
import {
  OFFICE_DESKS,
  collectOccupiedDeskKeys,
  deskKey,
  pickFirstFreeDesk,
  type OfficeDesk,
} from "@/lib/offices/desks";

interface HireTemplateBody {
  officeId?: string;
  templateId?: string;
}

interface AgentRow {
  id: string;
  role: string;
  name: string | null;
}

interface ExistingAgentRow extends AgentRow {
  metadata?: unknown;
}

interface RoleAssignment {
  roleEntry: TeamTemplateRoleEntry;
  agent: AgentRow;
  metadata: Record<string, unknown>;
  desk: OfficeDesk;
}

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

const buildRoleMetadata = (
  roleEntry: TeamTemplateRoleEntry,
  desk: OfficeDesk
): Record<string, unknown> => {
  const existingMetadata = roleEntry.metadata ?? {};
  const displayName =
    typeof roleEntry.displayName === "string" && roleEntry.displayName.trim().length > 0
      ? roleEntry.displayName.trim()
      : roleEntry.runtimeRole;
  const normalizedAction =
    typeof existingMetadata.action_description === "string" &&
    existingMetadata.action_description.trim().length > 0
      ? existingMetadata.action_description.trim()
      : typeof existingMetadata.action === "string" && existingMetadata.action.trim().length > 0
        ? existingMetadata.action.trim()
        : `Агент ${displayName} выполняет задачу`;

  return {
    ...existingMetadata,
    x: desk.x,
    y: desk.y,
    default_x: desk.x,
    default_y: desk.y,
    action: normalizedAction,
    action_description: normalizedAction,
    is_coordinator: existingMetadata.is_coordinator === true,
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

  const body = (await req.json()) as HireTemplateBody;
  const officeId = body.officeId?.trim() ?? "";
  const templateId = body.templateId?.trim() ?? "";

  if (!officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  if (!templateId) {
    return NextResponse.json({ error: "templateId is required" }, { status: 400 });
  }

  const { data: template, error: templateError } = await supabase
    .from("team_templates")
    .select("id, name, roles_json")
    .eq("id", templateId)
    .maybeSingle();

  if (templateError) {
    return NextResponse.json({ error: templateError.message }, { status: 500 });
  }

  if (!template?.id) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const roles = parseTeamTemplateRoles(template.roles_json);
  if (roles.length === 0) {
    return NextResponse.json({ error: "Template has no runtime roles" }, { status: 400 });
  }

  const { data: existingAgents, error: existingAgentsError } = await supabase
    .from("agents")
    .select("id, role, name, metadata")
    .eq("office_id", officeId);

  if (existingAgentsError) {
    return NextResponse.json({ error: existingAgentsError.message }, { status: 500 });
  }

  const occupiedDesks = collectOccupiedDeskKeys((existingAgents ?? []) as ExistingAgentRow[]);
  const remainingDeskCount = OFFICE_DESKS.length - occupiedDesks.size;
  if (roles.length > remainingDeskCount) {
    return NextResponse.json(
      {
        error: "Нет свободных столов в этом офисе",
        details: {
          available: remainingDeskCount,
          requested: roles.length,
        },
      },
      { status: 409 }
    );
  }

  const roleAssignments: RoleAssignment[] = [];
  for (const roleEntry of roles) {
    const desk = pickFirstFreeDesk(occupiedDesks);
    if (!desk) {
      return NextResponse.json({ error: "Нет свободных столов в этом офисе" }, { status: 409 });
    }
    occupiedDesks.add(deskKey(desk));

    const metadata = buildRoleMetadata(roleEntry, desk);
    const { data: createdAgent, error: createAgentError } = await supabase
      .from("agents")
      .insert({
        office_id: officeId,
        name: roleEntry.displayName?.trim() || roleEntry.runtimeRole,
        role: roleEntry.runtimeRole,
        is_active: false,
        metadata,
        role_md: roleEntry.roleMarkdown ?? null,
      })
      .select("id, role, name")
      .single();

    if (createAgentError || !createdAgent?.id) {
      return NextResponse.json(
        { error: createAgentError?.message ?? `Failed to hire ${roleEntry.runtimeRole}` },
        { status: 500 }
      );
    }

    roleAssignments.push({
      roleEntry,
      agent: createdAgent as AgentRow,
      metadata,
      desk,
    });
  }

  const skillNames = Array.from(new Set(roles.flatMap((role) => role.skills)));
  if (skillNames.length > 0) {
    const { data: skills, error: skillsError } = await supabase
      .from("skills_catalog")
      .select("id, name")
      .in("name", skillNames);

    if (skillsError) {
      return NextResponse.json({ error: skillsError.message }, { status: 500 });
    }

    const skillIdByName = new Map<string, string>();
    for (const skill of skills ?? []) {
      if (typeof skill.id === "string" && typeof skill.name === "string") {
        skillIdByName.set(skill.name, skill.id);
      }
    }

    const skillAssignments = roleAssignments.flatMap(({ roleEntry, agent }) => {
      if (!agent?.id) return [];

      return roleEntry.skills
        .map((skillName) => {
          const skillId = skillIdByName.get(skillName);
          if (!skillId) return null;

          return {
            agent_id: agent.id,
            skill_id: skillId,
            office_id: officeId,
            is_enabled: true,
          };
        })
        .filter((assignment): assignment is NonNullable<typeof assignment> => Boolean(assignment));
    });

    if (skillAssignments.length > 0) {
      const { error: assignmentError } = await supabase.from("agent_skills").upsert(skillAssignments, {
        onConflict: "agent_id,skill_id",
      });

      if (assignmentError) {
        return NextResponse.json({ error: assignmentError.message }, { status: 500 });
      }
    }
  }

  const runtimeStates = roleAssignments.map(({ agent, metadata }) => ({
    agent_id: agent.id,
    office_id: officeId,
    status: "idle",
    current_action: String(metadata.action_description ?? metadata.action ?? "Агент ожидает задачу"),
    current_skill: null,
    current_target_x: Number(metadata.default_x ?? metadata.x ?? null),
    current_target_y: Number(metadata.default_y ?? metadata.y ?? null),
    metadata: { source: "team-template", templateId, ...metadata },
  }));

  if (runtimeStates.length > 0) {
    await supabase.from("agent_states").upsert(runtimeStates, { onConflict: "agent_id" });
  }

  return NextResponse.json(
    {
      success: true,
      templateId,
      templateName: template.name,
      createdAgents: roleAssignments.length,
      linkedRoles: roleAssignments.map(({ agent }) => agent.role),
    },
    { status: 200 }
  );
}
