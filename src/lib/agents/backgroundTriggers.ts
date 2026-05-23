import "server-only";

import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import type { AgentRun } from "./runService";
import type { WorkerTrigger, WorkerTriggerMatch } from "./rufloCoreShared";

// Triggers that can be auto-dispatched as background runs because they
// strictly read state. Writeful triggers (refactor/optimize/consolidate/etc.)
// stay behind explicit human-initiated runs + approval gating.
export const READ_ONLY_TRIGGERS: ReadonlySet<WorkerTrigger> = new Set<WorkerTrigger>([
  "audit",
  "map",
  "testgaps",
  "document",
  "deepdive",
]);

const DEFAULT_MIN_CONFIDENCE = 0.5;
const MAX_DISPATCH_PER_RUN = 2;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const isWorkerTriggerMatch = (value: unknown): value is WorkerTriggerMatch => {
  if (!isRecord(value)) return false;
  const trigger = (value as { trigger?: unknown }).trigger;
  const confidence = Number((value as { confidence?: unknown }).confidence);
  return typeof trigger === "string" && Number.isFinite(confidence);
};

const isBackgroundEnabled = (): boolean => process.env.ENABLE_BACKGROUND_TRIGGERS === "true";

const TRIGGER_PROMPTS: Record<WorkerTrigger, string> = {
  audit:
    "Perform a strictly read-only security review of the current workspace. Identify vulnerabilities, risky patterns, secrets exposure, missing access checks. Produce findings only — DO NOT modify files or run write-mode tools.",
  map:
    "Produce a read-only architectural map: top modules, key entry points, dependency hotspots, integration boundaries. Summarize so future agents can navigate quickly. DO NOT modify files.",
  testgaps:
    "Identify untested code paths and missing test coverage. List the top gaps with rationale and proposed test outlines. DO NOT write tests or modify files.",
  document:
    "Survey existing documentation and produce a read-only summary of what exists, what is stale, and the highest-leverage doc gaps. DO NOT modify files.",
  deepdive:
    "Perform a deep read-only analysis of the most recent change set. Surface assumptions, hidden coupling, edge cases. DO NOT modify files.",
  // Writeful triggers reach this map only for completeness; dispatch filters them out.
  optimize: "",
  consolidate: "",
  predict: "",
  preload: "",
  refactor: "",
  benchmark: "",
  ultralearn: "",
};

export const buildTriggerRunInput = (trigger: WorkerTrigger, originalInput?: string | null): string => {
  const directive = TRIGGER_PROMPTS[trigger] ?? "";
  const contextLine = originalInput
    ? `Originating request: ${String(originalInput).replace(/\s+/g, " ").trim().slice(0, 400)}`
    : "";
  return [
    `[BACKGROUND_TRIGGER:${trigger}]`,
    directive,
    contextLine,
    "Output: a concise findings report. No side effects.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
};

const readReadOnlyMatches = (run: AgentRun): WorkerTriggerMatch[] => {
  const rawTriggers = toRecord(run.metadata).backgroundTriggers;
  if (!Array.isArray(rawTriggers)) return [];
  return rawTriggers
    .filter(isWorkerTriggerMatch)
    .filter(
      (match) =>
        READ_ONLY_TRIGGERS.has(match.trigger as WorkerTrigger) && match.confidence >= DEFAULT_MIN_CONFIDENCE
    )
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, MAX_DISPATCH_PER_RUN);
};

const buildBackgroundTaskTitle = (trigger: WorkerTrigger, parentInput?: string | null): string => {
  const snippet = (parentInput ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const suffix = snippet ? `: ${snippet}` : "";
  return `[background:${trigger}]${suffix}`.slice(0, 200);
};

interface DispatchResult {
  dispatched: Array<{ trigger: WorkerTrigger; taskId: string; runId: string }>;
  skipped: Array<{ trigger: WorkerTrigger; reason: string }>;
}

const insertBackgroundTask = async (
  parentRun: AgentRun,
  trigger: WorkerTrigger,
  match: WorkerTriggerMatch
): Promise<string | null> => {
  const description = buildTriggerRunInput(trigger, parentRun.input);
  const payload = {
    title: buildBackgroundTaskTitle(trigger, parentRun.input),
    description,
    status: "pending",
    office_id: parentRun.officeId,
    metadata: {
      source: "background_trigger",
      background: true,
      trigger,
      confidence: match.confidence,
      parentRunId: parentRun.id,
      parentTaskId: parentRun.taskId,
    },
  };

  const { data, error } = await supabase
    .from("tasks")
    .insert(payload)
    .select("id")
    .single();

  if (error) {
    console.warn(`[background-triggers] task insert failed (${trigger}):`, error.message);
    return null;
  }

  return typeof data?.id === "string" ? data.id : null;
};

const markRunDispatched = async (
  runId: string,
  existingMetadata: Record<string, unknown>,
  dispatched: DispatchResult["dispatched"]
): Promise<void> => {
  const { error } = await supabase
    .from("agent_runs")
    .update({
      metadata: {
        ...existingMetadata,
        backgroundDispatched: true,
        backgroundDispatchedAt: new Date().toISOString(),
        backgroundDispatchSummary: dispatched.map((item) => ({
          trigger: item.trigger,
          runId: item.runId,
          taskId: item.taskId,
        })),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) {
    console.warn("[background-triggers] failed to mark run dispatched:", error.message);
  }
};

// Spawns background runs for any read-only triggers detected on the parent run.
// Returns the dispatch summary so the caller can log it. Guarded by:
//   - ENABLE_BACKGROUND_TRIGGERS env (default off — supervised autonomy)
//   - run.metadata.background → never recursively spawn from a background run
//   - run.metadata.backgroundDispatched → idempotency
export const dispatchBackgroundTriggers = async (input: {
  run: AgentRun | null;
}): Promise<DispatchResult> => {
  const result: DispatchResult = { dispatched: [], skipped: [] };
  const run = input.run;
  if (!run) return result;
  if (!isServerSupabaseConfigured) return result;
  if (!isBackgroundEnabled()) {
    return { dispatched: [], skipped: [{ trigger: "audit", reason: "disabled" }] };
  }
  const metadata = toRecord(run.metadata);
  if (metadata.background === true) {
    return { dispatched: [], skipped: [{ trigger: "audit", reason: "is_background_run" }] };
  }
  if (metadata.backgroundDispatched === true) {
    return { dispatched: [], skipped: [{ trigger: "audit", reason: "already_dispatched" }] };
  }

  const matches = readReadOnlyMatches(run);
  if (matches.length === 0) return result;

  // Import lazily to keep this module free of cyclic runService dependency at
  // load time (runService imports rufloCore which is sibling, fine — but
  // queueAgentWorkflow is also runService-local).
  const { queueAgentWorkflow } = await import("./runService");

  for (const match of matches) {
    const trigger = match.trigger as WorkerTrigger;
    const newTaskId = await insertBackgroundTask(run, trigger, match);
    if (!newTaskId) {
      result.skipped.push({ trigger, reason: "task_insert_failed" });
      continue;
    }

    try {
      const queuedRun = await queueAgentWorkflow({
        officeId: run.officeId,
        taskId: newTaskId,
        input: buildTriggerRunInput(trigger, run.input),
        targetRole: "All",
        metadata: {
          background: true,
          trigger,
          parentRunId: run.id,
          parentTaskId: run.taskId,
          confidence: match.confidence,
        },
      });
      result.dispatched.push({ trigger, taskId: newTaskId, runId: queuedRun.id });
    } catch (error) {
      console.warn(`[background-triggers] queueAgentWorkflow failed (${trigger}):`, error);
      result.skipped.push({ trigger, reason: "queue_failed" });
    }
  }

  if (result.dispatched.length > 0) {
    await markRunDispatched(run.id, metadata, result.dispatched);
  }

  return result;
};
