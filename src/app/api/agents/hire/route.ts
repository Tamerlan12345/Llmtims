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
  roleName: string,
  displayName: string,
  roleMarkdown: string
): string => {
  const normalizedRoleMarkdown = normalizeText(roleMarkdown, 12000);
  if (normalizedRoleMarkdown) {
    return normalizedRoleMarkdown;
  }

  const normalizedDisplayName = normalizeText(displayName, 120) || roleName;
  return [
    `You are ${normalizedDisplayName}.`,
    `Your functional role is ${roleName} in Digital Pixel Office.`,
    "Provide concise, actionable responses and stay within your role responsibilities.",
  ].join(" ");
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
  const dbRole = resolveDbAgentRole(roleName);
  const persistedRole = dbRole ?? roleName;
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
  const metadata = buildAgentMetadata(persistedRole, desk, body.metadata);

  const baseAgentPayload = {
    office_id: officeId,
    role: persistedRole,
    name: displayName,
    role_md: roleMarkdown || null,
    system_prompt: buildAgentSystemPrompt(persistedRole, displayName, roleMarkdown),
    is_active: false,
    metadata,
    tg_nickname: buildAgentTgNickname(displayName, persistedRole),
    skills: skillNames,
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

  let assignedSkillNames = [...skillNames];
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
    assignedSkillNames = Array.from(
      new Set(
        skillRecords
          .map((skill) => skill.name)
          .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      )
    );
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

  if (skillNames.length > 0 || assignedSkillNames.length > 0) {
    const { error: syncSkillsError } = await supabase
      .from("agents")
      .update({
        skills: assignedSkillNames,
        updated_at: new Date().toISOString(),
      })
      .eq("id", createdAgent.id)
      .eq("office_id", officeId);

    if (syncSkillsError && !isMissingSkillsColumnError(syncSkillsError.message)) {
      console.error("[agents.hire] failed to sync agents.skills:", syncSkillsError.message);
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
