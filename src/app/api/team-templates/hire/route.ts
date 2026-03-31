import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import {
  collapseTemplateRolesByRuntimeRole,
  parseTeamTemplateRoles,
  type TeamTemplateRoleEntry,
} from "@/lib/teamTemplates";

interface HireTemplateBody {
  officeId?: string;
  templateId?: string;
}

interface AgentRow {
  id: string;
  role: string;
  name: string | null;
}

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

const DEFAULT_DESK_POSITIONS = [
  { x: 21, y: 47 },
  { x: 79, y: 47 },
  { x: 21, y: 81 },
  { x: 79, y: 81 },
  { x: 50, y: 47 },
  { x: 50, y: 81 },
  { x: 35, y: 64 },
  { x: 65, y: 64 },
];

const buildRoleMetadata = (roleEntry: TeamTemplateRoleEntry, index: number) => {
  const position = DEFAULT_DESK_POSITIONS[index % DEFAULT_DESK_POSITIONS.length];
  const existingMetadata = roleEntry.metadata ?? {};
  const roleKey = roleEntry.roleKey.toLowerCase();

  return {
    default_x:
      typeof existingMetadata.default_x === "number" ? existingMetadata.default_x : position.x,
    default_y:
      typeof existingMetadata.default_y === "number" ? existingMetadata.default_y : position.y,
    action_description:
      typeof existingMetadata.action_description === "string" && existingMetadata.action_description.trim().length > 0
        ? existingMetadata.action_description
        : `${roleEntry.displayName} handles ${roleEntry.runtimeRole} responsibilities inside the office workflow.`,
    is_coordinator:
      existingMetadata.is_coordinator === true ||
      roleKey.includes("ceo") ||
      roleKey.includes("pm") ||
      roleEntry.runtimeRole.toLowerCase() === "pm",
    ...existingMetadata,
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

  const roles = collapseTemplateRolesByRuntimeRole(parseTeamTemplateRoles(template.roles_json));
  if (roles.length === 0) {
    return NextResponse.json({ error: "Template has no runtime roles" }, { status: 400 });
  }

  const runtimeRoles = roles.map((role) => role.runtimeRole);
  const { data: existingAgents, error: existingAgentsError } = await supabase
    .from("agents")
    .select("id, role, name")
    .eq("office_id", officeId)
    .in("role", runtimeRoles);

  if (existingAgentsError) {
    return NextResponse.json({ error: existingAgentsError.message }, { status: 500 });
  }

  const agentByRole = new Map<string, AgentRow>();
  for (const agent of (existingAgents ?? []) as AgentRow[]) {
    if (!agentByRole.has(agent.role)) {
      agentByRole.set(agent.role, agent);
    }
  }

  const createdAgents: AgentRow[] = [];
  const linkedAgents: AgentRow[] = [];

  for (let index = 0; index < roles.length; index += 1) {
    const roleEntry = roles[index];
    const existingAgent = agentByRole.get(roleEntry.runtimeRole);
    if (existingAgent) {
      linkedAgents.push(existingAgent);
      continue;
    }

    const metadata = buildRoleMetadata(roleEntry, index);
    const { data: createdAgent, error: createAgentError } = await supabase
      .from("agents")
      .insert({
        office_id: officeId,
        name: roleEntry.displayName,
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

    const normalizedAgent = createdAgent as AgentRow;
    agentByRole.set(roleEntry.runtimeRole, normalizedAgent);
    createdAgents.push(normalizedAgent);
    linkedAgents.push(normalizedAgent);
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

    const skillAssignments = roles.flatMap((roleEntry) => {
      const agent = agentByRole.get(roleEntry.runtimeRole);
      if (!agent) return [];

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

  const runtimeStates = roles.flatMap((roleEntry, index) => {
    const agent = agentByRole.get(roleEntry.runtimeRole);
    if (!agent) return [];
    const metadata = buildRoleMetadata(roleEntry, index);

    return [
      {
        agent_id: agent.id,
        office_id: officeId,
        status: "idle",
        current_action: String(metadata.action_description ?? "Ready for a new workflow."),
        current_skill: null,
        current_target_x: Number(metadata.default_x ?? null),
        current_target_y: Number(metadata.default_y ?? null),
        metadata: { source: "team-template", templateId, ...metadata },
      },
    ];
  });

  if (runtimeStates.length > 0) {
    await supabase.from("agent_states").upsert(runtimeStates, { onConflict: "agent_id" });
  }

  return NextResponse.json(
    {
      success: true,
      templateId,
      templateName: template.name,
      createdAgents: createdAgents.length,
      linkedRoles: linkedAgents.map((agent) => agent.role),
    },
    { status: 200 }
  );
}
