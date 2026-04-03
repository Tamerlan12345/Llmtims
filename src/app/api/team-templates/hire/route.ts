import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import {
  parseTeamTemplateRoles,
  type TeamTemplateRoleEntry,
} from "@/lib/teamTemplates";
import {
  countFreeDesks,
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

interface SupabaseErrorLike {
  code?: string;
  message?: string;
}

const DB_ALLOWED_ROLES = ["PM", "Developer", "QA", "DevOps"] as const;
type DbAgentRole = (typeof DB_ALLOWED_ROLES)[number];
const DB_ROLE_ALIASES: Record<string, DbAgentRole> = {
  pm: "PM",
  "product manager": "PM",
  "product owner": "PM",
  manager: "PM",
  ceo: "PM",
  coordinator: "PM",
  developer: "Developer",
  dev: "Developer",
  engineer: "Developer",
  programmer: "Developer",
  "software developer": "Developer",
  "software engineer": "Developer",
  "frontend developer": "Developer",
  "backend developer": "Developer",
  "fullstack developer": "Developer",
  "full stack developer": "Developer",
  "web developer": "Developer",
  "mobile developer": "Developer",
  qa: "QA",
  tester: "QA",
  "test engineer": "QA",
  "quality assurance": "QA",
  "quality engineer": "QA",
  "qa engineer": "QA",
  devops: "DevOps",
  sre: "DevOps",
  ops: "DevOps",
  "platform engineer": "DevOps",
  "site reliability engineer": "DevOps",
  "release engineer": "DevOps",
};

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

const normalizeRoleKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");

const resolveDbAgentRole = (value: unknown): DbAgentRole | null => {
  if (typeof value !== "string") return null;
  const normalized = normalizeRoleKey(value);
  if (!normalized) return null;

  const direct = DB_ALLOWED_ROLES.find((role) => normalizeRoleKey(role) === normalized);
  if (direct) return direct;

  return DB_ROLE_ALIASES[normalized] ?? null;
};

const buildAgentTgNickname = (...parts: Array<string | null | undefined>): string => {
  const compact = parts
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter((item) => item.length > 0)
    .join("_");

  const normalized = compact
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  const suffix = Date.now().toString(36).slice(-6);
  return normalized ? `${normalized}_${suffix}`.slice(0, 63) : `agent_${suffix}`;
};

const isMissingTgNicknameColumnError = (message?: string): boolean => {
  const normalized = String(message ?? "").toLowerCase();
  return normalized.includes('column "tg_nickname"') && normalized.includes("does not exist");
};

const isMissingSystemPromptColumnError = (message?: string): boolean => {
  const normalized = String(message ?? "").toLowerCase();
  return normalized.includes('column "system_prompt"') && normalized.includes("does not exist");
};

const isMissingSkillsColumnError = (message?: string): boolean => {
  const normalized = String(message ?? "").toLowerCase();
  return normalized.includes('column "skills"') && normalized.includes("does not exist");
};

const isAgentsRoleConstraintError = (error?: SupabaseErrorLike | null): boolean => {
  const code = String(error?.code ?? "").trim();
  const message = String(error?.message ?? "").toLowerCase();
  return code === "23514" && message.includes("agents_role_check");
};

const buildAgentSystemPrompt = (
  runtimeRole: string,
  displayName: string | null | undefined,
  roleMarkdown: string | null | undefined
): string => {
  const normalizedRoleMarkdown = typeof roleMarkdown === "string" ? roleMarkdown.trim() : "";
  if (normalizedRoleMarkdown.length > 0) {
    return normalizedRoleMarkdown;
  }

  const normalizedDisplayName =
    typeof displayName === "string" && displayName.trim().length > 0
      ? displayName.trim()
      : runtimeRole;
  return [
    `You are ${normalizedDisplayName}.`,
    `Your role is ${runtimeRole} in Digital Pixel Office.`,
    "Execute responsibilities for your role and provide concise status-oriented responses.",
  ].join(" ");
};

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
  const remainingDeskCount = countFreeDesks(occupiedDesks);
  if (roles.length > remainingDeskCount) {
    return NextResponse.json(
      {
        error: "В офисе нет свободных рабочих мест",
        details: {
          available: remainingDeskCount,
          requested: roles.length,
        },
      },
      { status: 409 }
    );
  }

  const roleAssignments: RoleAssignment[] = [];
  const createdAgentIds: string[] = [];
  const rollbackCreatedAgents = async () => {
    if (createdAgentIds.length === 0) return;

    try {
      await supabase.from("agents").delete().in("id", createdAgentIds);
    } catch (rollbackError) {
      console.error("[team-template-hire] rollback failed:", rollbackError);
    }
  };

  for (const roleEntry of roles) {
    const dbRole = resolveDbAgentRole(roleEntry.runtimeRole);
    const normalizedTemplateRole =
      typeof roleEntry.runtimeRole === "string" ? roleEntry.runtimeRole.trim().slice(0, 120) : "";
    const persistedRole = dbRole ?? normalizedTemplateRole;
    if (!persistedRole) {
      await rollbackCreatedAgents();
      return NextResponse.json({ error: "Template role is empty" }, { status: 400 });
    }

    const desk = pickFirstFreeDesk(occupiedDesks);
    if (!desk) {
      await rollbackCreatedAgents();
      return NextResponse.json({ error: "В офисе нет свободных рабочих мест" }, { status: 409 });
    }
    occupiedDesks.add(deskKey(desk));

    const metadata = buildRoleMetadata(roleEntry, desk);
    const roleSkillNames = Array.from(
      new Set(
        (Array.isArray(roleEntry.skills) ? roleEntry.skills : [])
          .map((skillName) => (typeof skillName === "string" ? skillName.trim() : ""))
          .filter((skillName) => skillName.length > 0)
      )
    );
    const baseAgentPayload = {
      office_id: officeId,
      name: roleEntry.displayName?.trim() || persistedRole,
      role: persistedRole,
      is_active: false,
      metadata,
      role_md: roleEntry.roleMarkdown ?? null,
      system_prompt: buildAgentSystemPrompt(
        persistedRole,
        roleEntry.displayName ?? null,
        roleEntry.roleMarkdown ?? null
      ),
      tg_nickname: buildAgentTgNickname(roleEntry.displayName ?? null, persistedRole),
      skills: roleSkillNames,
    };

    let { data: createdAgent, error: createAgentError } = await supabase
      .from("agents")
      .insert(baseAgentPayload)
      .select("id, role, name")
      .single();

    if (
      createAgentError &&
      (isMissingTgNicknameColumnError(createAgentError.message) ||
        isMissingSystemPromptColumnError(createAgentError.message) ||
        isMissingSkillsColumnError(createAgentError.message))
    ) {
      const fallbackPayload = { ...baseAgentPayload } as Record<string, unknown>;
      if (isMissingTgNicknameColumnError(createAgentError.message)) {
        delete fallbackPayload.tg_nickname;
      }
      if (isMissingSystemPromptColumnError(createAgentError.message)) {
        delete fallbackPayload.system_prompt;
      }
      if (isMissingSkillsColumnError(createAgentError.message)) {
        delete fallbackPayload.skills;
      }

      const fallbackResponse = await supabase
        .from("agents")
        .insert(fallbackPayload)
        .select("id, role, name")
        .single();

      createdAgent = fallbackResponse.data;
      createAgentError = fallbackResponse.error;
    }

    if (createAgentError || !createdAgent?.id) {
      if (isAgentsRoleConstraintError(createAgentError as SupabaseErrorLike)) {
        await rollbackCreatedAgents();
        return NextResponse.json(
          {
            error: "agents_role_check_violation",
            detail:
              "БД всё ещё использует старый agents_role_check. Примените scripts/sql/cic_agents_role_constraint_relax.sql.",
          },
          { status: 400 }
        );
      }

      await rollbackCreatedAgents();
      return NextResponse.json(
        { error: createAgentError?.message ?? `Failed to hire ${roleEntry.runtimeRole}` },
        { status: 500 }
      );
    }

    createdAgentIds.push(createdAgent.id);
    roleAssignments.push({
      roleEntry,
      agent: createdAgent as AgentRow,
      metadata,
      desk,
    });
  }

  const skillNames = Array.from(
    new Set(
      roles
        .flatMap((role) => (Array.isArray(role.skills) ? role.skills : []))
        .map((skillName) => (typeof skillName === "string" ? skillName.trim() : ""))
        .filter((skillName) => skillName.length > 0)
    )
  );
  if (skillNames.length > 0) {
    const { data: skills, error: skillsError } = await supabase
      .from("skills_catalog")
      .select("id, name")
      .in("name", skillNames);

    if (skillsError) {
      await rollbackCreatedAgents();
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
        await rollbackCreatedAgents();
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
    const { error: runtimeStateError } = await supabase
      .from("agent_states")
      .upsert(runtimeStates, { onConflict: "agent_id" });
    if (runtimeStateError) {
      await rollbackCreatedAgents();
      return NextResponse.json({ error: runtimeStateError.message }, { status: 500 });
    }
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

