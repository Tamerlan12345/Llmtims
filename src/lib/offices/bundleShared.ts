// Pure bundle helpers (version guard + payload normalization). No server-only
// deps so node tests and import-route validators can use them without booting
// Supabase / Next runtime.

import type { ToolRiskLevel } from "@/lib/agents/toolPolicy";

export const BUNDLE_VERSION = "1";

export interface OfficeSettingsSnapshot {
  approveMode: boolean;
  approveModeMinRisk: ToolRiskLevel;
  autoApprovedMcps: string[];
  dailyTokenBudget: number | null;
  monthlyTokenBudget: number | null;
  budgetWarnPct: number;
  budgetHardPct: number;
  budgetForceTier: string;
}

export interface OfficeBundleAgent {
  role: string;
  name: string | null;
  role_md: string | null;
  metadata: Record<string, unknown>;
  skillNames: string[];
}

export interface OfficeBundleMemoryPattern {
  namespace: string;
  key: string;
  summary: string | null;
  value: string;
  confidence: number;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface OfficeBundle {
  version: string;
  exportedAt: string;
  office: {
    name: string;
    description: string | null;
    metadata: Record<string, unknown>;
  };
  settings: OfficeSettingsSnapshot;
  agents: OfficeBundleAgent[];
  memoryPatterns: OfficeBundleMemoryPattern[];
}

type AgentRow = {
  id?: string | null;
  role?: string | null;
  name?: string | null;
  role_md?: string | null;
  metadata?: Record<string, unknown> | null;
};

type AgentSkillRow = {
  agent_id?: string | null;
  skill_id?: string | null;
  is_enabled?: boolean | null;
};

type SkillCatalogRow = {
  id?: string | null;
  name?: string | null;
};

type MemoryPatternRow = {
  namespace?: string | null;
  key?: string | null;
  summary?: string | null;
  value?: string | null;
  confidence?: number | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
};

type OfficeRow = {
  name?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const normalizeStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .filter((item) => item.length > 0)
        )
      )
    : [];

const clampConfidence = (value: unknown): number => {
  const numeric = Number(value ?? 0.5);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.max(0, Math.min(1, numeric));
};

export const buildBundlePayload = (input: {
  office: OfficeRow | null;
  settings: OfficeSettingsSnapshot;
  agents: AgentRow[];
  agentSkills: AgentSkillRow[];
  skillCatalog: SkillCatalogRow[];
  memoryPatterns: MemoryPatternRow[];
}): OfficeBundle => {
  const skillNameById = new Map<string, string>();
  for (const skill of input.skillCatalog) {
    const id = typeof skill.id === "string" ? skill.id : null;
    const name = typeof skill.name === "string" ? skill.name.trim() : "";
    if (id && name) skillNameById.set(id, name);
  }

  const agentSkillsByAgent = new Map<string, string[]>();
  for (const link of input.agentSkills) {
    if (link.is_enabled === false) continue;
    const agentId = typeof link.agent_id === "string" ? link.agent_id : null;
    const skillId = typeof link.skill_id === "string" ? link.skill_id : null;
    if (!agentId || !skillId) continue;
    const skillName = skillNameById.get(skillId);
    if (!skillName) continue;
    const current = agentSkillsByAgent.get(agentId) ?? [];
    if (!current.includes(skillName)) current.push(skillName);
    agentSkillsByAgent.set(agentId, current);
  }

  const agents: OfficeBundleAgent[] = input.agents
    .map<OfficeBundleAgent | null>((row) => {
      const role = typeof row.role === "string" ? row.role.trim() : "";
      if (!role) return null;
      const id = typeof row.id === "string" ? row.id : null;
      return {
        role,
        name: typeof row.name === "string" ? row.name : null,
        role_md: typeof row.role_md === "string" ? row.role_md : null,
        metadata: toRecord(row.metadata),
        skillNames: id ? agentSkillsByAgent.get(id) ?? [] : [],
      };
    })
    .filter((agent): agent is OfficeBundleAgent => agent !== null);

  const memoryPatterns: OfficeBundleMemoryPattern[] = input.memoryPatterns
    .map<OfficeBundleMemoryPattern | null>((row) => {
      const key = typeof row.key === "string" ? row.key.trim() : "";
      const value = typeof row.value === "string" ? row.value : "";
      if (!key || !value) return null;
      const namespace = typeof row.namespace === "string" && row.namespace.trim().length > 0
        ? row.namespace.trim()
        : "patterns";
      return {
        namespace,
        key,
        summary: typeof row.summary === "string" ? row.summary : null,
        value,
        confidence: clampConfidence(row.confidence),
        tags: normalizeStringArray(row.tags),
        metadata: toRecord(row.metadata),
      };
    })
    .filter((pattern): pattern is OfficeBundleMemoryPattern => pattern !== null);

  return {
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    office: {
      name: typeof input.office?.name === "string" ? input.office.name : "",
      description: typeof input.office?.description === "string" ? input.office.description : null,
      metadata: toRecord(input.office?.metadata),
    },
    settings: input.settings,
    agents,
    memoryPatterns,
  };
};

export const assertBundleVersion = (value: unknown): { version: string } => {
  if (!value || typeof value !== "object") {
    throw new Error("bundle_invalid");
  }
  const version = (value as { version?: unknown }).version;
  if (typeof version !== "string" || version !== BUNDLE_VERSION) {
    throw new Error("bundle_version_unsupported");
  }
  return { version };
};
