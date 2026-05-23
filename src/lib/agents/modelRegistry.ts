// Provider/model abstraction for agent LLM calls.
// Native replacement for an external multi-model router: every agent invocation
// resolves through a tier registry so the runtime never hard-codes one model.
// Today only the Gemini provider is wired; new providers append to ModelProvider
// and createChatModel without touching call sites.

export type ModelProvider = "gemini";

// Tiers are ordered smallest -> largest. Concrete model names are env-overridable
// per tier, so the operator fills in exact Gemini model ids without code changes.
export type ModelTier = "fast" | "standard" | "advanced" | "max";

export const MODEL_TIER_ORDER: ModelTier[] = ["fast", "standard", "advanced", "max"];

// Safest fallback model id: the smallest tier the operator has access to.
// If a configured tier resolves to a model the API refuses, the runtime
// retries once against this fallback (see invokeAgentModel).
export const FALLBACK_MODEL = "gemini-3.1-flash-lite";

export interface ModelDescriptor {
  tier: ModelTier;
  provider: ModelProvider;
  model: string;
  maxOutputTokens: number;
}

// Configured ladder (operator-provided, ascending capability):
//   fast     -> Gemini 3.1 Flash Lite
//   standard -> Gemini Embedding 2
//   advanced -> Gemma 4 31B
//   max      -> Gemma 4 26B
// Override per-tier via GEMINI_MODEL_<TIER> if the exact Google API id differs
// from the slug below — no code change needed.
const DEFAULT_MODEL_BY_TIER: Record<ModelTier, string> = {
  fast: "gemini-3.1-flash-lite",
  standard: "gemini-embedding-2",
  advanced: "gemma-4-31b",
  max: "gemma-4-26b",
};

const TIER_ENV_KEY: Record<ModelTier, string> = {
  fast: "GEMINI_MODEL_FAST",
  standard: "GEMINI_MODEL_STANDARD",
  advanced: "GEMINI_MODEL_ADVANCED",
  max: "GEMINI_MODEL_MAX",
};

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

// Retired or non-existent model ids that frequently appear in stale env files.
// Gemini 2.0 Flash was retired on 3 March 2026; redirect to FALLBACK_MODEL so
// a stale GEMINI_MODEL_* value cannot silently break every agent call.
const UNSUPPORTED_MODELS = new Set(["gemini-2.0-flash", "gemini-3.0-flash"]);

const readEnv = (key: string): string | undefined => {
  const value = typeof process !== "undefined" ? process.env?.[key] : undefined;
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : undefined;
};

export const isModelTier = (value: unknown): value is ModelTier =>
  typeof value === "string" && (MODEL_TIER_ORDER as string[]).includes(value);

export const normalizeModelTier = (value: unknown, fallback: ModelTier = "standard"): ModelTier =>
  isModelTier(value) ? value : fallback;

export const getDefaultModelTier = (): ModelTier =>
  normalizeModelTier(readEnv("AGENT_MODEL_TIER"), "standard");

export const sanitizeModelName = (value: unknown): string => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || UNSUPPORTED_MODELS.has(normalized)) {
    return FALLBACK_MODEL;
  }
  return normalized;
};

export const resolveModelName = (tier?: ModelTier | null): string => {
  const resolvedTier = normalizeModelTier(tier, getDefaultModelTier());
  // GEMINI_MODEL stays as a global override for the default tier (back-compat).
  const globalOverride = resolvedTier === getDefaultModelTier() ? readEnv("GEMINI_MODEL") : undefined;
  const tierOverride = readEnv(TIER_ENV_KEY[resolvedTier]);
  return sanitizeModelName(globalOverride ?? tierOverride ?? DEFAULT_MODEL_BY_TIER[resolvedTier]);
};

export const resolveModelDescriptor = (tier?: ModelTier | null): ModelDescriptor => {
  const resolvedTier = normalizeModelTier(tier, getDefaultModelTier());
  return {
    tier: resolvedTier,
    provider: "gemini",
    model: resolveModelName(resolvedTier),
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  };
};

const COMPLEX_TASK_PATTERN =
  /(architect|refactor|security|audit|design|migrat|optimi[sz]e|debug|算|анализ|архитектур|рефактор|безопасн|миграц)/i;

// Heuristic tier picker — keeps cheap models for short/simple turns and escalates
// for long or structurally complex prompts. Pure so it stays unit-testable.
export const selectTierForText = (text: string): ModelTier => {
  const normalized = String(text ?? "").trim();
  const length = normalized.length;
  if (length === 0) return "standard";
  if (length > 16000) return "max";
  if (length > 6000 || COMPLEX_TASK_PATTERN.test(normalized)) return "advanced";
  if (length < 600) return "fast";
  return "standard";
};

// When AGENT_MODEL_AUTO_TIER=true the runtime picks a tier per turn; otherwise it
// keeps the configured default tier (behaviour identical to the single-model setup).
export const resolveTierForInvocation = (input: {
  requestedTier?: ModelTier | null;
  promptText?: string | null;
}): ModelTier => {
  if (isModelTier(input.requestedTier)) return input.requestedTier;
  if (readEnv("AGENT_MODEL_AUTO_TIER") === "true") {
    return selectTierForText(input.promptText ?? "");
  }
  return getDefaultModelTier();
};
