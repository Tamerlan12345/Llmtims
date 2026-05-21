export const DEFAULT_MEMORY_NAMESPACE = "patterns";
export const DEFAULT_MEMORY_MIN_CONFIDENCE = 0.3;
export const MAX_MEMORY_SEARCH_LIMIT = 10;
export const TOOL_DETAIL_PERSIST_THRESHOLD = 1200;
export const TOOL_DETAIL_MAX_LENGTH = 100_000;

export type WorkerTrigger =
  | "ultralearn"
  | "optimize"
  | "consolidate"
  | "predict"
  | "audit"
  | "map"
  | "preload"
  | "deepdive"
  | "document"
  | "refactor"
  | "benchmark"
  | "testgaps";

export interface WorkerTriggerMatch {
  trigger: WorkerTrigger;
  confidence: number;
  priority: "low" | "normal" | "high" | "critical";
  description: string;
  capabilities: string[];
}

export interface WorkerTriggerDetection {
  detected: boolean;
  triggers: WorkerTriggerMatch[];
  confidence: number;
  context: string | null;
}

export interface SwarmTraceSummary {
  topology: string;
  strategy: string;
  maxAgents: number;
  consensusMode: string;
  memoryNamespace: string;
  antiDrift: {
    coordinatorGate: boolean;
    maxIterations: number;
    reworkLimit: number;
  };
}

export interface AgentMemoryHit {
  id: string;
  key: string;
  namespace: string;
  summary: string;
  valuePreview: string;
  confidence: number;
  score: number;
  tags: string[];
  sourceRunId?: string | null;
  sourceTaskId?: string | null;
  createdAt?: string | null;
}

export interface AgentRunTaskCard {
  id: string;
  step: number | null;
  toolCallId: string | null;
  toolName: string;
  status: string;
  decision: string | null;
  riskLevel: string | null;
  argsPreview: string | null;
  summary: string | null;
  detailToken: string | null;
  durationMs: number | null;
  createdAt: string | null;
}

export interface AgentRunTaskGroup {
  id: string;
  step: number;
  status: "running" | "completed" | "failed" | "mixed";
  durationMs: number | null;
  tasks: AgentRunTaskCard[];
}

const TRIGGER_PATTERNS: Record<WorkerTrigger, RegExp[]> = {
  ultralearn: [/learn\s+about/i, /understand\s+(how|what|why)/i, /master\s+this/i],
  optimize: [/optimi[sz]e/i, /improve\s+performance/i, /make\s+(it\s+)?faster/i, /speed\s+up/i],
  consolidate: [/consolidate/i, /deduplicate/i, /memory\s+maintenance/i],
  predict: [/predict/i, /forecast/i, /anticipate/i, /prepare\s+for/i],
  audit: [/security\s+audit/i, /vulnerabilit/i, /security\s+(check|scan)/i, /cve/i, /owasp/i],
  map: [/map\s+(the\s+)?codebase/i, /architecture\s+overview/i, /dependency\s+graph/i],
  preload: [/preload/i, /prefetch/i, /warm\s+(up\s+)?cache/i],
  deepdive: [/deep\s+dive/i, /in-depth\s+analysis/i, /comprehensive\s+review/i],
  document: [/document\s+(this|the)/i, /generate\s+docs/i, /write\s+readme/i, /api\s+docs/i],
  refactor: [/refactor/i, /clean\s+up\s+code/i, /restructure/i, /simplify/i],
  benchmark: [/benchmark/i, /performance\s+test/i, /measure\s+speed/i, /load\s+test/i],
  testgaps: [/test\s+coverage/i, /missing\s+tests/i, /untested\s+code/i, /test\s+gaps/i],
};

const TRIGGER_CONFIGS: Record<WorkerTrigger, Omit<WorkerTriggerMatch, "trigger" | "confidence">> = {
  ultralearn: {
    description: "Deep knowledge acquisition and synthesis",
    priority: "normal",
    capabilities: ["research", "analysis", "synthesis"],
  },
  optimize: {
    description: "Performance optimization and tuning",
    priority: "high",
    capabilities: ["profiling", "optimization", "benchmarking"],
  },
  consolidate: {
    description: "Pattern memory consolidation",
    priority: "low",
    capabilities: ["memory-management", "deduplication"],
  },
  predict: {
    description: "Predictive preparation and cache warming",
    priority: "normal",
    capabilities: ["prediction", "preloading"],
  },
  audit: {
    description: "Security analysis and vulnerability review",
    priority: "critical",
    capabilities: ["security", "audit"],
  },
  map: {
    description: "Codebase mapping and architecture analysis",
    priority: "normal",
    capabilities: ["analysis", "mapping"],
  },
  preload: {
    description: "Resource preloading",
    priority: "low",
    capabilities: ["caching"],
  },
  deepdive: {
    description: "Deep code analysis",
    priority: "normal",
    capabilities: ["analysis", "review"],
  },
  document: {
    description: "Documentation generation",
    priority: "normal",
    capabilities: ["documentation", "writing"],
  },
  refactor: {
    description: "Refactoring recommendations",
    priority: "normal",
    capabilities: ["refactoring", "code-quality"],
  },
  benchmark: {
    description: "Performance benchmarking",
    priority: "normal",
    capabilities: ["benchmarking", "measurement"],
  },
  testgaps: {
    description: "Test coverage gap analysis",
    priority: "normal",
    capabilities: ["testing", "coverage"],
  },
};

const VALID_TOPOLOGIES = new Set(["hierarchical", "mesh", "hierarchical-mesh", "ring", "star", "adaptive"]);
const VALID_STRATEGIES = new Set(["specialized", "balanced", "adaptive"]);

export const normalizeMemoryNamespace = (value: unknown): string => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized.replace(/[^a-z0-9-_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || DEFAULT_MEMORY_NAMESPACE;
};

export const normalizeMemoryLimit = (value: unknown): number => {
  const numeric = Number(value ?? MAX_MEMORY_SEARCH_LIMIT);
  if (!Number.isFinite(numeric)) return MAX_MEMORY_SEARCH_LIMIT;
  return Math.min(Math.max(Math.floor(numeric), 1), MAX_MEMORY_SEARCH_LIMIT);
};

export const normalizeConfidence = (value: unknown, fallback = DEFAULT_MEMORY_MIN_CONFIDENCE): number => {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
};

const tokenize = (value: string): string[] =>
  Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^a-zа-я0-9_]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  );

export const buildPlainTextSearchQuery = (value: string): string | null => {
  const tokens = tokenize(value).slice(0, 12);
  return tokens.length > 0 ? tokens.join(" ") : null;
};

export const scoreMemoryPattern = (input: {
  query: string;
  summary?: string | null;
  value?: string | null;
  tags?: string[] | null;
  confidence?: number | null;
}): number => {
  const tokens = tokenize(input.query);
  if (tokens.length === 0) return normalizeConfidence(input.confidence, 0);

  const haystack = [input.summary, input.value, ...(input.tags ?? [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
  if (!haystack) return 0;

  const matches = tokens.filter((token) => haystack.includes(token)).length;
  const matchRatio = matches / tokens.length;
  const exactBoost = haystack.includes(input.query.trim().toLowerCase()) ? 0.2 : 0;
  return Math.max(0, Math.min(1, matchRatio * 0.65 + normalizeConfidence(input.confidence, 0.5) * 0.25 + exactBoost));
};

export const buildDefaultSwarmConfig = (value?: Record<string, unknown> | null): SwarmTraceSummary => {
  const topology = typeof value?.topology === "string" && VALID_TOPOLOGIES.has(value.topology)
    ? value.topology
    : "hierarchical";
  const strategy = typeof value?.strategy === "string" && VALID_STRATEGIES.has(value.strategy)
    ? value.strategy
    : "specialized";
  const maxAgents = Math.min(Math.max(Math.floor(Number(value?.maxAgents ?? 8)), 1), 50);
  const consensusMode =
    typeof value?.consensusMode === "string" && value.consensusMode.trim()
      ? value.consensusMode.trim()
      : "coordinator_gate";

  return {
    topology,
    strategy,
    maxAgents,
    consensusMode,
    memoryNamespace: normalizeMemoryNamespace(value?.memoryNamespace),
    antiDrift: {
      coordinatorGate: value?.coordinatorGate !== false,
      maxIterations: Math.min(Math.max(Math.floor(Number(value?.maxIterations ?? 12)), 1), 50),
      reworkLimit: Math.min(Math.max(Math.floor(Number(value?.reworkLimit ?? 2)), 0), 10),
    },
  };
};

export const detectWorkerTriggers = (text: string): WorkerTriggerDetection => {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return { detected: false, triggers: [], confidence: 0, context: null };
  }

  const matches: WorkerTriggerMatch[] = [];
  for (const [trigger, patterns] of Object.entries(TRIGGER_PATTERNS) as [WorkerTrigger, RegExp[]][]) {
    const matchCount = patterns.filter((pattern) => pattern.test(normalized)).length;
    if (matchCount === 0) continue;
    const config = TRIGGER_CONFIGS[trigger];
    matches.push({
      trigger,
      confidence: Math.min(1, matchCount / Math.max(patterns.length, 1) + 0.35),
      ...config,
    });
  }

  const confidence =
    matches.length === 0
      ? 0
      : Math.min(1, matches.reduce((sum, match) => sum + match.confidence, 0) / matches.length);
  return {
    detected: matches.length > 0,
    triggers: matches.sort((left, right) => right.confidence - left.confidence),
    confidence,
    context: normalized.slice(0, 160),
  };
};

const readRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const readString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
};

const readNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
};

const readOutputText = (row: Record<string, unknown>): string | null => {
  const output = readRecord(row.output);
  return readString(output.text, output.summary);
};

const compactSummary = (value: string | null, fallback: string): string => {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized ? normalized.slice(0, 220) : fallback;
};

export const normalizeToolTaskGroups = (toolInvocations: Array<Record<string, unknown>>): AgentRunTaskGroup[] => {
  const groups = new Map<string, AgentRunTaskCard[]>();

  for (const row of toolInvocations) {
    const metadata = readRecord(row.metadata);
    const groupId = readString(metadata.toolGroupId);
    if (!groupId) continue;
    const source = readString(metadata.source);
    if (source && source !== "llm_tool_call_result") continue;

    const toolName = readString(row.toolId, row.tool_id) ?? "tool";
    const step = readNumber(metadata.toolGroupStep);
    const task: AgentRunTaskCard = {
      id: readString(row.id) ?? `${groupId}-${groups.size + 1}`,
      step: step === null ? null : Math.max(1, Math.floor(step)),
      toolCallId: readString(metadata.toolCallId),
      toolName,
      status: readString(row.status) ?? "completed",
      decision: readString(row.decision),
      riskLevel: readString(row.riskLevel, row.risk_level),
      argsPreview: readString(metadata.argsPreview),
      summary: readString(metadata.summary) ?? compactSummary(readOutputText(row), `${toolName} completed`),
      detailToken: readString(metadata.detailToken),
      durationMs: readNumber(metadata.durationMs),
      createdAt: readString(row.createdAt, row.created_at),
    };
    groups.set(groupId, [...(groups.get(groupId) ?? []), task]);
  }

  return Array.from(groups.entries())
    .map(([id, tasks]) => {
      const inferredStep = Number(id.match(/-(\d+)-/)?.[1] ?? 1);
      const step = tasks.find((task) => typeof task.step === "number")?.step ?? (Number.isFinite(inferredStep) ? inferredStep : 1);
      const statuses = new Set(tasks.map((task) => task.status));
      const failed = tasks.some((task) => task.status === "failed" || task.decision === "denied");
      const running = tasks.some((task) => task.status === "started" || task.status === "pending");
      return {
        id,
        step: Math.max(1, Math.floor(step)),
        status: failed ? (statuses.size > 1 ? "mixed" : "failed") : running ? "running" : "completed",
        durationMs: tasks.reduce((max, task) => Math.max(max, task.durationMs ?? 0), 0) || null,
        tasks,
      } satisfies AgentRunTaskGroup;
    })
    .sort((left, right) => left.step - right.step);
};

export const extractMemoryHitsFromToolInvocations = (
  toolInvocations: Array<Record<string, unknown>>
): AgentMemoryHit[] => {
  const hits: AgentMemoryHit[] = [];
  for (const row of toolInvocations) {
    const toolName = readString(row.toolId, row.tool_id);
    if (toolName !== "memory_search") continue;
    const outputText = readOutputText(row);
    if (!outputText) continue;
    try {
      const parsed = JSON.parse(outputText) as { hits?: AgentMemoryHit[] };
      if (Array.isArray(parsed.hits)) {
        hits.push(...parsed.hits);
      }
    } catch {
      // Ignore malformed historical tool output.
    }
  }
  return hits.slice(0, MAX_MEMORY_SEARCH_LIMIT);
};
