import "server-only";

import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import type { ToolRiskLevel } from "@/lib/agents/toolPolicy";

export interface OfficeSettings {
  approveMode: boolean;
  approveModeMinRisk: ToolRiskLevel;
  autoApprovedMcps: string[];
}

const DEFAULT_SETTINGS: OfficeSettings = {
  approveMode: false,
  approveModeMinRisk: "high",
  autoApprovedMcps: [],
};

const settingsCache = new Map<string, { settings: OfficeSettings; expiresAt: number }>();
const SETTINGS_CACHE_TTL_MS = 60_000; // 1 minute

export const loadOfficeSettings = async (officeId: string | null | undefined): Promise<OfficeSettings> => {
  if (!officeId?.trim()) return DEFAULT_SETTINGS;
  const id = officeId.trim();

  const cached = settingsCache.get(id);
  if (cached && Date.now() < cached.expiresAt) return cached.settings;

  if (!isServerSupabaseConfigured) return DEFAULT_SETTINGS;

  const { data, error } = await supabase
    .from("offices")
    .select("approve_mode, approve_mode_min_risk, auto_approved_mcps")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error("[office-settings] failed to load:", error.message);
    return DEFAULT_SETTINGS;
  }

  const row = data as {
    approve_mode?: boolean | null;
    approve_mode_min_risk?: string | null;
    auto_approved_mcps?: string[] | null;
  };

  const validRisks: ToolRiskLevel[] = ["low", "medium", "high", "critical"];
  const minRisk = validRisks.includes(row.approve_mode_min_risk as ToolRiskLevel)
    ? (row.approve_mode_min_risk as ToolRiskLevel)
    : "high";

  const settings: OfficeSettings = {
    approveMode: row.approve_mode === true,
    approveModeMinRisk: minRisk,
    autoApprovedMcps: Array.isArray(row.auto_approved_mcps) ? row.auto_approved_mcps : [],
  };

  settingsCache.set(id, { settings, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return settings;
};

export const invalidateOfficeSettingsCache = (officeId: string): void => {
  settingsCache.delete(officeId.trim());
};

export const updateOfficeSettings = async (
  officeId: string,
  patch: Partial<Pick<OfficeSettings, "approveMode" | "approveModeMinRisk" | "autoApprovedMcps">>
): Promise<OfficeSettings | null> => {
  if (!officeId?.trim() || !isServerSupabaseConfigured) return null;
  const id = officeId.trim();

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.approveMode === "boolean") update.approve_mode = patch.approveMode;
  if (patch.approveModeMinRisk) update.approve_mode_min_risk = patch.approveModeMinRisk;
  if (Array.isArray(patch.autoApprovedMcps)) update.auto_approved_mcps = patch.autoApprovedMcps;

  const { error } = await supabase.from("offices").update(update).eq("id", id);
  if (error) {
    console.error("[office-settings] failed to update:", error.message);
    return null;
  }

  invalidateOfficeSettingsCache(id);
  return loadOfficeSettings(id);
};
