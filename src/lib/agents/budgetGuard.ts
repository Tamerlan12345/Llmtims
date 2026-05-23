import "server-only";

import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { loadOfficeSettings } from "@/lib/offices/settings";
import { MODEL_TIER_ORDER, type ModelTier } from "./modelRegistry";
import { computeBudgetState, type BudgetState } from "./budgetShared";

export type BudgetWindow = "24h" | "30d";
export type { BudgetState } from "./budgetShared";

export interface BudgetUsage {
  window: BudgetWindow;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  loadedAt: string;
}

export interface BudgetEvaluation {
  state: BudgetState;
  dailyUsageTokens: number;
  monthlyUsageTokens: number;
  dailyCap: number | null;
  monthlyCap: number | null;
  dailyUsagePct: number | null;
  monthlyUsagePct: number | null;
  remainingDaily: number | null;
  remainingMonthly: number | null;
  warnPct: number;
  hardPct: number;
  forceTier: ModelTier;
  evaluatedAt: string;
}

const USAGE_CACHE_TTL_MS = 30_000;
const usageCache = new Map<string, { value: BudgetUsage; expiresAt: number }>();

const windowMs = (window: BudgetWindow): number =>
  window === "24h" ? 24 * 60 * 60 * 1_000 : 30 * 24 * 60 * 60 * 1_000;

const buildCacheKey = (officeId: string, window: BudgetWindow): string => `${officeId}:${window}`;

const isModelTier = (value: unknown): value is ModelTier =>
  typeof value === "string" && (MODEL_TIER_ORDER as string[]).includes(value);

const sanitizeTier = (value: unknown): ModelTier => (isModelTier(value) ? value : "fast");

const sanitizePct = (value: unknown, fallback: number): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(numeric)));
};

const sanitizeCap = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric);
};

export const invalidateBudgetUsageCache = (officeId?: string | null): void => {
  if (!officeId) {
    usageCache.clear();
    return;
  }
  const trimmed = officeId.trim();
  usageCache.delete(buildCacheKey(trimmed, "24h"));
  usageCache.delete(buildCacheKey(trimmed, "30d"));
};

export const loadOfficeBudgetUsage = async (
  officeId: string,
  window: BudgetWindow
): Promise<BudgetUsage> => {
  const id = officeId.trim();
  const key = buildCacheKey(id, window);
  const cached = usageCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const empty: BudgetUsage = {
    window,
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    loadedAt: new Date().toISOString(),
  };

  if (!id || !isServerSupabaseConfigured) return empty;

  const since = new Date(Date.now() - windowMs(window)).toISOString();
  const { data, error } = await supabase
    .from("token_logs")
    .select("prompt_tokens, completion_tokens")
    .eq("office_id", id)
    .gte("created_at", since);

  if (error || !Array.isArray(data)) {
    if (error) console.warn("[budget-guard] failed to load usage:", error.message);
    return empty;
  }

  let promptTokens = 0;
  let completionTokens = 0;
  for (const row of data as Array<{ prompt_tokens?: number | null; completion_tokens?: number | null }>) {
    promptTokens += Number(row.prompt_tokens ?? 0);
    completionTokens += Number(row.completion_tokens ?? 0);
  }

  const usage: BudgetUsage = {
    window,
    totalTokens: promptTokens + completionTokens,
    promptTokens,
    completionTokens,
    loadedAt: new Date().toISOString(),
  };

  usageCache.set(key, { value: usage, expiresAt: Date.now() + USAGE_CACHE_TTL_MS });
  return usage;
};

export const evaluateBudget = async (officeId: string | null | undefined): Promise<BudgetEvaluation> => {
  const id = (officeId ?? "").trim();
  const now = new Date().toISOString();
  const settings = await loadOfficeSettings(id || null);

  const dailyCap = sanitizeCap(settings.dailyTokenBudget);
  const monthlyCap = sanitizeCap(settings.monthlyTokenBudget);
  const warnPct = sanitizePct(settings.budgetWarnPct, 80);
  const hardPct = sanitizePct(settings.budgetHardPct, 100);
  const forceTier = sanitizeTier(settings.budgetForceTier);

  // Short-circuit when nothing is configured — saves a DB hit per call.
  if (!id || (dailyCap === null && monthlyCap === null)) {
    return {
      state: "ok",
      dailyUsageTokens: 0,
      monthlyUsageTokens: 0,
      dailyCap,
      monthlyCap,
      dailyUsagePct: null,
      monthlyUsagePct: null,
      remainingDaily: null,
      remainingMonthly: null,
      warnPct,
      hardPct,
      forceTier,
      evaluatedAt: now,
    };
  }

  const [daily, monthly] = await Promise.all([
    dailyCap !== null ? loadOfficeBudgetUsage(id, "24h") : Promise.resolve<BudgetUsage | null>(null),
    monthlyCap !== null ? loadOfficeBudgetUsage(id, "30d") : Promise.resolve<BudgetUsage | null>(null),
  ]);

  const dailyUsageTokens = daily?.totalTokens ?? 0;
  const monthlyUsageTokens = monthly?.totalTokens ?? 0;
  const { state, dailyUsagePct, monthlyUsagePct } = computeBudgetState({
    dailyUsageTokens,
    monthlyUsageTokens,
    dailyCap,
    monthlyCap,
    warnPct,
    hardPct,
  });

  return {
    state,
    dailyUsageTokens,
    monthlyUsageTokens,
    dailyCap,
    monthlyCap,
    dailyUsagePct,
    monthlyUsagePct,
    remainingDaily: dailyCap === null ? null : Math.max(0, dailyCap - dailyUsageTokens),
    remainingMonthly: monthlyCap === null ? null : Math.max(0, monthlyCap - monthlyUsageTokens),
    warnPct,
    hardPct,
    forceTier,
    evaluatedAt: now,
  };
};
