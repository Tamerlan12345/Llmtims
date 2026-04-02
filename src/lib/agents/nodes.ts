import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentState, WorkflowSubTask } from "./graph";
import {
  clearWorkflowCheckpoint,
  saveWorkflowCheckpoint,
} from "./persistence";
import {
  buildRoleSkillsPromptBlock,
  buildTeamSkillsPromptBlock,
  loadRoleSkillContextFromDb,
  type AgentRole,
  type OfficeAgentProfile,
  type RoleSkillContext,
} from "./skillProfiles";
import { invokeAgentModel, runSandboxValidationWithMcp } from "./tools";
import { supabaseServer as supabase } from "../supabase/server";
import {
  patchAgentRuntimeByRole,
  patchPlayerStateByRole,
  patchRoomState,
  publishTeamEvent,
  syncRoleTokenUsage,
} from "./realtime";
import { pixelOfficeSeats } from "../office/pixelOfficeLayout";

export type WorkflowRole = string;

interface ParsedDecision {
  status?: string | null;
  next_agent?: string | null;
  target?: string | null;
  summary?: string | null;
  sub_tasks?: WorkflowSubTask[];
}

const IDLE_WORKFLOW_ACTION = "Awaiting the next office task.";
const DEFAULT_DYNAMIC_ROLE = "Coordinator";
const FALLBACK_ROLE_ACTION_TEMPLATE = "Агент %ROLE% выполняет задачу.";
const QUALITY_CONTROL_MARKERS = [
  "qa",
  "review",
  "tester",
  "test",
  "контрол",
  "тест",
  "ревью",
  "quality",
];
const OFFICE_SEAT_POOL = pixelOfficeSeats.map((seat) => ({
  x: seat.seatCol,
  y: seat.seatRow,
}));
const DEFAULT_VALIDATOR_COMMAND = process.env.MCP_VALIDATOR_COMMAND ?? "npm run test";

interface ResolvedAgentRecord {
  id: string;
  role: string;
  name: string | null;
  role_md: string | null;
  metadata: Record<string, unknown>;
}

const normalizeRoleName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const uniqueRoles = (value: Array<string | null | undefined>): string[] => {
  return Array.from(
    new Set(
      value
        .map((item) => normalizeRoleName(item))
        .filter((item): item is string => Boolean(item))
    )
  );
};

const toMetadataObject = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const toOptionalNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
};

const asLowerCaseText = (...values: unknown[]): string => {
  return values
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
};

const isQualityControlRole = (
  role: string,
  agentProfile?: OfficeAgentProfile | null,
  agentRecord?: ResolvedAgentRecord | null
): boolean => {
  const haystack = asLowerCaseText(
    role,
    agentProfile?.name,
    agentProfile?.roleMarkdown,
    agentRecord?.name,
    agentRecord?.role_md
  );
  return QUALITY_CONTROL_MARKERS.some((marker) => haystack.includes(marker));
};

const parseActionFromRoleMarkdown = (roleMarkdown?: string | null): string | null => {
  if (typeof roleMarkdown !== "string" || roleMarkdown.trim().length === 0) {
    return null;
  }

  const candidate = roleMarkdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("-") && !line.startsWith("1."));
  return candidate ?? null;
};

const seatKey = (x: number | null, y: number | null): string | null => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return `${Math.round(Number(x))}:${Math.round(Number(y))}`;
};

const markSeatAsOccupied = (occupiedSeatKeys: Set<string>, x: number | null, y: number | null) => {
  const key = seatKey(x, y);
  if (key) occupiedSeatKeys.add(key);
};

const stableRoleHash = (role: string): number => {
  let hash = 0;
  for (let index = 0; index < role.length; index += 1) {
    hash = (hash * 31 + role.charCodeAt(index)) >>> 0;
  }
  return hash;
};

const pickFallbackSeat = (role: string, occupiedSeatKeys: Set<string>) => {
  for (const seat of OFFICE_SEAT_POOL) {
    const key = seatKey(seat.x, seat.y);
    if (!key || occupiedSeatKeys.has(key)) continue;
    occupiedSeatKeys.add(key);
    return seat;
  }

  if (OFFICE_SEAT_POOL.length === 0) return null;
  return OFFICE_SEAT_POOL[stableRoleHash(role) % OFFICE_SEAT_POOL.length] ?? null;
};

const getWorkflowRoles = (state: AgentState, context: RoleSkillContext): string[] => {
  const configured = Array.isArray(state.workflow_roles) ? uniqueRoles(state.workflow_roles) : [];
  if (configured.length > 0) return configured;

  const contextRoles = uniqueRoles(context.availableRoles);
  if (contextRoles.length > 0) return contextRoles;

  const derivedFallbackRoles = uniqueRoles([
    normalizeRoleName(state.coordinator_role),
    normalizeRoleName(state.current_assignee),
    normalizeRoleName(state.last_actor),
  ]);
  return derivedFallbackRoles.length > 0 ? derivedFallbackRoles : [DEFAULT_DYNAMIC_ROLE];
};

const ensureWorkflowSubTasks = (state: AgentState, workflowRoles: string[]): WorkflowSubTask[] => {
  if (Array.isArray(state.sub_tasks) && state.sub_tasks.length > 0) {
    return state.sub_tasks.map((subTask) => ({
      ...subTask,
      title:
        typeof subTask.title === "string" && subTask.title.trim().length > 0
          ? subTask.title
          : `${subTask.assignee ?? "Office"} work item`,
    }));
  }

  return workflowRoles.map((role, index) => ({
    id: `${state.task_id}-${index + 1}-${role.toLowerCase().replace(/\s+/g, "-")}`,
    title: `${role} work item`,
    status: index === 0 ? "in_progress" : "pending",
    assignee: role,
  }));
};

const syncSubTasks = (
  subTasks: WorkflowSubTask[],
  completedRoles: string[],
  currentAssignee?: string | null
): WorkflowSubTask[] => {
  const completedSet = new Set(completedRoles);
  const active = normalizeRoleName(currentAssignee);

  return subTasks.map((subTask) => {
    const assignee = normalizeRoleName(subTask.assignee);
    if (assignee && active && assignee === active) {
      return { ...subTask, status: "in_progress" };
    }
    if (assignee && completedSet.has(assignee)) {
      return { ...subTask, status: "done" };
    }
    return { ...subTask, status: "pending" };
  });
};

const buildArtifactsPrompt = (state: AgentState): string => {
  const artifacts = Array.isArray(state.artifacts) ? state.artifacts : [];
  if (artifacts.length === 0) {
    return "=== АРТЕФАКТЫ ПРОЕКТА ===\nАртефакты пока не были созданы.";
  }

  return [
    "=== АРТЕФАКТЫ ПРОЕКТА ===",
    artifacts
      .map((artifact) => {
        const role = normalizeRoleName(artifact.role) ?? "Неизвестная роль";
        const content =
          typeof artifact.content === "string" && artifact.content.trim().length > 0
            ? artifact.content
            : artifact.summary;
        const normalizedContent = String(content ?? "").trim();
        const safeContent = normalizedContent.replace(/<\/artifact_content>/gi, "<\\/artifact_content>");
        return `[Роль: ${role}]\n<artifact_content>\n${safeContent}\n</artifact_content>`;
      })
      .join("\n\n"),
  ].join("\n");
};

const buildRouterInstruction = (
  role: string,
  workflowRoles: string[],
  coordinatorRole: string,
  agentProfile?: OfficeAgentProfile | null,
  agentRecord?: ResolvedAgentRecord | null
): string => {
  if (role !== coordinatorRole) {
    const baseInstruction = [
      "Return the work result first.",
      "After the result, append one fenced JSON block with this schema:",
      '```json',
      '{"status":"completed|rejected|needs_human|done","target":"Role|null","next_agent":"Role|END|null","summary":"short summary"}',
      '```',
      "Use status=rejected only when work must go back for rework.",
      "Use status=needs_human only when a human reviewer must decide before the workflow continues.",
      "Do not invent roles outside the available office roster.",
    ];

    if (isQualityControlRole(role, agentProfile, agentRecord)) {
      baseInstruction.push(
        "As a quality-control role, if you find a critical issue, return status: rejected.",
        "When rejecting, set target to the exact role that must rework the artifact."
      );
    }

    return baseInstruction.join("\n");
  }

  return [
    "You are the office coordinator and dynamic router.",
    `Available office roles: ${workflowRoles.join(", ")}.`,
    "Decide the best next assignee based on the request, chat history, and accumulated artifacts.",
    "Return a concise routing explanation first.",
    "After the explanation, append one fenced JSON block with this schema:",
    '```json',
    '{"status":"planned|needs_human|done","next_agent":"Role|END","summary":"short routing summary","sub_tasks":[{"id":"t1","title":"task title","status":"pending","assignee":"Role"}]}',
    '```',
    "If the task is complete, set next_agent to END and status to done.",
    "If human approval is required before continuing, set status to needs_human.",
  ].join("\n");
};

const buildBaseRolePrompt = (
  role: string,
  coordinatorRole: string,
  workflowRoles: string[],
  state: AgentState,
  context: RoleSkillContext,
  rolePrompt: string,
  artifactsPrompt: string,
  agentProfile?: OfficeAgentProfile | null,
  agentRecord?: ResolvedAgentRecord | null
) => {
  const taskHeader =
    state.target_role && state.target_role !== "All"
      ? `Primary user target: ${state.target_role}.`
      : "Primary user target: the full office.";

  return [
    `You are ${role} inside Digital Pixel Office.`,
    `Coordinator role: ${coordinatorRole}.`,
    taskHeader,
    buildTeamSkillsPromptBlock(context.roleSkills),
    rolePrompt,
    artifactsPrompt,
    buildRouterInstruction(role, workflowRoles, coordinatorRole, agentProfile, agentRecord),
    "Be explicit about blockers. Do not claim execution results that were not actually produced.",
  ].join("\n\n");
};

const getRecentMessages = async (
  state: AgentState,
  role: string,
  context: RoleSkillContext,
  workflowRoles: string[],
  coordinatorRole: string
) => {
  const agentProfile = context.agentProfiles[role] ?? null;
  const agentRecord = await resolveAgentByRole(role, state.office_id ?? null);
  const rolePrompt = buildRoleSkillsPromptBlock(
    role as AgentRole,
    context.roleSkills,
    context.skillCatalog,
    agentProfile
  );
  const artifactsPrompt = buildArtifactsPrompt(state);
  const systemPrompt = buildBaseRolePrompt(
    role,
    coordinatorRole,
    workflowRoles,
    state,
    context,
    rolePrompt,
    artifactsPrompt,
    agentProfile,
    agentRecord
  );

  return [
    new SystemMessage(systemPrompt),
    ...state.messages.map((message) =>
      message.type === "human" ? new HumanMessage(message.content) : new AIMessage(message.content)
    ),
  ];
};

const resolvePrimarySkill = (context: RoleSkillContext, role: string): string | null => {
  const primarySkillName = context.roleSkills[role]?.[0];
  if (!primarySkillName) return null;
  return context.skillCatalog[primarySkillName]?.displayName ?? primarySkillName;
};

const resolveAgentByRole = async (
  role: string,
  officeId?: string | null
): Promise<ResolvedAgentRecord | null> => {
  let query = supabase.from("agents").select("id, role, name, metadata, role_md").eq("role", role);
  if (officeId) {
    query = query.eq("office_id", officeId);
  }

  const { data, error } = await query.limit(1);
  if (error) {
    console.error(`[agents] failed to resolve agent for ${role}:`, error);
    return null;
  }

  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0] as Record<string, unknown>;
  const id = typeof first.id === "string" ? first.id : "";
  const resolvedRole = typeof first.role === "string" ? first.role : role;
  if (!id || !resolvedRole) return null;

  return {
    id,
    role: resolvedRole,
    name: typeof first.name === "string" ? first.name : null,
    role_md: typeof first.role_md === "string" ? first.role_md : null,
    metadata: toMetadataObject(first.metadata),
  };
};

const resolveCoordinatesFromMetadata = (metadata: Record<string, unknown>) => {
  return {
    x: toOptionalNumber(
      metadata.current_target_x,
      metadata.currentTargetX,
      metadata.default_x,
      metadata.defaultX,
      metadata.target_x,
      metadata.targetX,
      metadata.x
    ),
    y: toOptionalNumber(
      metadata.current_target_y,
      metadata.currentTargetY,
      metadata.default_y,
      metadata.defaultY,
      metadata.target_y,
      metadata.targetY,
      metadata.y
    ),
  };
};

const resolveRoleActionDescription = (
  role: string,
  explicitAction?: string | null,
  profile?: OfficeAgentProfile | null,
  agentRecord?: ResolvedAgentRecord | null
): string => {
  const normalizedExplicitAction = normalizeRoleName(explicitAction);
  if (normalizedExplicitAction) return normalizedExplicitAction;

  const metadata = agentRecord?.metadata ?? {};
  const metadataAction = normalizeRoleName(
    metadata.action_description ?? metadata.actionDescription ?? metadata.current_action
  );
  if (metadataAction) return metadataAction;

  const profileAction = normalizeRoleName(profile?.actionDescription);
  if (profileAction) return profileAction;

  const fromRoleMarkdown =
    parseActionFromRoleMarkdown(agentRecord?.role_md) ??
    parseActionFromRoleMarkdown(profile?.roleMarkdown);
  if (fromRoleMarkdown) return fromRoleMarkdown;

  return FALLBACK_ROLE_ACTION_TEMPLATE.replace("%ROLE%", role);
};

const loadOccupiedSeatKeys = async (officeId?: string | null): Promise<Set<string>> => {
  const occupiedSeatKeys = new Set<string>();
  const normalizedOfficeId = normalizeRoleName(officeId);

  try {
    let statesQuery = supabase
      .from("agent_states")
      .select("current_target_x, current_target_y");
    if (normalizedOfficeId) {
      statesQuery = statesQuery.eq("office_id", normalizedOfficeId);
    }

    const { data: states } = await statesQuery;
    for (const row of states ?? []) {
      const x = toOptionalNumber((row as Record<string, unknown>).current_target_x);
      const y = toOptionalNumber((row as Record<string, unknown>).current_target_y);
      markSeatAsOccupied(occupiedSeatKeys, x, y);
    }
  } catch (error) {
    console.error("[agents] failed to read occupied agent states:", error);
  }

  try {
    let agentsQuery = supabase.from("agents").select("metadata");
    if (normalizedOfficeId) {
      agentsQuery = agentsQuery.eq("office_id", normalizedOfficeId);
    }

    const { data: agents } = await agentsQuery;
    for (const agent of agents ?? []) {
      const metadata = toMetadataObject((agent as Record<string, unknown>).metadata);
      const coordinates = resolveCoordinatesFromMetadata(metadata);
      markSeatAsOccupied(occupiedSeatKeys, coordinates.x, coordinates.y);
    }
  } catch (error) {
    console.error("[agents] failed to read occupied agent metadata:", error);
  }

  return occupiedSeatKeys;
};

const resolveAgentTarget = (
  role: string,
  profile: OfficeAgentProfile | null,
  agentRecord: ResolvedAgentRecord | null,
  occupiedSeatKeys: Set<string>,
  explicitAction?: string | null
) => {
  const metadataCoordinates = resolveCoordinatesFromMetadata(agentRecord?.metadata ?? {});
  let x = metadataCoordinates.x ?? profile?.defaultX ?? null;
  let y = metadataCoordinates.y ?? profile?.defaultY ?? null;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const fallbackSeat = pickFallbackSeat(role, occupiedSeatKeys);
    x = fallbackSeat?.x ?? x;
    y = fallbackSeat?.y ?? y;
  }

  markSeatAsOccupied(occupiedSeatKeys, x, y);

  return {
    x,
    y,
    action: resolveRoleActionDescription(role, explicitAction, profile, agentRecord),
  };
};

const setActiveRole = async (
  state: AgentState,
  role: string,
  context: RoleSkillContext,
  action?: string,
  currentSkill?: string | null,
  subTasks: WorkflowSubTask[] = []
) => {
  try {
    const occupiedSeatKeys = await loadOccupiedSeatKeys(state.office_id ?? null);
    const activeProfile = context.agentProfiles[role] ?? null;
    const activeAgentRecord = await resolveAgentByRole(role, state.office_id ?? null);
    const activeTarget = resolveAgentTarget(
      role,
      activeProfile,
      activeAgentRecord,
      occupiedSeatKeys,
      action
    );
    const activeAction = activeTarget.action;

    if (state.office_id) {
      await supabase
        .from("agents")
        .update({ is_active: false })
        .eq("office_id", state.office_id);

      await supabase
        .from("agents")
        .update({ is_active: true })
        .eq("office_id", state.office_id)
        .eq("role", role);
    }

    await patchRoomState({
      roomKey: state.room_key ?? undefined,
      activeRole: role,
      pendingTaskId: state.task_id,
      metadata: {
        lastActiveRoleAt: new Date().toISOString(),
        currentAction: activeAction,
        currentSkill: currentSkill ?? null,
        currentAssignee: role,
        subTasks,
        officeId: state.office_id ?? null,
      },
    });

    const workflowRoles = getWorkflowRoles(state, context);
    for (const teamRole of workflowRoles) {
      const profile = context.agentProfiles[teamRole] ?? null;
      const teamAgentRecord = await resolveAgentByRole(teamRole, state.office_id ?? null);
      const target = resolveAgentTarget(teamRole, profile, teamAgentRecord, occupiedSeatKeys);
      const active = teamRole === role;

      await patchPlayerStateByRole(teamRole, {
        roomKey: state.room_key ?? undefined,
        officeId: state.office_id ?? null,
        status: active ? "working" : "idle",
        isOnline: true,
        metadata: { source: "workflow", officeId: state.office_id ?? null },
      });

      await patchAgentRuntimeByRole(teamRole, {
        officeId: state.office_id ?? null,
        status: active ? "working" : "idle",
        currentAction: active ? activeAction : IDLE_WORKFLOW_ACTION,
        currentSkill: active ? currentSkill ?? null : null,
        currentTargetX: target.x,
        currentTargetY: target.y,
        metadata: {
          source: "workflow",
          officeId: state.office_id ?? null,
          taskId: state.task_id,
          roomKey: state.room_key ?? null,
        },
      });
    }
  } catch (error) {
    console.error(`[agents] failed to set active role ${role}:`, error);
  }
};

const setWorkflowIdleState = async (
  state: AgentState,
  context: RoleSkillContext,
  action: string
) => {
  const occupiedSeatKeys = await loadOccupiedSeatKeys(state.office_id ?? null);
  const workflowRoles = getWorkflowRoles(state, context);

  for (const role of workflowRoles) {
    const profile = context.agentProfiles[role] ?? null;
    const agentRecord = await resolveAgentByRole(role, state.office_id ?? null);
    const target = resolveAgentTarget(role, profile, agentRecord, occupiedSeatKeys);

    await patchPlayerStateByRole(role, {
      roomKey: state.room_key ?? undefined,
      officeId: state.office_id ?? null,
      status: "idle",
      isOnline: true,
      metadata: { source: "workflow", officeId: state.office_id ?? null },
    });

    await patchAgentRuntimeByRole(role, {
      officeId: state.office_id ?? null,
      status: "idle",
      currentAction: action,
      currentSkill: null,
      currentTargetX: target.x,
      currentTargetY: target.y,
      metadata: {
        source: "workflow",
        officeId: state.office_id ?? null,
        taskId: state.task_id,
        roomKey: state.room_key ?? null,
      },
    });
  }
};

const updateTaskState = async (
  state: AgentState,
  status: "in_progress" | "review" | "waiting_approval" | "done" | "failed",
  role?: string | null,
  artifacts: AgentState["artifacts"] = state.artifacts ?? []
) => {
  try {
    let assignedAgentId: string | null | undefined = undefined;
    if (role) {
      const agent = await resolveAgentByRole(role, state.office_id ?? null);
      assignedAgentId = agent?.id ?? null;
    }

    const payload: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
      artifacts,
    };
    if (assignedAgentId !== undefined) {
      payload.assigned_agent_id = assignedAgentId;
    }

    let query = supabase.from("tasks").update(payload).eq("id", state.task_id);
    if (state.office_id) {
      query = query.eq("office_id", state.office_id);
    }
    await query;

    await patchRoomState({
      roomKey: state.room_key ?? undefined,
      taskStatus: status,
      activeRole: role ?? null,
      pendingTaskId: status === "done" ? null : state.task_id,
      mode:
        status === "waiting_approval"
          ? "approval"
          : status === "in_progress" || status === "review"
            ? "execution"
            : "discussion",
      metadata: {
        lastTaskStateUpdateAt: new Date().toISOString(),
        officeId: state.office_id ?? null,
      },
    });
  } catch (error) {
    console.error(`[tasks] failed to update state ${status} for task ${state.task_id}:`, error);
  }
};

const persistUsage = async (
  state: AgentState,
  role: string,
  model: string,
  promptTokens: number,
  completionTokens: number
) => {
  try {
    const totalTokens = promptTokens + completionTokens;
    const cost = Number(((totalTokens / 1000) * 0.001).toFixed(6));
    const agent = await resolveAgentByRole(role, state.office_id ?? null);

    await supabase.from("token_logs").insert({
      agent_id: agent?.id ?? null,
      task_id: state.task_id,
      office_id: state.office_id ?? null,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      model,
      cost,
    });

    if (agent?.id) {
      let usageQuery = supabase
        .from("token_logs")
        .select("prompt_tokens, completion_tokens")
        .eq("agent_id", agent.id);
      if (state.office_id) {
        usageQuery = usageQuery.eq("office_id", state.office_id);
      }

      const { data: usageRows } = await usageQuery;
      const aggregateTotal = (usageRows ?? []).reduce((sum, row) => {
        return sum + Number(row.prompt_tokens ?? 0) + Number(row.completion_tokens ?? 0);
      }, 0);

      await syncRoleTokenUsage(role, aggregateTotal, state.room_key ?? undefined, state.office_id ?? null);
    }
  } catch (error) {
    console.error(`[usage] failed to persist token usage for ${role}:`, error);
  }
};

const extractDecisionFromContent = (content: string): ParsedDecision => {
  const matches = Array.from(content.matchAll(/```json\s*([\s\S]*?)```/gi));
  const jsonCandidate = matches.length > 0 ? matches[matches.length - 1]?.[1] : null;
  if (!jsonCandidate) return {};

  try {
    const parsed = JSON.parse(jsonCandidate.trim()) as ParsedDecision;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const stripDecisionBlock = (content: string): string => {
  return content.replace(/```json\s*[\s\S]*?```/gi, "").trim();
};

const appendWorkflowArtifact = (
  state: AgentState,
  role: string,
  content: string,
  currentSkill?: string | null,
  decision?: ParsedDecision
) => {
  const strippedContent = stripDecisionBlock(String(content ?? "")).trim();
  if (!strippedContent) {
    return state.artifacts ?? [];
  }

  return [
    ...(state.artifacts ?? []),
    {
      id: `${state.task_id}-${role.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
      role,
      skill: currentSkill ?? null,
      status: decision?.status ?? null,
      summary: String(decision?.summary ?? strippedContent.slice(0, 5000)),
      content: strippedContent,
      createdAt: new Date().toISOString(),
    },
  ];
};

const resolveReworkTarget = (
  state: AgentState,
  role: string,
  workflowRoles: string[],
  coordinatorRole: string,
  explicitTarget?: string | null
): string | null => {
  const candidate = normalizeRoleName(explicitTarget);
  if (candidate && candidate !== role && workflowRoles.includes(candidate)) {
    return candidate;
  }

  const previousActor = normalizeRoleName(state.last_actor);
  if (previousActor && previousActor !== role && workflowRoles.includes(previousActor)) {
    return previousActor;
  }

  if (Array.isArray(state.sub_tasks)) {
    const orderedRoles = state.sub_tasks
      .map((subTask) => normalizeRoleName(subTask.assignee))
      .filter((value): value is string => Boolean(value));
    const roleIndex = orderedRoles.lastIndexOf(role);
    if (roleIndex > 0) {
      const previousSubTaskRole = orderedRoles[roleIndex - 1];
      if (previousSubTaskRole && previousSubTaskRole !== role && workflowRoles.includes(previousSubTaskRole)) {
        return previousSubTaskRole;
      }
    }
  }

  const orderedIndex = workflowRoles.indexOf(role);
  if (orderedIndex > 0) {
    const previousOrderedRole = workflowRoles[orderedIndex - 1];
    if (previousOrderedRole && previousOrderedRole !== role) {
      return previousOrderedRole;
    }
  }

  if (coordinatorRole && coordinatorRole !== role && workflowRoles.includes(coordinatorRole)) {
    return coordinatorRole;
  }

  return workflowRoles.find((candidateRole) => candidateRole !== role) ?? null;
};

const resolveManualNextRoles = (
  state: AgentState,
  role: string,
  decision: ParsedDecision,
  workflowRoles: string[],
  coordinatorRole: string
) => {
  const decisionStatus = String(decision.status ?? "").trim().toLowerCase();

  if (decisionStatus === "rejected") {
    const target = resolveReworkTarget(state, role, workflowRoles, coordinatorRole, decision.target);
    if (target) return [target];
  }

  const edges = Array.isArray(state.workflow_edges) ? state.workflow_edges : [];
  const outgoing = edges
    .filter((edge) => normalizeRoleName(edge.from) === role)
    .filter((edge) => {
      const condition = String(edge.condition ?? "approve").trim().toLowerCase();
      if (decisionStatus === "rejected") {
        return condition === "reject" || condition === "rejected" || condition === "rework";
      }
      return condition !== "reject" && condition !== "rejected" && condition !== "rework";
    })
    .map((edge) => normalizeRoleName(edge.to))
    .filter((value): value is string => Boolean(value));

  if (outgoing.length > 0) return uniqueRoles(outgoing);

  const currentIndex = workflowRoles.indexOf(role);
  const nextRole = workflowRoles[currentIndex + 1];
  return nextRole ? [nextRole] : [];
};

const resolveAutonomousNextRole = (
  state: AgentState,
  role: string,
  decision: ParsedDecision,
  workflowRoles: string[],
  coordinatorRole: string
) => {
  const decisionStatus = String(decision.status ?? "").trim().toLowerCase();

  if (decisionStatus === "done") {
    return "END";
  }

  const candidate =
    normalizeRoleName(decision.next_agent) ??
    (decisionStatus === "rejected"
      ? resolveReworkTarget(state, role, workflowRoles, coordinatorRole, decision.target)
      : null);

  if (candidate === "END") return "END";
  if (candidate && workflowRoles.includes(candidate)) return candidate;

  if (role === coordinatorRole) {
    const firstWorker = workflowRoles.find((item) => item !== coordinatorRole);
    return firstWorker ?? "END";
  }

  return coordinatorRole;
};

const publishRoleResponse = async (state: AgentState, role: string, content: string) => {
  const message = stripDecisionBlock(String(content ?? "")).trim();
  if (!message) return;

  await publishTeamEvent({
    roomKey: state.room_key ?? undefined,
    eventName: "chat.agent_response",
    scope: state.target_role === "All" ? "broadcast" : "targeted",
    senderRole: role,
    senderName: role,
    targetRole: state.target_role ?? role,
    payload: {
      message,
      role,
      agentName: role,
      coordinator: state.coordinator_role ?? null,
      source: "workflow",
      taskId: state.task_id,
    },
  });
};

const persistWorkflowState = async (state: AgentState) => {
  await saveWorkflowCheckpoint({
    taskId: state.task_id,
    officeId: state.office_id ?? null,
    roomKey: state.room_key ?? null,
    state,
    status: String(state.workflow_status ?? "running"),
    waitingForHuman: Boolean(state.waiting_for_human),
    currentAssignee: state.current_assignee ?? null,
  });
};

export const validatorNode = async (state: AgentState) => {
  const context = await loadRoleSkillContextFromDb(state.office_id ?? null);
  const workflowRoles = getWorkflowRoles(state, context);
  const coordinatorRole =
    normalizeRoleName(state.coordinator_role) ??
    normalizeRoleName(context.coordinatorRole) ??
    workflowRoles[0] ??
    DEFAULT_DYNAMIC_ROLE;
  const lastActor = normalizeRoleName(state.last_actor);
  const decisionStatus = String(state.task_status ?? state.route_status ?? "").trim().toLowerCase();

  if (
    !lastActor ||
    state.waiting_for_human ||
    state.workflow_status === "waiting_human" ||
    decisionStatus === "rejected" ||
    lastActor === coordinatorRole
  ) {
    await persistWorkflowState(state);
    return state;
  }

  await patchRoomState({
    roomKey: state.room_key ?? undefined,
    mode: "execution",
    taskStatus: "review",
    activeRole: lastActor,
    pendingTaskId: state.task_id,
    metadata: {
      officeId: state.office_id ?? null,
      validation: {
        state: "running",
        command: DEFAULT_VALIDATOR_COMMAND,
        actor: lastActor,
        startedAt: new Date().toISOString(),
      },
    },
  });

  const validation = await runSandboxValidationWithMcp(DEFAULT_VALIDATOR_COMMAND);
  const validationSummary = validation.passed
    ? `Validator passed via ${validation.toolName ?? "sandbox_execution"}`
    : `Validator failed via ${validation.toolName ?? "sandbox_execution"}`;
  const nextArtifacts = [
    ...(state.artifacts ?? []),
    {
      id: `${state.task_id}-validator-${Date.now()}`,
      role: "Validator",
      skill: validation.toolName ?? "sandbox_execution",
      status: validation.status,
      summary: validationSummary,
      content: validation.output,
      createdAt: new Date().toISOString(),
    },
  ];

  if (!validation.passed) {
    const reworkAssignee = lastActor;
    const basePending = uniqueRoles(state.pending_roles ?? []);
    const pendingRoles = uniqueRoles([reworkAssignee, ...basePending]);
    const nextSubTasks = syncSubTasks(
      ensureWorkflowSubTasks(state, workflowRoles),
      uniqueRoles(state.completed_roles ?? []).filter((role) => role !== reworkAssignee),
      reworkAssignee
    );
    const outputSnippet = validation.output.trim().slice(0, 1800);

    const nextState: AgentState = {
      ...state,
      artifacts: nextArtifacts,
      messages: [
        ...state.messages,
        {
          type: "ai",
          content: [
            `Validator: автоматическая проверка не пройдена (${validation.toolName ?? "sandbox_execution"}).`,
            outputSnippet,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
      next_agent: reworkAssignee,
      current_assignee: reworkAssignee,
      pending_roles: pendingRoles,
      sub_tasks: nextSubTasks,
      workflow_status: "running",
      waiting_for_human: false,
      human_decision: null,
      task_status: "rejected",
      route_status: "rejected",
    };

    await updateTaskState(nextState, "review", reworkAssignee, nextArtifacts);
    await patchRoomState({
      roomKey: state.room_key ?? undefined,
      mode: "execution",
      taskStatus: "review",
      activeRole: reworkAssignee,
      pendingTaskId: state.task_id,
      metadata: {
        officeId: state.office_id ?? null,
        validation: {
          state: "failed",
          tool: validation.toolName ?? null,
          failedAt: new Date().toISOString(),
        },
        currentAssignee: reworkAssignee,
        subTasks: nextSubTasks,
        artifacts: nextArtifacts,
      },
    });
    await publishTeamEvent({
      roomKey: state.room_key ?? undefined,
      eventName: "workflow.validation_failed",
      scope: "broadcast",
      senderRole: "Validator",
      senderName: "Validator",
      targetRole: reworkAssignee,
      payload: {
        taskId: state.task_id,
        toolName: validation.toolName,
        assignee: reworkAssignee,
        officeId: state.office_id ?? null,
      },
    });
    await persistWorkflowState(nextState);
    return nextState;
  }

  const currentAssignee =
    normalizeRoleName(state.current_assignee) ??
    normalizeRoleName(state.next_agent) ??
    null;
  const nextSubTasks = syncSubTasks(
    ensureWorkflowSubTasks(state, workflowRoles),
    uniqueRoles(state.completed_roles ?? []),
    currentAssignee
  );
  const nextState: AgentState = {
    ...state,
    artifacts: nextArtifacts,
    sub_tasks: nextSubTasks,
    task_status:
      state.next_agent === "END"
        ? "done"
        : String(state.task_status ?? "").trim().toLowerCase() === "done"
          ? "in_progress"
          : state.task_status,
    route_status:
      state.next_agent === "END"
        ? "done"
        : String(state.route_status ?? "").trim().toLowerCase() === "done"
          ? "in_progress"
          : state.route_status,
    workflow_status: state.next_agent === "END" ? "completed" : state.workflow_status ?? "running",
  };

  await updateTaskState(
    nextState,
    state.next_agent === "END" ? "done" : "in_progress",
    currentAssignee ?? lastActor,
    nextArtifacts
  );
  await patchRoomState({
    roomKey: state.room_key ?? undefined,
    mode: state.next_agent === "END" ? "discussion" : "execution",
    taskStatus: state.next_agent === "END" ? "done" : "in_progress",
    activeRole: currentAssignee ?? lastActor,
    pendingTaskId: state.next_agent === "END" ? null : state.task_id,
    metadata: {
      officeId: state.office_id ?? null,
      validation: {
        state: validation.status,
        tool: validation.toolName ?? null,
        passedAt: new Date().toISOString(),
      },
      currentAssignee,
      subTasks: nextSubTasks,
      artifacts: nextArtifacts,
    },
  });
  await publishTeamEvent({
    roomKey: state.room_key ?? undefined,
    eventName: "workflow.validation_passed",
    scope: "broadcast",
    senderRole: "Validator",
    senderName: "Validator",
    targetRole: state.target_role ?? "All",
    payload: {
      taskId: state.task_id,
      toolName: validation.toolName,
      officeId: state.office_id ?? null,
    },
  });

  if (nextState.next_agent === "END") {
    await setWorkflowIdleState(nextState, context, "Task completed. Team is ready for the next cycle.");
    await clearWorkflowCheckpoint(nextState.task_id, nextState.office_id ?? null);
    return nextState;
  }

  await persistWorkflowState(nextState);
  return nextState;
};

export const routeWorkflowState = (state: AgentState): string => {
  if (state.workflow_status === "completed" || normalizeRoleName(state.next_agent) === "END") {
    return "end";
  }
  if (state.waiting_for_human && !state.human_decision) {
    return "wait_human";
  }

  const routeStatus = String(state.task_status ?? state.route_status ?? "").trim().toLowerCase();
  if (routeStatus === "rejected") {
    const rejectedTarget = normalizeRoleName(state.current_assignee) ?? normalizeRoleName(state.next_agent);
    if (rejectedTarget && rejectedTarget !== "WAIT_HUMAN" && rejectedTarget !== "END") {
      return rejectedTarget;
    }
  }

  const nextAgent = normalizeRoleName(state.current_assignee) ?? normalizeRoleName(state.next_agent);
  if (!nextAgent || nextAgent === "WAIT_HUMAN") {
    return "wait_human";
  }
  if (nextAgent === "END") {
    return "end";
  }

  return nextAgent;
};

export const routerNode = async (state: AgentState) => {
  const context = await loadRoleSkillContextFromDb(state.office_id ?? null);
  const workflowRoles = getWorkflowRoles(state, context);
  const coordinatorRole =
    normalizeRoleName(state.coordinator_role) ??
    normalizeRoleName(context.coordinatorRole) ??
    workflowRoles[0] ??
    DEFAULT_DYNAMIC_ROLE;
  let pendingRoles = uniqueRoles(state.pending_roles ?? []);
  let nextAgent = normalizeRoleName(state.next_agent);
  let waitingForHuman = Boolean(state.waiting_for_human);
  let humanDecision = state.human_decision ?? null;
  let workflowStatus = state.workflow_status ?? "running";
  let currentAssignee = state.current_assignee ?? nextAgent;

  if (waitingForHuman && !humanDecision) {
    const nextState: AgentState = {
      ...state,
      workflow_roles: workflowRoles,
      coordinator_role: coordinatorRole,
      next_agent: "WAIT_HUMAN",
      current_assignee: currentAssignee,
      workflow_status: "waiting_human",
      waiting_for_human: true,
      sub_tasks: syncSubTasks(
        ensureWorkflowSubTasks(state, workflowRoles),
        uniqueRoles(state.completed_roles ?? []),
        state.last_actor ?? state.current_assignee ?? null
      ),
    };
    await persistWorkflowState(nextState);
    return nextState;
  }

  if (waitingForHuman && humanDecision) {
    if (humanDecision.action === "reject") {
      nextAgent =
        normalizeRoleName(humanDecision.target) ??
        normalizeRoleName(state.last_actor) ??
        coordinatorRole;
      workflowStatus = "running";
    } else {
      const [approvedNext, ...restQueue] = pendingRoles;
      pendingRoles = restQueue;
      nextAgent = approvedNext ?? "END";
      workflowStatus = nextAgent === "END" ? "completed" : "running";
    }

    waitingForHuman = false;
    humanDecision = null;
    currentAssignee = nextAgent === "END" ? null : nextAgent;
  }

  if (!nextAgent) {
    nextAgent = state.workflow_mode === "manual" ? pendingRoles[0] ?? workflowRoles[0] ?? "END" : coordinatorRole;
    currentAssignee = nextAgent === "END" ? null : nextAgent;
  }

  if (nextAgent !== "END" && nextAgent !== "WAIT_HUMAN" && !workflowRoles.includes(nextAgent)) {
    nextAgent =
      state.workflow_mode === "manual"
        ? workflowRoles[0] ?? "END"
        : workflowRoles.includes(coordinatorRole)
          ? coordinatorRole
          : workflowRoles[0] ?? "END";
    currentAssignee = nextAgent === "END" ? null : nextAgent;
  }

  const nextState: AgentState = {
    ...state,
    workflow_roles: workflowRoles,
    coordinator_role: coordinatorRole,
    pending_roles: pendingRoles,
    next_agent: nextAgent,
    current_assignee: currentAssignee,
    waiting_for_human: waitingForHuman,
    human_decision: humanDecision,
    workflow_status: nextAgent === "END" ? "completed" : workflowStatus,
    sub_tasks: syncSubTasks(
      ensureWorkflowSubTasks(state, workflowRoles),
      uniqueRoles(state.completed_roles ?? []),
      currentAssignee
    ),
  };

  await persistWorkflowState(nextState);
  return nextState;
};

export const waitForHumanNode = async (state: AgentState) => {
  const context = await loadRoleSkillContextFromDb(state.office_id ?? null);

  await patchRoomState({
    roomKey: state.room_key ?? undefined,
    mode: "approval",
    taskStatus: "review",
    activeRole: state.last_actor ?? state.current_assignee ?? null,
    pendingTaskId: state.task_id,
    metadata: {
      currentAssignee: state.current_assignee ?? null,
      officeId: state.office_id ?? null,
      waitingForHuman: true,
      subTasks: state.sub_tasks ?? [],
      artifacts: state.artifacts ?? [],
    },
  });

  await publishTeamEvent({
    roomKey: state.room_key ?? undefined,
    eventName: "workflow.paused_for_human",
    scope: "broadcast",
    senderRole: state.last_actor ?? state.current_assignee ?? null,
    senderName: state.last_actor ?? state.current_assignee ?? null,
    targetRole: "All",
    payload: {
      taskId: state.task_id,
      currentAssignee: state.current_assignee ?? null,
      officeId: state.office_id ?? null,
    },
  });

  await setWorkflowIdleState(state, context, "Waiting for human review.");
  await persistWorkflowState(state);

  return {
    ...state,
    iterations: state.iterations + 1,
  };
};

export const createRoleNode = (role: WorkflowRole) => async (state: AgentState) => {
  const context = await loadRoleSkillContextFromDb(state.office_id ?? null);
  const workflowRoles = getWorkflowRoles(state, context);
  const coordinatorRole =
    normalizeRoleName(state.coordinator_role) ??
    normalizeRoleName(context.coordinatorRole) ??
    workflowRoles[0] ??
    role ??
    DEFAULT_DYNAMIC_ROLE;
  const currentSkill = resolvePrimarySkill(context, role);
  const preparedSubTasks = syncSubTasks(
    ensureWorkflowSubTasks(state, workflowRoles),
    uniqueRoles(state.completed_roles ?? []),
    role
  );

  const action =
    context.agentProfiles[role]?.actionDescription ??
    FALLBACK_ROLE_ACTION_TEMPLATE.replace("%ROLE%", role);

  await setActiveRole(state, role, context, action, currentSkill, preparedSubTasks);
  await publishTeamEvent({
    roomKey: state.room_key ?? undefined,
    eventName: "workflow.stage_started",
    scope: "broadcast",
    senderRole: role,
    senderName: role,
    targetRole: state.target_role ?? "All",
    payload: {
      taskId: state.task_id,
      stage: role,
      officeId: state.office_id ?? null,
      currentAssignee: role,
      subTasks: preparedSubTasks,
    },
  });

  const messages = await getRecentMessages(state, role, context, workflowRoles, coordinatorRole);
  const response = await invokeAgentModel(role, messages, {
    officeId: state.office_id ?? null,
    role,
  });
  const decision = extractDecisionFromContent(response.content);
  const normalizedDecisionStatus = String(decision.status ?? "")
    .trim()
    .toLowerCase();
  const nextArtifacts = appendWorkflowArtifact(state, role, response.content, currentSkill, decision);
  const completedRoles = uniqueRoles([...(state.completed_roles ?? []), role]);

  let nextAgent: string | null = null;
  let waitingForHuman = false;
  let workflowStatus: AgentState["workflow_status"] = "running";
  let taskStatus: "in_progress" | "review" | "done" = "in_progress";
  let pendingRoles = uniqueRoles(state.pending_roles ?? []);
  let currentAssignee: string | null = null;

  if (state.workflow_mode === "manual") {
    const nextRoles = resolveManualNextRoles(state, role, decision, workflowRoles, coordinatorRole);
    pendingRoles = uniqueRoles(nextRoles);
    nextAgent = pendingRoles.length > 0 ? "WAIT_HUMAN" : "END";
    waitingForHuman = pendingRoles.length > 0;
    workflowStatus = waitingForHuman ? "waiting_human" : "completed";
    taskStatus = waitingForHuman ? "review" : "done";
    currentAssignee = waitingForHuman ? role : null;
  } else {
    if (normalizedDecisionStatus === "needs_human") {
      nextAgent = "WAIT_HUMAN";
      waitingForHuman = true;
      workflowStatus = "waiting_human";
      taskStatus = "review";
      currentAssignee = role;
    } else {
      nextAgent = resolveAutonomousNextRole(state, role, decision, workflowRoles, coordinatorRole);
      workflowStatus = nextAgent === "END" ? "completed" : "running";
      taskStatus =
        nextAgent === "END"
          ? "done"
          : normalizedDecisionStatus === "rejected"
            ? "review"
            : "in_progress";
      currentAssignee = nextAgent === "END" ? null : nextAgent;
    }
  }

  const nextSubTasks = syncSubTasks(
    preparedSubTasks,
    completedRoles,
    waitingForHuman ? role : currentAssignee
  );

  const nextState: AgentState = {
    ...state,
    messages: [...state.messages, { type: "ai", content: stripDecisionBlock(response.content) }],
    next_agent: nextAgent,
    artifacts: nextArtifacts,
    sub_tasks: nextSubTasks,
    current_assignee: currentAssignee,
    completed_roles: completedRoles,
    pending_roles: pendingRoles,
    coordinator_role: coordinatorRole,
    waiting_for_human: waitingForHuman,
    workflow_status: workflowStatus,
    human_decision: null,
    task_status: normalizedDecisionStatus || null,
    route_status: normalizedDecisionStatus || null,
    last_actor: role,
    iterations: state.iterations + 1,
  };

  await updateTaskState(nextState, taskStatus, waitingForHuman ? role : currentAssignee ?? role, nextArtifacts);
  await persistUsage(nextState, role, response.model, response.promptTokens, response.completionTokens);
  await publishRoleResponse(nextState, role, response.content);
  await patchRoomState({
    roomKey: state.room_key ?? undefined,
    metadata: {
      currentAssignee: waitingForHuman ? role : currentAssignee,
      currentSkill: currentSkill ?? null,
      subTasks: nextSubTasks,
      artifacts: nextArtifacts,
      officeId: state.office_id ?? null,
    },
  });
  await publishTeamEvent({
    roomKey: state.room_key ?? undefined,
    eventName: "workflow.stage_completed",
    scope: "broadcast",
    senderRole: role,
    senderName: role,
    targetRole: state.target_role ?? "All",
    payload: {
      taskId: state.task_id,
      stage: role,
      nextStage: nextAgent,
      officeId: state.office_id ?? null,
      currentAssignee: waitingForHuman ? role : currentAssignee,
      subTasks: nextSubTasks,
    },
  });

  if (waitingForHuman) {
    await setWorkflowIdleState(nextState, context, "Waiting for human review.");
    await persistWorkflowState(nextState);
  } else {
    await persistWorkflowState(nextState);
  }

  return nextState;
};
