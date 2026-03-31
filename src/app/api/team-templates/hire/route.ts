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
  role: TeamTemplateRoleEntry["runtimeRole"];
  name: string | null;
}

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

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
    return NextResponse.json({ error: "Template has no supported runtime roles" }, { status: 400 });
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

  const agentByRole = new Map<TeamTemplateRoleEntry["runtimeRole"], AgentRow>();
  for (const agent of (existingAgents ?? []) as AgentRow[]) {
    if (!agentByRole.has(agent.role)) {
      agentByRole.set(agent.role, agent);
    }
  }

  const createdAgents: AgentRow[] = [];
  const linkedAgents: AgentRow[] = [];

  for (const roleEntry of roles) {
    const existingAgent = agentByRole.get(roleEntry.runtimeRole);
    if (existingAgent) {
      linkedAgents.push(existingAgent);
      continue;
    }

    const { data: createdAgent, error: createAgentError } = await supabase
      .from("agents")
      .insert({
        office_id: officeId,
        name: roleEntry.displayName,
        role: roleEntry.runtimeRole,
        is_active: false,
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

  if (createdAgents.length > 0) {
    const runtimeStates = createdAgents.map((agent) => ({
      agent_id: agent.id,
      office_id: officeId,
      status: "idle",
      current_action: "Ready for a new workflow.",
      current_skill: null,
      current_target_x: null,
      current_target_y: null,
      metadata: { source: "team-template", templateId },
    }));

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
