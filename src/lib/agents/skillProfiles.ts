import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

export type AgentRole = string;

export interface SkillDefinition {
  skillName: string;
  displayName: string;
  summary: string;
  usageNotes: string;
  sourcePath: string;
  skillMarkdown: string;
  instructionMarkdown: string;
  runtime?: string;
  endpoint?: string | null;
  parameterSchema?: Record<string, unknown>;
  isVerified?: boolean;
  metadata?: Record<string, unknown>;
}

export interface OfficeAgentProfile {
  id: string;
  role: string;
  name: string;
  roleMarkdown: string;
  actionDescription: string;
  defaultX: number | null;
  defaultY: number | null;
  metadata: Record<string, unknown>;
  skills: string[];
}

export interface RoleSkillContext {
  roleSkills: Record<string, string[]>;
  skillCatalog: Record<string, SkillDefinition>;
  agentProfiles: Record<string, OfficeAgentProfile>;
  availableRoles: string[];
  coordinatorRole: string | null;
}

const DEFAULT_ROLE_ORDER = ["PM", "Developer", "QA", "DevOps"];

const DEFAULT_ROLE_SKILLS: Record<string, string[]> = {
  PM: ["agile-product-owner", "plan_gsd_project", "brainstorming", "ui-ux-pro-max", "gemini", "pptx"],
  Developer: [
    "architecture-patterns",
    "frontend-design",
    "ui-ux-pro-max",
    "supabase-postgres-best-practices",
    "brainstorming",
    "gemini",
  ],
  QA: ["audit-website", "supabase-postgres-best-practices", "brainstorming", "gemini"],
  DevOps: ["architecture-patterns", "supabase-postgres-best-practices", "audit-website", "gemini"],
};

const DEFAULT_ROLE_MARKDOWN: Record<string, string> = {
  PM: [
    "# Role: PM / CEO",
    "## Mission",
    "Take user requests, structure the work, and coordinate the office workflow.",
    "## Rules",
    "1. Keep scope clear and choose the next best assignee explicitly.",
    "2. Do not fabricate execution results that were not actually produced.",
    "3. When the request is ambiguous, ask only the minimum blocking clarification.",
    "4. If the task is complex, call plan_gsd_project first, then delegate_task for the first specialist.",
    "5. You plan and coordinate, but do not perform specialist execution yourself.",
    "## Output",
    "- Short decision",
    "- Why this role is next",
    "- Expected artifact",
  ].join("\n"),
  Developer: [
    "# Role: Developer",
    "## Mission",
    "Produce implementation plans, code artifacts, and technical drafts.",
    "## Rules",
    "1. Prefer concrete implementation details over generic advice.",
    "2. Surface blockers and assumptions explicitly.",
    "3. Return structured artifacts that the next role can inspect.",
  ].join("\n"),
  QA: [
    "# Role: QA / Reviewer",
    "## Mission",
    "Validate quality, find defects, and either approve or reject work.",
    "## Rules",
    "1. If issues exist, clearly mark them as rejection criteria.",
    "2. Point rejected work back to the responsible role.",
    "3. Keep checks evidence-based and artifact-driven.",
  ].join("\n"),
  DevOps: [
    "# Role: DevOps / Release",
    "## Mission",
    "Prepare delivery, deployment, monitoring, and release completion notes.",
    "## Rules",
    "1. Never claim deployment success without explicit evidence.",
    "2. Keep release artifacts concise and operationally useful.",
    "3. Surface environment blockers immediately.",
  ].join("\n"),
};

export const DEFAULT_SKILL_CATALOG: Record<string, SkillDefinition> = {
  "agile-product-owner": {
    skillName: "agile-product-owner",
    displayName: "Agile Product Owner",
    summary:
      "INVEST user stories, acceptance criteria, sprint planning, backlog prioritization, and stakeholder communication.",
    usageNotes:
      "Use for decomposition, prioritization, milestones, and readiness before execution.",
    sourcePath: ".agents/skills/agile-product-owner/SKILL.md",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  plan_gsd_project: {
    skillName: "plan_gsd_project",
    displayName: "GSD Project Planner",
    summary: "Breaks a complex project into role-based actionable steps using the GSD workflow.",
    usageNotes:
      "Use before delegation when PM needs a roadmap across the actual roles present in the office.",
    sourcePath: "scripts/sql/cic_seed_advanced_skills.sql",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  "architecture-patterns": {
    skillName: "architecture-patterns",
    displayName: "Architecture Patterns",
    summary:
      "Clean/Hexagonal/DDD architecture guidelines for maintainable backend systems and refactoring.",
    usageNotes:
      "Use for designing modules, boundaries, dependency flow, and integration contracts.",
    sourcePath: ".agents/skills/architecture-patterns/SKILL.md",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  "audit-website": {
    skillName: "audit-website",
    displayName: "Website Audit",
    summary: "SEO, performance, security, and technical audits with actionable issue reports.",
    usageNotes: "Use for QA diagnostics, post-deploy checks, and health baseline reporting.",
    sourcePath: ".agents/skills/audit-website/SKILL.md",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  brainstorming: {
    skillName: "brainstorming",
    displayName: "Brainstorming",
    summary: "Structured discovery flow for clarifying requirements and comparing options before implementation.",
    usageNotes:
      "Use before creative work: clarify goals, constraints, options, and acceptance criteria.",
    sourcePath: ".agents/skills/brainstorming/SKILL.md",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  "canvas-design": {
    skillName: "canvas-design",
    displayName: "Canvas Design",
    summary: "Visual philosophy creation and static design artifact generation in PNG/PDF.",
    usageNotes: "Use for brand visuals, posters, and static compositions where coding UI is not required.",
    sourcePath: ".agents/skills/canvas-design/SKILL.md",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  "frontend-design": {
    skillName: "frontend-design",
    displayName: "Frontend Design",
    summary: "Production-grade, distinctive frontend interfaces with strong visual direction.",
    usageNotes:
      "Use for implementing UI pages/components while preserving functionality and responsiveness.",
    sourcePath: ".agents/skills/frontend-design/SKILL.md",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  gemini: {
    skillName: "gemini",
    displayName: "Gemini CLI",
    summary: "Large-context analysis and deep code/plan review workflows.",
    usageNotes: "Use when broad repository context or heavyweight review is needed.",
    sourcePath: ".agents/skills/gemini/SKILL.md",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  pptx: {
    skillName: "pptx",
    displayName: "PPTX",
    summary: "Read, edit, and generate .pptx presentations with structured tooling.",
    usageNotes: "Use for any slide/deck workflow (parse, modify, create, merge, update).",
    sourcePath: ".agents/skills/pptx/SKILL.md",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  "supabase-postgres-best-practices": {
    skillName: "supabase-postgres-best-practices",
    displayName: "Supabase Postgres Best Practices",
    summary: "Postgres performance and schema/query optimization guidance from Supabase.",
    usageNotes: "Use for SQL design, indexing, RLS, query plans, and DB performance tuning.",
    sourcePath: ".agents/skills/supabase-postgres-best-practices/SKILL.md",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  "ui-ux-pro-max": {
    skillName: "ui-ux-pro-max",
    displayName: "UI/UX Pro Max",
    summary: "Design intelligence for accessibility, typography, color, layout, and interaction quality.",
    usageNotes:
      "Use for improving usability, visual hierarchy, accessibility, and component ergonomics.",
    sourcePath: ".agents/skills/ui-ux-pro-max/SKILL.md",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
  instagram_publisher: {
    skillName: "instagram_publisher",
    displayName: "Instagram Publisher",
    summary: "Publishes a prepared image and caption to Instagram via the Meta Graph API.",
    usageNotes:
      "Use after content and image generation when a social media specialist needs to publish a final post.",
    sourcePath: "scripts/sql/cic_seed_advanced_skills.sql",
    skillMarkdown: "",
    instructionMarkdown: "",
  },
};

const normalizeSkillName = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, "-");

const normalizeSkillList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = normalizeSkillName(item);
    if (!normalized) continue;
    unique.add(normalized);
  }

  return Array.from(unique);
};

const cloneSkillCatalog = (value: Record<string, SkillDefinition>): Record<string, SkillDefinition> => {
  const next: Record<string, SkillDefinition> = {};
  for (const entry of Object.values(value)) {
    next[entry.skillName] = { ...entry };
  }
  return next;
};

const cloneRoleSkillMap = (value: Record<string, string[]>): Record<string, string[]> => {
  const next: Record<string, string[]> = {};
  for (const [role, skills] of Object.entries(value)) {
    next[role] = [...skills];
  }
  return next;
};

const toMetadataObject = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const toOptionalNumber = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const resolveAgentActionDescription = (
  role: string,
  metadata: Record<string, unknown>,
  roleMarkdown: string
): string => {
  const fromMetadata =
    typeof metadata.action_description === "string"
      ? metadata.action_description
      : typeof metadata.actionDescription === "string"
        ? metadata.actionDescription
        : "";
  const normalized = fromMetadata.trim();
  if (normalized) return normalized;

  const firstLine = roleMarkdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (firstLine) return firstLine;

  return `${role} processes the current office task and produces the next artifact.`;
};

const resolveDefaultRoleMarkdown = (role: string): string => {
  return (
    DEFAULT_ROLE_MARKDOWN[role] ??
    [
      `# Role: ${role}`,
      "## Mission",
      `Own the ${role} responsibilities for the current office workflow.`,
      "## Rules",
      "1. Stay inside your role scope.",
      "2. Produce an artifact the next role can directly use.",
      "3. Escalate blockers instead of inventing missing facts.",
    ].join("\n")
  );
};

const normalizeBaseSkillDefinition = (
  row: Record<string, unknown>,
  fallback?: SkillDefinition
): SkillDefinition | null => {
  const skillName = normalizeSkillName(String(row.skill_name ?? row.name ?? ""));
  if (!skillName) return null;

  const displayName = String(row.display_name ?? row.name ?? fallback?.displayName ?? skillName).trim() || skillName;
  const summary = String(row.summary ?? row.description ?? fallback?.summary ?? "").trim();
  const usageNotes = String(row.usage_notes ?? fallback?.usageNotes ?? "").trim();
  const sourcePath = String(row.source_path ?? row.implementation_ref ?? fallback?.sourcePath ?? "").trim();
  const skillMarkdown = String(row.skill_markdown ?? fallback?.skillMarkdown ?? "").trim();
  const instructionMarkdown = String(
    row.instruction_md ?? row.skill_markdown ?? fallback?.instructionMarkdown ?? skillMarkdown
  ).trim();

  return {
    skillName,
    displayName,
    summary: summary || "Skill guidance is available in the markdown instruction.",
    usageNotes: usageNotes || "Use this skill when it directly advances the assigned task.",
    sourcePath,
    skillMarkdown,
    instructionMarkdown,
    runtime: typeof row.runtime === "string" ? row.runtime : fallback?.runtime,
    endpoint: typeof row.endpoint === "string" ? row.endpoint : fallback?.endpoint ?? null,
    parameterSchema:
      row.parameter_schema && typeof row.parameter_schema === "object"
        ? (row.parameter_schema as Record<string, unknown>)
        : fallback?.parameterSchema,
    isVerified: typeof row.is_verified === "boolean" ? row.is_verified : fallback?.isVerified,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : fallback?.metadata,
  };
};

const mergeSkillNames = (current: string[], incoming: string[]) => {
  return Array.from(new Set([...current, ...incoming]));
};

export const resolveCoordinatorRole = (
  profiles: Record<string, OfficeAgentProfile>,
  availableRoles: string[]
): string | null => {
  const orderedProfiles = availableRoles.map((role) => profiles[role]).filter(Boolean);

  const explicit = orderedProfiles.find((profile) => {
    const metadata = profile.metadata ?? {};
    return metadata.is_coordinator === true || metadata.isCoordinator === true;
  });
  if (explicit) return explicit.role;

  const heuristic = orderedProfiles.find((profile) => {
    const haystack = `${profile.role} ${profile.name} ${profile.roleMarkdown}`.toLowerCase();
    return (
      haystack.includes("ceo") ||
      haystack.includes("pm") ||
      haystack.includes("manager") ||
      haystack.includes("главн") ||
      haystack.includes("эксперт") ||
      haystack.includes("expert") ||
      haystack.includes("lead")
    );
  });
  if (heuristic) return heuristic.role;

  return availableRoles[0] ?? null;
};

export const loadRoleSkillContextFromDb = async (officeId?: string | null): Promise<RoleSkillContext> => {
  const roleSkills = cloneRoleSkillMap(DEFAULT_ROLE_SKILLS);
  const skillCatalog = cloneSkillCatalog(DEFAULT_SKILL_CATALOG);
  const agentProfiles: Record<string, OfficeAgentProfile> = {};

  if (!isServerSupabaseConfigured) {
    const availableRoles = Object.keys(roleSkills);
    for (const role of availableRoles) {
      agentProfiles[role] = {
        id: `mock-${role.toLowerCase()}`,
        role,
        name: role,
        roleMarkdown: resolveDefaultRoleMarkdown(role),
        actionDescription: `${role} processes the current task.`,
        defaultX: null,
        defaultY: null,
        metadata: {},
        skills: [...(roleSkills[role] ?? [])],
      };
    }

    return {
      roleSkills,
      skillCatalog,
      agentProfiles,
      availableRoles,
      coordinatorRole: resolveCoordinatorRole(agentProfiles, availableRoles),
    };
  }

  try {
    let agentQuery = supabase
      .from("agents")
      .select("id, role, name, skills, metadata, role_md")
      .order("created_at", { ascending: true });
    if (officeId) {
      agentQuery = agentQuery.eq("office_id", officeId);
    }

    const { data: agents } = await agentQuery;
    const roleByAgentId = new Map<string, string>();

    for (const row of agents ?? []) {
      const role = String(row.role ?? "").trim();
      const id = typeof row.id === "string" ? row.id : "";
      if (!role || !id) continue;

      const metadata = toMetadataObject(row.metadata);
      const baseSkills = normalizeSkillList(row.skills);
      roleSkills[role] = mergeSkillNames(roleSkills[role] ?? [], baseSkills);
      roleByAgentId.set(id, role);

      const roleMarkdown = String(row.role_md ?? "").trim() || resolveDefaultRoleMarkdown(role);
      agentProfiles[role] = {
        id,
        role,
        name: String(row.name ?? role).trim() || role,
        roleMarkdown,
        actionDescription: resolveAgentActionDescription(role, metadata, roleMarkdown),
        defaultX: toOptionalNumber(metadata.default_x ?? metadata.defaultX),
        defaultY: toOptionalNumber(metadata.default_y ?? metadata.defaultY),
        metadata,
        skills: roleSkills[role] ?? [],
      };
    }

    const agentIds = Array.from(roleByAgentId.keys());
    if (agentIds.length > 0) {
      const { data: installedSkills } = await supabase
        .from("agent_skills")
        .select("agent_id, skill_id")
        .in("agent_id", agentIds)
        .eq("is_enabled", true);

      const skillIds = Array.from(
        new Set(
          (installedSkills ?? [])
            .map((row) => (typeof row.skill_id === "string" ? row.skill_id : ""))
            .filter((value) => value.length > 0)
        )
      );

      if (skillIds.length > 0) {
        const { data: marketplaceSkills } = await supabase
          .from("skills_catalog")
          .select("id, name, description, parameter_schema, runtime, endpoint, implementation_ref, is_verified, metadata, instruction_md")
          .in("id", skillIds)
          .eq("is_active", true);

        const skillNameById = new Map<string, string>();
        for (const row of marketplaceSkills ?? []) {
          const fallback = DEFAULT_SKILL_CATALOG[normalizeSkillName(String(row.name ?? ""))];
          const normalized = normalizeBaseSkillDefinition(row as Record<string, unknown>, fallback);
          if (!normalized) continue;
          skillCatalog[normalized.skillName] = normalized;
          if (typeof row.id === "string") {
            skillNameById.set(row.id, normalized.skillName);
          }
        }

        for (const row of installedSkills ?? []) {
          const agentId = typeof row.agent_id === "string" ? row.agent_id : "";
          const skillId = typeof row.skill_id === "string" ? row.skill_id : "";
          const role = roleByAgentId.get(agentId);
          const skillName = skillNameById.get(skillId);
          if (!role || !skillName) continue;
          roleSkills[role] = mergeSkillNames(roleSkills[role] ?? [], [skillName]);
        }
      }
    }

    const { data: profileSkills } = await supabase
      .from("agent_skill_catalog")
      .select("skill_name, display_name, summary, usage_notes, source_path, skill_markdown, runtime, endpoint, parameter_schema, is_verified, metadata");

    for (const row of profileSkills ?? []) {
      const fallback = DEFAULT_SKILL_CATALOG[normalizeSkillName(String(row.skill_name ?? ""))];
      const normalized = normalizeBaseSkillDefinition(row as Record<string, unknown>, fallback);
      if (!normalized) continue;

      const current = skillCatalog[normalized.skillName];
      skillCatalog[normalized.skillName] = {
        ...(current ?? normalized),
        ...normalized,
        instructionMarkdown:
          normalized.instructionMarkdown ||
          current?.instructionMarkdown ||
          normalized.skillMarkdown ||
          current?.skillMarkdown ||
          "",
      };
    }

    for (const [role, profile] of Object.entries(agentProfiles)) {
      profile.skills = roleSkills[role] ?? [];
    }
  } catch {
    const availableRoles = Object.keys(roleSkills);
    return {
      roleSkills,
      skillCatalog,
      agentProfiles,
      availableRoles,
      coordinatorRole: resolveCoordinatorRole(agentProfiles, availableRoles),
    };
  }

  const availableRoles = Array.from(
    new Set([
      ...Object.keys(agentProfiles),
      ...Object.keys(roleSkills).filter((role) => (roleSkills[role] ?? []).length > 0),
    ])
  );

  return {
    roleSkills,
    skillCatalog,
    agentProfiles,
    availableRoles,
    coordinatorRole: resolveCoordinatorRole(agentProfiles, availableRoles),
  };
};

const buildSkillInstructionBlock = (skillName: string, catalog: Record<string, SkillDefinition>) => {
  const skill = catalog[skillName];
  if (!skill) return `## Skill: ${skillName}\nNo extra markdown instruction was found.`;

  const markdown = skill.instructionMarkdown.trim() || skill.skillMarkdown.trim();
  return [
    `## Skill: ${skill.displayName}`,
    `- key: ${skill.skillName}`,
    skill.summary ? `- summary: ${skill.summary}` : null,
    skill.usageNotes ? `- usage: ${skill.usageNotes}` : null,
    markdown ? `### Instruction\n${markdown}` : null,
  ]
    .filter(Boolean)
    .join("\n");
};

export const buildRoleSkillsPromptBlock = (
  role: AgentRole,
  roleSkills: Record<string, string[]>,
  skillCatalog: Record<string, SkillDefinition> = DEFAULT_SKILL_CATALOG,
  agentProfile?: OfficeAgentProfile | null
): string => {
  const ownSkills = roleSkills[role] ?? [];
  const roleMarkdown = agentProfile?.roleMarkdown?.trim() || resolveDefaultRoleMarkdown(role);
  const actionDescription =
    agentProfile?.actionDescription?.trim() || `${role} produces the next useful artifact for the workflow.`;

  const skillBlocks =
    ownSkills.length > 0
      ? ownSkills.map((skillName) => buildSkillInstructionBlock(skillName, skillCatalog)).join("\n\n")
      : "No explicit skills are attached to this role for the current office.";

  return [
    "=== ROLE PROFILE ===",
    roleMarkdown,
    "",
    "=== ROLE ACTION ===",
    actionDescription,
    "",
    "=== INSTALLED SKILLS ===",
    skillBlocks,
    "",
    "=== EXECUTION RULES ===",
    "1. Stay inside your role scope.",
    "2. Use installed skill instructions exactly when planning tool calls.",
    "3. If data is missing, state the blocker instead of inventing output.",
    "4. Produce artifacts that the next role or human reviewer can inspect.",
  ].join("\n");
};

export const buildTeamSkillsPromptBlock = (roleSkills: Record<string, string[]>): string => {
  const segments = Object.entries(roleSkills).map(([role, skills]) => {
    const text = skills.length > 0 ? skills.join(", ") : "base-profile";
    return `${role}: [${text}]`;
  });

  return `Team skill matrix: ${segments.join("; ")}.`;
};
