import "server-only";

import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import type { ToolRiskLevel } from "@/lib/agents/toolPolicy";

export interface OfficeSettings {
  approveMode: boolean;
  approveModeMinRisk: ToolRiskLevel;
  autoApprovedMcps: string[];
  dailyTokenBudget: number | null;
  monthlyTokenBudget: number | null;
  budgetWarnPct: number;
  budgetHardPct: number;
  budgetForceTier: string;
}

const DEFAULT_SETTINGS: OfficeSettings = {
  approveMode: false,
  approveModeMinRisk: "high",
  autoApprovedMcps: [],
  dailyTokenBudget: null,
  monthlyTokenBudget: null,
  budgetWarnPct: 80,
  budgetHardPct: 100,
  budgetForceTier: "fast",
};

const settingsCache = new Map<string, { settings: OfficeSettings; expiresAt: number }>();
const SETTINGS_CACHE_TTL_MS = 60_000; // 1 minute

// Detect missing-column errors raised before the budgets migration is applied.
// Lets the read gracefully fall back to the legacy column set instead of
// failing the whole settings load.
const isMissingBudgetColumnError = (message?: string | null): boolean => {
  const normalized = String(message ?? "").toLowerCase();
  return (
    normalized.includes("daily_token_budget") ||
    normalized.includes("monthly_token_budget") ||
    normalized.includes("budget_warn_pct") ||
    normalized.includes("budget_hard_pct") ||
    normalized.includes("budget_force_tier")
  );
};

const sanitizeBudgetCap = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
};

const sanitizeBudgetPct = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(numeric)));
};

const sanitizeTierName = (value: unknown): string => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized.length > 0 ? normalized : "fast";
};

export const loadOfficeSettings = async (officeId: string | null | undefined): Promise<OfficeSettings> => {
  if (!officeId?.trim()) return DEFAULT_SETTINGS;
  const id = officeId.trim();

  const cached = settingsCache.get(id);
  if (cached && Date.now() < cached.expiresAt) return cached.settings;

  if (!isServerSupabaseConfigured) return DEFAULT_SETTINGS;

  let { data, error } = await supabase
    .from("offices")
    .select(
      "approve_mode, approve_mode_min_risk, auto_approved_mcps, daily_token_budget, monthly_token_budget, budget_warn_pct, budget_hard_pct, budget_force_tier"
    )
    .eq("id", id)
    .maybeSingle();

  // Fallback for installations where cic_office_budgets_v33.sql is not applied
  // yet — re-run with the legacy column set so existing offices keep working.
  if (error && isMissingBudgetColumnError(error.message)) {
    const legacy = await supabase
      .from("offices")
      .select("approve_mode, approve_mode_min_risk, auto_approved_mcps")
      .eq("id", id)
      .maybeSingle();
    data = legacy.data;
    error = legacy.error;
  }

  if (error || !data) {
    if (error) console.error("[office-settings] failed to load:", error.message);
    return DEFAULT_SETTINGS;
  }

  const row = data as {
    approve_mode?: boolean | null;
    approve_mode_min_risk?: string | null;
    auto_approved_mcps?: string[] | null;
    daily_token_budget?: number | null;
    monthly_token_budget?: number | null;
    budget_warn_pct?: number | null;
    budget_hard_pct?: number | null;
    budget_force_tier?: string | null;
  };

  const validRisks: ToolRiskLevel[] = ["low", "medium", "high", "critical"];
  const minRisk = validRisks.includes(row.approve_mode_min_risk as ToolRiskLevel)
    ? (row.approve_mode_min_risk as ToolRiskLevel)
    : "high";

  const settings: OfficeSettings = {
    approveMode: row.approve_mode === true,
    approveModeMinRisk: minRisk,
    autoApprovedMcps: Array.isArray(row.auto_approved_mcps) ? row.auto_approved_mcps : [],
    dailyTokenBudget: sanitizeBudgetCap(row.daily_token_budget),
    monthlyTokenBudget: sanitizeBudgetCap(row.monthly_token_budget),
    budgetWarnPct: sanitizeBudgetPct(row.budget_warn_pct, DEFAULT_SETTINGS.budgetWarnPct),
    budgetHardPct: sanitizeBudgetPct(row.budget_hard_pct, DEFAULT_SETTINGS.budgetHardPct),
    budgetForceTier: sanitizeTierName(row.budget_force_tier),
  };

  settingsCache.set(id, { settings, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return settings;
};

export const invalidateOfficeSettingsCache = (officeId: string): void => {
  settingsCache.delete(officeId.trim());
};

export const updateOfficeSettings = async (
  officeId: string,
  patch: Partial<
    Pick<
      OfficeSettings,
      | "approveMode"
      | "approveModeMinRisk"
      | "autoApprovedMcps"
      | "dailyTokenBudget"
      | "monthlyTokenBudget"
      | "budgetWarnPct"
      | "budgetHardPct"
      | "budgetForceTier"
    >
  >
): Promise<OfficeSettings | null> => {
  if (!officeId?.trim() || !isServerSupabaseConfigured) return null;
  const id = officeId.trim();

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.approveMode === "boolean") update.approve_mode = patch.approveMode;
  if (patch.approveModeMinRisk) update.approve_mode_min_risk = patch.approveModeMinRisk;
  if (Array.isArray(patch.autoApprovedMcps)) update.auto_approved_mcps = patch.autoApprovedMcps;
  if (patch.dailyTokenBudget === null) update.daily_token_budget = null;
  else if (typeof patch.dailyTokenBudget === "number") update.daily_token_budget = sanitizeBudgetCap(patch.dailyTokenBudget);
  if (patch.monthlyTokenBudget === null) update.monthly_token_budget = null;
  else if (typeof patch.monthlyTokenBudget === "number") update.monthly_token_budget = sanitizeBudgetCap(patch.monthlyTokenBudget);
  if (typeof patch.budgetWarnPct === "number") update.budget_warn_pct = sanitizeBudgetPct(patch.budgetWarnPct, DEFAULT_SETTINGS.budgetWarnPct);
  if (typeof patch.budgetHardPct === "number") update.budget_hard_pct = sanitizeBudgetPct(patch.budgetHardPct, DEFAULT_SETTINGS.budgetHardPct);
  if (typeof patch.budgetForceTier === "string") update.budget_force_tier = sanitizeTierName(patch.budgetForceTier);

  const { error } = await supabase.from("offices").update(update).eq("id", id);
  if (error) {
    // If the budget columns aren't present yet, silently retry without them so
    // approveMode-style PATCH calls keep working before the migration is run.
    if (isMissingBudgetColumnError(error.message)) {
      const legacyUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof patch.approveMode === "boolean") legacyUpdate.approve_mode = patch.approveMode;
      if (patch.approveModeMinRisk) legacyUpdate.approve_mode_min_risk = patch.approveModeMinRisk;
      if (Array.isArray(patch.autoApprovedMcps)) legacyUpdate.auto_approved_mcps = patch.autoApprovedMcps;
      const legacy = await supabase.from("offices").update(legacyUpdate).eq("id", id);
      if (legacy.error) {
        console.error("[office-settings] failed to update (legacy):", legacy.error.message);
        return null;
      }
    } else {
      console.error("[office-settings] failed to update:", error.message);
      return null;
    }
  }

  invalidateOfficeSettingsCache(id);
  return loadOfficeSettings(id);
};
