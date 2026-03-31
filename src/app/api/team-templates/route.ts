import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { parseTeamTemplateRoles, type TeamTemplateRoleEntry } from "@/lib/teamTemplates";

interface TeamTemplateRow {
  id: string;
  name: string;
  description: string | null;
  roles_json: unknown;
  created_at?: string | null;
  updated_at?: string | null;
}

interface CreateTemplateBody {
  officeId?: string;
  name?: string;
  description?: string;
  rolesJson?: unknown;
}

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

const buildRolesFromOffice = async (officeId: string): Promise<TeamTemplateRoleEntry[]> => {
  const { data: agents, error: agentsError } = await supabase
    .from("agents")
    .select("id, name, role")
    .eq("office_id", officeId);

  if (agentsError) {
    throw new Error(agentsError.message);
  }

  const supportedAgents = (agents ?? []).filter(
    (agent): agent is { id: string; name: string | null; role: string } =>
      typeof agent?.id === "string" &&
      typeof agent?.role === "string" &&
      ["PM", "Developer", "QA", "DevOps"].includes(agent.role)
  );

  if (supportedAgents.length === 0) {
    return [];
  }

  const agentIds = supportedAgents.map((agent) => agent.id);
  const { data: agentSkills, error: agentSkillsError } = await supabase
    .from("agent_skills")
    .select("agent_id, skill_id")
    .in("agent_id", agentIds)
    .eq("is_enabled", true);

  if (agentSkillsError) {
    throw new Error(agentSkillsError.message);
  }

  const skillIds = Array.from(
    new Set(
      (agentSkills ?? [])
        .map((row) => (typeof row.skill_id === "string" ? row.skill_id : ""))
        .filter((value) => value.length > 0)
    )
  );

  const skillNameById = new Map<string, string>();
  if (skillIds.length > 0) {
    const { data: skillRows, error: skillRowsError } = await supabase
      .from("skills_catalog")
      .select("id, name")
      .in("id", skillIds);

    if (skillRowsError) {
      throw new Error(skillRowsError.message);
    }

    for (const skill of skillRows ?? []) {
      if (typeof skill.id === "string" && typeof skill.name === "string") {
        skillNameById.set(skill.id, skill.name);
      }
    }
  }

  const skillsByAgentId = new Map<string, string[]>();
  for (const row of agentSkills ?? []) {
    if (typeof row.agent_id !== "string" || typeof row.skill_id !== "string") continue;
    const skillName = skillNameById.get(row.skill_id);
    if (!skillName) continue;

    const current = skillsByAgentId.get(row.agent_id) ?? [];
    current.push(skillName);
    skillsByAgentId.set(row.agent_id, current);
  }

  return supportedAgents.map((agent) => ({
    roleKey: agent.role.toLowerCase(),
    displayName: agent.name?.trim() || agent.role,
    runtimeRole: agent.role as TeamTemplateRoleEntry["runtimeRole"],
    skills: Array.from(new Set(skillsByAgentId.get(agent.id) ?? [])),
  }));
};

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ templates: [] }, { status: 200 });
  }

  const { data, error } = await supabase
    .from("team_templates")
    .select("id, name, description, roles_json, created_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(24);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const templates = ((data ?? []) as TeamTemplateRow[]).map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    rolesJson: parseTeamTemplateRoles(template.roles_json),
    createdAt: template.created_at ?? null,
    updatedAt: template.updated_at ?? null,
  }));

  return NextResponse.json({ templates }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const body = (await req.json()) as CreateTemplateBody;
  const officeId = body.officeId?.trim() ?? "";
  const name = body.name?.trim() ?? "";
  const description = body.description?.trim() ?? "";

  if (!officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  if (!name) {
    return NextResponse.json({ error: "Template name is required" }, { status: 400 });
  }

  const rolesJson = parseTeamTemplateRoles(body.rolesJson);
  const normalizedRoles = rolesJson.length > 0 ? rolesJson : await buildRolesFromOffice(officeId);
  if (normalizedRoles.length === 0) {
    return NextResponse.json(
      { error: "Current office has no supported agents to save into a template" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("team_templates")
    .insert({
      name,
      description: description || null,
      roles_json: normalizedRoles,
      created_by: session.id,
    })
    .select("id, name, description, roles_json, created_at, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const template = data as TeamTemplateRow;
  return NextResponse.json(
    {
      template: {
        id: template.id,
        name: template.name,
        description: template.description,
        rolesJson: parseTeamTemplateRoles(template.roles_json),
        createdAt: template.created_at ?? null,
        updatedAt: template.updated_at ?? null,
      },
    },
    { status: 200 }
  );
}
