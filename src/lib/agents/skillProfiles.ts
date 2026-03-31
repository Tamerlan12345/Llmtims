import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

export type AgentRole = "PM" | "Developer" | "QA" | "DevOps";
export interface SkillDefinition {
  skillName: string;
  displayName: string;
  summary: string;
  usageNotes: string;
  sourcePath: string;
  skillMarkdown: string;
  runtime?: string;
  endpoint?: string | null;
  parameterSchema?: Record<string, unknown>;
  isVerified?: boolean;
  metadata?: Record<string, unknown>;
}
export interface RoleSkillContext {
  roleSkills: Record<AgentRole, string[]>;
  skillCatalog: Record<string, SkillDefinition>;
}

const ROLE_ORDER: AgentRole[] = ["PM", "Developer", "QA", "DevOps"];

const cloneSkillMap = (value: Record<AgentRole, string[]>): Record<AgentRole, string[]> => {
  return {
    PM: [...value.PM],
    Developer: [...value.Developer],
    QA: [...value.QA],
    DevOps: [...value.DevOps],
  };
};

const cloneSkillCatalog = (
  value: Record<string, SkillDefinition>
): Record<string, SkillDefinition> => {
  const next: Record<string, SkillDefinition> = {};
  for (const entry of Object.values(value)) {
    next[entry.skillName] = { ...entry };
  }
  return next;
};

export const DEFAULT_ROLE_SKILLS: Record<AgentRole, string[]> = {
  PM: [
    "agile-product-owner",
    "brainstorming",
    "ui-ux-pro-max",
    "gemini",
    "pptx",
  ],
  Developer: [
    "architecture-patterns",
    "frontend-design",
    "ui-ux-pro-max",
    "supabase-postgres-best-practices",
    "brainstorming",
    "gemini",
  ],
  QA: [
    "audit-website",
    "supabase-postgres-best-practices",
    "brainstorming",
    "gemini",
  ],
  DevOps: [
    "architecture-patterns",
    "supabase-postgres-best-practices",
    "audit-website",
    "gemini",
  ],
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
  },
  "audit-website": {
    skillName: "audit-website",
    displayName: "Website Audit",
    summary:
      "SEO, performance, security, and technical audits with actionable issue reports.",
    usageNotes:
      "Use for QA diagnostics, post-deploy checks, and health baseline reporting.",
    sourcePath: ".agents/skills/audit-website/SKILL.md",
    skillMarkdown: "",
  },
  brainstorming: {
    skillName: "brainstorming",
    displayName: "Brainstorming",
    summary:
      "Structured discovery flow for clarifying requirements and comparing options before implementation.",
    usageNotes:
      "Use before creative/feature work: clarify goals, constraints, options, and acceptance criteria.",
    sourcePath: ".agents/skills/brainstorming/SKILL.md",
    skillMarkdown: "",
  },
  "canvas-design": {
    skillName: "canvas-design",
    displayName: "Canvas Design",
    summary:
      "Visual philosophy creation and static design artifact generation in PNG/PDF.",
    usageNotes:
      "Use for brand visuals, posters, and static compositions where coding UI is not required.",
    sourcePath: ".agents/skills/canvas-design/SKILL.md",
    skillMarkdown: "",
  },
  "frontend-design": {
    skillName: "frontend-design",
    displayName: "Frontend Design",
    summary:
      "Production-grade, distinctive frontend interfaces with strong visual direction.",
    usageNotes:
      "Use for implementing UI pages/components while preserving functionality and responsiveness.",
    sourcePath: ".agents/skills/frontend-design/SKILL.md",
    skillMarkdown: "",
  },
  gemini: {
    skillName: "gemini",
    displayName: "Gemini CLI",
    summary:
      "Large-context analysis and deep code/plan review workflows.",
    usageNotes:
      "Use when broad repository context or heavyweight review is needed.",
    sourcePath: ".agents/skills/gemini/SKILL.md",
    skillMarkdown: "",
  },
  pptx: {
    skillName: "pptx",
    displayName: "PPTX",
    summary:
      "Read, edit, and generate .pptx presentations with structured tooling.",
    usageNotes:
      "Use for any slide/deck workflow (parse, modify, create, merge, update).",
    sourcePath: ".agents/skills/pptx/SKILL.md",
    skillMarkdown: "",
  },
  "supabase-postgres-best-practices": {
    skillName: "supabase-postgres-best-practices",
    displayName: "Supabase Postgres Best Practices",
    summary:
      "Postgres performance and schema/query optimization guidance from Supabase.",
    usageNotes:
      "Use for SQL design, indexing, RLS, query plans, and DB performance tuning.",
    sourcePath: ".agents/skills/supabase-postgres-best-practices/SKILL.md",
    skillMarkdown: "",
  },
  "ui-ux-pro-max": {
    skillName: "ui-ux-pro-max",
    displayName: "UI/UX Pro Max",
    summary:
      "Design intelligence for accessibility, typography, color, layout, and interaction quality.",
    usageNotes:
      "Use for improving usability, visual hierarchy, accessibility, and component ergonomics.",
    sourcePath: ".agents/skills/ui-ux-pro-max/SKILL.md",
    skillMarkdown: "",
  },
};

const isAgentRole = (value: string): value is AgentRole => {
  return ROLE_ORDER.includes(value as AgentRole);
};

const normalizeSkillName = (value: string): string => {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
};

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

const normalizeSkillDefinition = (row: Record<string, unknown>): SkillDefinition | null => {
  const skillName = normalizeSkillName(String(row.skill_name ?? ""));
  if (!skillName) return null;

  const displayName = String(row.display_name ?? skillName).trim() || skillName;
  const summary = String(row.summary ?? "").trim();
  const usageNotes = String(row.usage_notes ?? "").trim();
  const sourcePath = String(row.source_path ?? "").trim();
  const skillMarkdown = String(row.skill_markdown ?? "").trim();
  const fallback = DEFAULT_SKILL_CATALOG[skillName];

  return {
    skillName,
    displayName,
    summary: summary || fallback?.summary || "Skill guidance is available in SKILL.md.",
    usageNotes:
      usageNotes || fallback?.usageNotes || "Use skill based on task intent and role scope.",
    sourcePath: sourcePath || fallback?.sourcePath || "",
    skillMarkdown: skillMarkdown || fallback?.skillMarkdown || "",
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

const normalizeMarketplaceSkillDefinition = (row: Record<string, unknown>): SkillDefinition | null => {
  const skillName = normalizeSkillName(String(row.name ?? ""));
  if (!skillName) return null;

  const displayName = String(row.display_name ?? row.name ?? skillName).trim() || skillName;
  const summary = String(row.description ?? "").trim();
  const implementationRef = String(row.implementation_ref ?? "").trim();
  const fallback = DEFAULT_SKILL_CATALOG[skillName];

  return {
    skillName,
    displayName,
    summary: summary || fallback?.summary || "Marketplace skill registered for this office.",
    usageNotes:
      String(row.usage_notes ?? "").trim() ||
      fallback?.usageNotes ||
      "Use according to the installed office workflow.",
    sourcePath: implementationRef || fallback?.sourcePath || "",
    skillMarkdown: fallback?.skillMarkdown || "",
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

export const loadRoleSkillsFromDb = async (officeId?: string | null): Promise<Record<AgentRole, string[]>> => {
  const context = await loadRoleSkillContextFromDb(officeId);
  return context.roleSkills;
};

export const loadRoleSkillContextFromDb = async (officeId?: string | null): Promise<RoleSkillContext> => {
  const fallback = cloneSkillMap(DEFAULT_ROLE_SKILLS);
  const fallbackCatalog = cloneSkillCatalog(DEFAULT_SKILL_CATALOG);
  if (!isServerSupabaseConfigured) {
    return { roleSkills: fallback, skillCatalog: fallbackCatalog };
  }

  try {
    let agentQuery = supabase.from("agents").select("id, role, skills, office_id").in("role", ROLE_ORDER);
    if (officeId) {
      agentQuery = agentQuery.eq("office_id", officeId);
    }

    const { data } = await agentQuery;
    const roleByAgentId = new Map<string, AgentRole>();
    for (const row of data ?? []) {
      const roleRaw = String(row.role ?? "");
      if (!isAgentRole(roleRaw)) continue;
      const agentId = typeof row.id === "string" ? row.id : "";
      if (agentId) {
        roleByAgentId.set(agentId, roleRaw);
      }
      const normalized = normalizeSkillList(row.skills);
      if (normalized.length > 0) {
        fallback[roleRaw] = normalized;
      }
    }

    const agentIds = Array.from(roleByAgentId.keys());
    if (agentIds.length > 0) {
      const { data: installedSkills } = await supabase
        .from("agent_skills")
        .select("agent_id, skill_id, is_enabled")
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
          .select("id, name, description, parameter_schema, runtime, endpoint, implementation_ref, is_verified, metadata")
          .in("id", skillIds)
          .eq("is_active", true);

        const skillNameById = new Map<string, string>();
        for (const row of marketplaceSkills ?? []) {
          const normalized = normalizeMarketplaceSkillDefinition(row as Record<string, unknown>);
          if (!normalized) continue;
          fallbackCatalog[normalized.skillName] = normalized;
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

          const merged = new Set(fallback[role] ?? []);
          merged.add(skillName);
          fallback[role] = Array.from(merged);
        }
      }
    }

    const { data: skills } = await supabase
      .from("agent_skill_catalog")
      .select("skill_name, display_name, summary, usage_notes, source_path, skill_markdown, runtime, endpoint, parameter_schema, is_verified, metadata");
    for (const row of skills ?? []) {
      const normalized = normalizeSkillDefinition(row as Record<string, unknown>);
      if (!normalized) continue;
      fallbackCatalog[normalized.skillName] = normalized;
    }
  } catch {
    return { roleSkills: fallback, skillCatalog: fallbackCatalog };
  }

  return { roleSkills: fallback, skillCatalog: fallbackCatalog };
};

const compactSkillMarkdown = (skill: SkillDefinition): string => {
  const markdown = skill.skillMarkdown.trim();
  if (!markdown) return skill.summary;

  const cleaned = markdown
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "---")
    .slice(0, 12)
    .join(" ");

  const condensed = cleaned.replace(/\s+/g, " ").trim();
  if (!condensed) return skill.summary;
  if (condensed.length <= 520) return condensed;
  return `${condensed.slice(0, 520)}...`;
};

export const buildRoleSkillsPromptBlock = (
  role: AgentRole,
  roleSkills: Record<AgentRole, string[]>,
  skillCatalog: Record<string, SkillDefinition> = DEFAULT_SKILL_CATALOG
): string => {
  const ownSkills = roleSkills[role] ?? [];
  const ownSkillText = ownSkills.length > 0 ? ownSkills.join(", ") : "base-profile";
  const ownSkillDetails =
    ownSkills.length > 0
      ? ownSkills
          .slice(0, 6)
          .map((skillName) => {
            const skill = skillCatalog[skillName];
            if (!skill) return `- ${skillName}`;
            const guidance = compactSkillMarkdown(skill);
            return `- ${skill.skillName}: ${guidance}`;
          })
          .join("\n")
      : "- no explicit skill profile configured";

  return [
    `Skill profile for ${role}: ${ownSkillText}.`,
    "Skill details:",
    ownSkillDetails,
    "Always use these skills for reasoning, recommendations, and execution planning.",
    "If request is outside your skills, escalate through PM and suggest the best target role.",
  ].join("\n");
};

export const buildTeamSkillsPromptBlock = (
  roleSkills: Record<AgentRole, string[]>
): string => {
  const segments = ROLE_ORDER.map((role) => {
    const values = roleSkills[role] ?? [];
    const text = values.length > 0 ? values.join(", ") : "base-profile";
    return `${role}: [${text}]`;
  });

  return `Team skill matrix: ${segments.join("; ")}.`;
};
