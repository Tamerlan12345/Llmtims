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

interface SkillRow {
  id: string;
  name: string;
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

const buildAgentSystemPrompt = (name: string, roleName: string): string => {
  const normalizedName = String(name ?? "").trim() || "Agent";
  const normalizedRole = String(roleName ?? "").trim() || "Specialist";
  return [
    `You are ${normalizedName}.`,
    `Your role is ${normalizedRole} in Digital Pixel Office.`,
    "Work accurately, communicate clearly, and focus on task execution for your role.",
  ].join(" ");
};

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
  const officeId = typeof body.officeId === "string" ? body.officeId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  const profession = typeof body.profession === "string" ? body.profession.trim().slice(0, 120) : "";
  const avatarIndex =
    typeof body.avatarIndex === "number" && Number.isFinite(body.avatarIndex) ? body.avatarIndex : 0;
  const requestedSkillIds = Array.from(
    new Set(
      (Array.isArray(body.skills) ? body.skills : [])
        .map((skillId) => (typeof skillId === "string" ? skillId.trim() : ""))
        .filter((skillId) => skillId.length > 0)
    )
  );
  const saveAsPreset = body.saveAsPreset === true;
  const dbRole = resolveDbAgentRole(profession);
  const persistedRole = dbRole ?? profession;

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

  const metadata = buildAgentMetadata(persistedRole, desk, avatarIndex);
  let resolvedSkills: SkillRow[] = [];
  if (requestedSkillIds.length > 0) {
    const { data: skillRows, error: skillRowsError } = await supabase
      .from("skills_catalog")
      .select("id, name")
      .in("id", requestedSkillIds)
      .eq("is_active", true);

    if (skillRowsError) {
      return NextResponse.json({ error: skillRowsError.message }, { status: 500 });
    }

    resolvedSkills = (skillRows ?? []).filter(
      (row): row is SkillRow => typeof row.id === "string" && typeof row.name === "string"
    );
  }
  const resolvedSkillNames = Array.from(new Set(resolvedSkills.map((skill) => skill.name)));

  const baseAgentPayload = {
    office_id: officeId,
    role: persistedRole,
    name,
    system_prompt: buildAgentSystemPrompt(name, persistedRole),
    is_active: false,
    metadata,
    tg_nickname: buildAgentTgNickname(name, persistedRole),
    skills: resolvedSkillNames,
  };

  let { data: createdAgent, error: createdAgentError } = await supabase
    .from("agents")
    .insert(baseAgentPayload)
    .select("id, role, name")
    .single();

  if (
    createdAgentError &&
    (isMissingTgNicknameColumnError(createdAgentError.message) ||
      isMissingSystemPromptColumnError(createdAgentError.message) ||
      isMissingSkillsColumnError(createdAgentError.message))
  ) {
    const fallbackPayload = { ...baseAgentPayload } as Record<string, unknown>;
    if (isMissingTgNicknameColumnError(createdAgentError.message)) {
      delete fallbackPayload.tg_nickname;
    }
    if (isMissingSystemPromptColumnError(createdAgentError.message)) {
      delete fallbackPayload.system_prompt;
    }
    if (isMissingSkillsColumnError(createdAgentError.message)) {
      delete fallbackPayload.skills;
    }

    const fallbackResponse = await supabase
      .from("agents")
      .insert(fallbackPayload)
      .select("id, role, name")
      .single();

    createdAgent = fallbackResponse.data;
    createdAgentError = fallbackResponse.error;
  }

  if (createdAgentError || !createdAgent?.id) {
    if (isAgentsRoleConstraintError(createdAgentError as SupabaseErrorLike)) {
      return NextResponse.json(
        {
          error: "agents_role_check_violation",
          detail:
            "БД все еще использует старый agents_role_check. Примените scripts/sql/cic_agents_role_constraint_relax.sql.",
        },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: createdAgentError?.message ?? "agent_create_failed" },
      { status: 500 }
    );
  }

  if (resolvedSkills.length > 0) {
    const assignments = resolvedSkills.map((skill) => ({
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

  if (resolvedSkillNames.length > 0) {
    const { error: syncSkillsError } = await supabase
      .from("agents")
      .update({
        skills: resolvedSkillNames,
        updated_at: new Date().toISOString(),
      })
      .eq("id", createdAgent.id)
      .eq("office_id", officeId);

    if (syncSkillsError && !isMissingSkillsColumnError(syncSkillsError.message)) {
      console.error("[agents.hire-custom] failed to sync agents.skills:", syncSkillsError.message);
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

    await supabase.from("team_templates").insert({
      name: `Специалист ${persistedRole}: ${name}`,
      description: `Пользовательский шаблон сотрудника с навыками: ${resolvedSkillNames.join(", ")}`,
      roles_json: [
        {
          roleKey: persistedRole.toLowerCase().replace(/\s+/g, "_"),
          displayName: name,
          runtimeRole: persistedRole,
          skills: resolvedSkillNames,
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

