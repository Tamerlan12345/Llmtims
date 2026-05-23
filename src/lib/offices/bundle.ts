import "server-only";

import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { loadOfficeSettings, type OfficeSettings } from "./settings";
import {
  BUNDLE_VERSION,
  assertBundleVersion,
  buildBundlePayload,
  type OfficeBundle,
  type OfficeBundleAgent,
  type OfficeBundleMemoryPattern,
} from "./bundleShared";

export {
  BUNDLE_VERSION,
  assertBundleVersion,
  buildBundlePayload,
  type OfficeBundle,
  type OfficeBundleAgent,
  type OfficeBundleMemoryPattern,
};

type SkillCatalogRow = { id?: string | null; name?: string | null };

export type BundleImportMode = "merge" | "replace";

export interface BundleImportDiff {
  agents: { wouldCreate: number; wouldUpdate: number };
  memoryPatterns: { wouldCreate: number; wouldUpdate: number };
  skippedSkills: string[];
}

export interface BundleImportResult {
  mode: BundleImportMode;
  dryRun: boolean;
  diff: BundleImportDiff;
  errors: string[];
}

const emptyDiff = (): BundleImportDiff => ({
  agents: { wouldCreate: 0, wouldUpdate: 0 },
  memoryPatterns: { wouldCreate: 0, wouldUpdate: 0 },
  skippedSkills: [],
});

export const exportOfficeBundle = async (officeId: string): Promise<OfficeBundle> => {
  const id = officeId.trim();
  if (!id) throw new Error("officeId is required");
  if (!isServerSupabaseConfigured) {
    const settings = await loadOfficeSettings(id);
    return buildBundlePayload({
      office: null,
      settings: settingsSnapshot(settings),
      agents: [],
      agentSkills: [],
      skillCatalog: [],
      memoryPatterns: [],
    });
  }

  const [officeRes, agentsRes, memoryRes, skillsRes, settings] = await Promise.all([
    supabase.from("offices").select("name, description, metadata").eq("id", id).maybeSingle(),
    supabase.from("agents").select("id, role, name, role_md, metadata").eq("office_id", id),
    supabase
      .from("agent_memory_patterns")
      .select("namespace, key, summary, value, confidence, tags, metadata")
      .eq("office_id", id),
    supabase.from("skills_catalog").select("id, name").eq("is_active", true),
    loadOfficeSettings(id),
  ]);

  const agents = (agentsRes.data ?? []) as Array<{ id?: string | null; role?: string | null }>;
  const agentIds = agents.map((row) => row.id).filter((value): value is string => typeof value === "string");
  let agentSkills: Array<{ agent_id?: string | null; skill_id?: string | null; is_enabled?: boolean | null }> = [];
  if (agentIds.length > 0) {
    const { data } = await supabase
      .from("agent_skills")
      .select("agent_id, skill_id, is_enabled")
      .in("agent_id", agentIds);
    agentSkills = (data ?? []) as typeof agentSkills;
  }

  return buildBundlePayload({
    office: (officeRes.data ?? null) as
      | { name?: string | null; description?: string | null; metadata?: Record<string, unknown> | null }
      | null,
    settings: settingsSnapshot(settings),
    agents: agentsRes.data ?? [],
    agentSkills,
    skillCatalog: (skillsRes.data ?? []) as SkillCatalogRow[],
    memoryPatterns: memoryRes.data ?? [],
  });
};

const settingsSnapshot = (settings: OfficeSettings) => ({
  approveMode: settings.approveMode,
  approveModeMinRisk: settings.approveModeMinRisk,
  autoApprovedMcps: settings.autoApprovedMcps,
  dailyTokenBudget: settings.dailyTokenBudget,
  monthlyTokenBudget: settings.monthlyTokenBudget,
  budgetWarnPct: settings.budgetWarnPct,
  budgetHardPct: settings.budgetHardPct,
  budgetForceTier: settings.budgetForceTier,
});

export const importOfficeBundle = async (
  bundle: unknown,
  options: { targetOfficeId: string; mode?: BundleImportMode; dryRun?: boolean }
): Promise<BundleImportResult> => {
  const targetOfficeId = options.targetOfficeId.trim();
  const baseFail = (errors: string[]): BundleImportResult => ({
    mode: options.mode === "replace" ? "replace" : "merge",
    dryRun: true,
    diff: emptyDiff(),
    errors,
  });

  if (!targetOfficeId) return baseFail(["target_office_required"]);
  try {
    assertBundleVersion(bundle);
  } catch (error) {
    return baseFail([error instanceof Error ? error.message : "bundle_invalid"]);
  }

  const typed = bundle as OfficeBundle;
  const mode: BundleImportMode = options.mode === "replace" ? "replace" : "merge";
  const dryRun = Boolean(options.dryRun);

  if (!isServerSupabaseConfigured) {
    return {
      mode,
      dryRun: true,
      diff: {
        agents: { wouldCreate: typed.agents.length, wouldUpdate: 0 },
        memoryPatterns: { wouldCreate: typed.memoryPatterns.length, wouldUpdate: 0 },
        skippedSkills: [],
      },
      errors: ["supabase_not_configured"],
    };
  }

  const [existingAgentsRes, existingMemoryRes, skillsRes] = await Promise.all([
    supabase.from("agents").select("id, role").eq("office_id", targetOfficeId),
    supabase.from("agent_memory_patterns").select("namespace, key").eq("office_id", targetOfficeId),
    supabase.from("skills_catalog").select("id, name").eq("is_active", true),
  ]);

  const existingAgents = (existingAgentsRes.data ?? []) as Array<{ id: string | null; role: string | null }>;
  const existingMemory = (existingMemoryRes.data ?? []) as Array<{ namespace: string | null; key: string | null }>;
  const skillCatalog = (skillsRes.data ?? []) as SkillCatalogRow[];

  const agentIdByRole = new Map<string, string>();
  for (const row of existingAgents) {
    if (typeof row.role === "string" && typeof row.id === "string") agentIdByRole.set(row.role, row.id);
  }
  const existingMemoryKeys = new Set(
    existingMemory
      .map((row) =>
        typeof row.namespace === "string" && typeof row.key === "string" ? `${row.namespace} ${row.key}` : null
      )
      .filter((value): value is string => Boolean(value))
  );
  const skillIdByName = new Map<string, string>();
  for (const skill of skillCatalog) {
    const id = typeof skill.id === "string" ? skill.id : null;
    const name = typeof skill.name === "string" ? skill.name.trim() : "";
    if (id && name) skillIdByName.set(name, id);
  }

  const diff: BundleImportDiff = emptyDiff();
  for (const agent of typed.agents) {
    if (agentIdByRole.has(agent.role)) diff.agents.wouldUpdate += 1;
    else diff.agents.wouldCreate += 1;
    for (const name of agent.skillNames) {
      if (!skillIdByName.has(name) && !diff.skippedSkills.includes(name)) diff.skippedSkills.push(name);
    }
  }
  for (const pattern of typed.memoryPatterns) {
    const cacheKey = `${pattern.namespace} ${pattern.key}`;
    if (existingMemoryKeys.has(cacheKey)) diff.memoryPatterns.wouldUpdate += 1;
    else diff.memoryPatterns.wouldCreate += 1;
  }

  if (dryRun) {
    return { mode, dryRun: true, diff, errors: [] };
  }

  const errors: string[] = [];

  if (mode === "replace") {
    // Replace mode drops existing agents (cascades agent_skills) and memory
    // patterns for this office. Runtime tables (runs/tasks/...) are never in
    // the bundle so the import never touches them.
    const delAgents = await supabase.from("agents").delete().eq("office_id", targetOfficeId);
    if (delAgents.error) errors.push(`agents_delete_failed:${delAgents.error.message}`);
    const delMemory = await supabase.from("agent_memory_patterns").delete().eq("office_id", targetOfficeId);
    if (delMemory.error) errors.push(`memory_delete_failed:${delMemory.error.message}`);
    agentIdByRole.clear();
    existingMemoryKeys.clear();
  }

  // Apply settings through the existing updater so cache + column-fallback
  // stays consistent with PATCH /api/offices behavior.
  const { updateOfficeSettings } = await import("./settings");
  try {
    await updateOfficeSettings(targetOfficeId, {
      approveMode: typed.settings.approveMode,
      approveModeMinRisk: typed.settings.approveModeMinRisk,
      autoApprovedMcps: typed.settings.autoApprovedMcps,
      dailyTokenBudget: typed.settings.dailyTokenBudget,
      monthlyTokenBudget: typed.settings.monthlyTokenBudget,
      budgetWarnPct: typed.settings.budgetWarnPct,
      budgetHardPct: typed.settings.budgetHardPct,
      budgetForceTier: typed.settings.budgetForceTier,
    });
  } catch (error) {
    errors.push(`settings_apply_failed:${error instanceof Error ? error.message : "unknown"}`);
  }

  for (const agent of typed.agents) {
    const existingId = agentIdByRole.get(agent.role) ?? null;
    if (existingId) {
      const { error } = await supabase
        .from("agents")
        .update({
          name: agent.name,
          role_md: agent.role_md,
          metadata: agent.metadata,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existingId);
      if (error) errors.push(`agent_update_failed(${agent.role}):${error.message}`);
      await syncAgentSkills(existingId, targetOfficeId, agent.skillNames, skillIdByName, errors);
      continue;
    }

    const insertRes = await supabase
      .from("agents")
      .insert({
        office_id: targetOfficeId,
        role: agent.role,
        name: agent.name,
        role_md: agent.role_md,
        metadata: agent.metadata,
        is_active: false,
      })
      .select("id")
      .single();
    if (insertRes.error || !insertRes.data?.id) {
      errors.push(`agent_insert_failed(${agent.role}):${insertRes.error?.message ?? "no id"}`);
      continue;
    }
    await syncAgentSkills(insertRes.data.id as string, targetOfficeId, agent.skillNames, skillIdByName, errors);
  }

  for (const pattern of typed.memoryPatterns) {
    const { error } = await supabase
      .from("agent_memory_patterns")
      .upsert(
        {
          office_id: targetOfficeId,
          namespace: pattern.namespace,
          key: pattern.key,
          summary: pattern.summary,
          value: pattern.value,
          confidence: pattern.confidence,
          tags: pattern.tags,
          metadata: pattern.metadata,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "office_id,namespace,key" }
      );
    if (error) errors.push(`memory_upsert_failed(${pattern.key}):${error.message}`);
  }

  return { mode, dryRun: false, diff, errors };
};

const syncAgentSkills = async (
  agentId: string,
  officeId: string,
  skillNames: string[],
  skillIdByName: Map<string, string>,
  errors: string[]
): Promise<void> => {
  const rows = skillNames
    .map((name) => {
      const skillId = skillIdByName.get(name);
      return skillId
        ? {
            agent_id: agentId,
            skill_id: skillId,
            office_id: officeId,
            is_enabled: true,
            updated_at: new Date().toISOString(),
          }
        : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  if (rows.length === 0) return;
  const { error } = await supabase.from("agent_skills").upsert(rows, { onConflict: "agent_id,skill_id" });
  if (error) errors.push(`agent_skills_upsert_failed:${error.message}`);
};
