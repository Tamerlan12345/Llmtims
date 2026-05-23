// Pure budget evaluation primitives. No server-only deps so node tests can
// import the helpers without booting Supabase / Next runtime.

export type BudgetState = "ok" | "warn" | "block";

export interface BudgetStateInput {
  dailyUsageTokens: number;
  monthlyUsageTokens: number;
  dailyCap: number | null;
  monthlyCap: number | null;
  warnPct: number;
  hardPct: number;
}

export interface BudgetStateResult {
  state: BudgetState;
  dailyUsagePct: number | null;
  monthlyUsagePct: number | null;
}

export const computeBudgetState = (input: BudgetStateInput): BudgetStateResult => {
  const dailyUsagePct = input.dailyCap ? (input.dailyUsageTokens / input.dailyCap) * 100 : null;
  const monthlyUsagePct = input.monthlyCap ? (input.monthlyUsageTokens / input.monthlyCap) * 100 : null;
  const usagePctMax = Math.max(dailyUsagePct ?? 0, monthlyUsagePct ?? 0);

  if (input.dailyCap === null && input.monthlyCap === null) {
    return { state: "ok", dailyUsagePct, monthlyUsagePct };
  }
  if (usagePctMax >= input.hardPct) {
    return { state: "block", dailyUsagePct, monthlyUsagePct };
  }
  if (usagePctMax >= input.warnPct) {
    return { state: "warn", dailyUsagePct, monthlyUsagePct };
  }
  return { state: "ok", dailyUsagePct, monthlyUsagePct };
};
