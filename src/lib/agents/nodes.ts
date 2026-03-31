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
import { invokeAgentModel } from "./tools";
import { supabaseServer as supabase } from "../supabase/server";
import {
  patchAgentRuntimeByRole,
  patchPlayerStateByRole,
  patchRoomState,
  publishTeamEvent,
  syncRoleTokenUsage,
} from "./realtime";

export type WorkflowRole = string;

interface ParsedDecision {
  status?: string | null;
  next_agent?: string | null;
  target?: string | null;
  summary?: string | null;
  sub_tasks?: WorkflowSubTask[];
}

const IDLE_WORKFLOW_ACTION = "Awaiting the next office task.";

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

const getWorkflowRoles = (state: AgentState, context: RoleSkillContext): string[] => {
  const configured = Array.isArray(state.workflow_roles) ? uniqueRoles(state.workflow_roles) : [];
  if (configured.length > 0) return configured;

  const contextRoles = uniqueRoles(context.availableRoles);
  return contextRoles.length > 0 ? contextRoles : ["PM"];
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
    return "=== PROJECT ARTIFACTS ===\nNo previous project artifacts were stored yet.";
  }

  return [
    "=== PROJECT ARTIFACTS ===",
    artifacts
      .map((artifact) => {
        const role = normalizeRoleName(artifact.role) ?? "unknown";
        const content =
          typeof artifact.content === "string" && artifact.content.trim().length > 0
            ? artifact.content
            : artifact.summary;
        return `<artifact role="${role}">\n${content}\n</artifact>`;
      })
      .join("\n"),
  ].join("\n");
};

const buildRouterInstruction = (role: string, workflowRoles: string[], coordinatorRole: string): string => {
  if (role !== coordinatorRole) {
    return [
      "Return the work result first.",
      "After the result, append one fenced JSON block with this schema:",
      '```json',
      '{"status":"completed|rejected|needs_human|done","target":"Role|null","next_agent":"Role|END|null","summary":"short summary"}',
      '```',
      "Use status=rejected only when work must go back for rework.",
      "Use status=needs_human only when a human reviewer must decide before the workflow continues.",
      "Do not invent roles outside the available office roster.",
    ].join("\n");
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
  agentProfile?: OfficeAgentProfile | null
) => {
  const rolePrompt = buildRoleSkillsPromptBlock(
    role as AgentRole,
    context.roleSkills,
    context.skillCatalog,
    agentProfile
  );
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
    buildArtifactsPrompt(state),
    buildRouterInstruction(role, workflowRoles, coordinatorRole),
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
  const systemPrompt = buildBaseRolePrompt(
    role,
    coordinatorRole,
    workflowRoles,
    state,
    context,
    agentProfile
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

const resolveAgentByRole = async (role: string, officeId?: string | null) => {
  let query = supabase.from("agents").select("id, role, name").eq("role", role);
  if (officeId) {
    query = query.eq("office_id", officeId);
  }

  const { data, error } = await query.limit(1);
  if (error) {
    console.error(`[agents] failed to resolve agent for ${role}:`, error);
    return null;
  }

  return Array.isArray(data) ? data[0] ?? null : null;
};

const resolveProfileTarget = (profile?: OfficeAgentProfile | null) => {
  return {
    x: profile?.defaultX ?? null,
    y: profile?.defaultY ?? null,
    action: profile?.actionDescription ?? null,
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
        currentAction: action ?? "Working on task...",
        currentSkill: currentSkill ?? null,
        currentAssignee: role,
        subTasks,
        officeId: state.office_id ?? null,
      },
    });

    await Promise.all(
      getWorkflowRoles(state, context).map(async (teamRole) => {
        const profile = context.agentProfiles[teamRole] ?? null;
        const target = resolveProfileTarget(profile);
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
          currentAction: active ? action ?? target.action ?? "Working on task..." : IDLE_WORKFLOW_ACTION,
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
      })
    );
  } catch (error) {
    console.error(`[agents] failed to set active role ${role}:`, error);
  }
};

const setWorkflowIdleState = async (
  state: AgentState,
  context: RoleSkillContext,
  action: string
) => {
  await Promise.all(
    getWorkflowRoles(state, context).map(async (role) => {
      const profile = context.agentProfiles[role] ?? null;
      const target = resolveProfileTarget(profile);

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
    })
  );
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

const resolveManualNextRoles = (
  state: AgentState,
  role: string,
  decision: ParsedDecision,
  workflowRoles: string[]
) => {
  if (decision.status === "rejected") {
    const target = normalizeRoleName(decision.target);
    if (target) return [target];
  }

  const edges = Array.isArray(state.workflow_edges) ? state.workflow_edges : [];
  const outgoing = edges
    .filter((edge) => normalizeRoleName(edge.from) === role)
    .filter((edge) => {
      const condition = String(edge.condition ?? "approve").trim().toLowerCase();
      if (decision.status === "rejected") {
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
  role: string,
  decision: ParsedDecision,
  workflowRoles: string[],
  coordinatorRole: string
) => {
  if (decision.status === "done") {
    return "END";
  }

  const candidate =
    normalizeRoleName(decision.next_agent) ??
    (decision.status === "rejected" ? normalizeRoleName(decision.target) : null);

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

export const routeWorkflowState = (state: AgentState): string => {
  if (state.workflow_status === "completed" || state.next_agent === "END") {
    return "end";
  }
  if (state.waiting_for_human && !state.human_decision) {
    return "wait_human";
  }

  const nextAgent = normalizeRoleName(state.next_agent);
  if (!nextAgent || nextAgent === "WAIT_HUMAN") {
    return "wait_human";
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
    "PM";
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
    role;
  const currentSkill = resolvePrimarySkill(context, role);
  const preparedSubTasks = syncSubTasks(
    ensureWorkflowSubTasks(state, workflowRoles),
    uniqueRoles(state.completed_roles ?? []),
    role
  );

  const action =
    context.agentProfiles[role]?.actionDescription ??
    `${role} is processing the current office task.`;

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
  const nextArtifacts = appendWorkflowArtifact(state, role, response.content, currentSkill, decision);
  const completedRoles = uniqueRoles([...(state.completed_roles ?? []), role]);

  let nextAgent: string | null = null;
  let waitingForHuman = false;
  let workflowStatus: AgentState["workflow_status"] = "running";
  let taskStatus: "in_progress" | "review" | "done" = "in_progress";
  let pendingRoles = uniqueRoles(state.pending_roles ?? []);
  let currentAssignee: string | null = null;

  if (state.workflow_mode === "manual") {
    const nextRoles = resolveManualNextRoles(state, role, decision, workflowRoles);
    pendingRoles = uniqueRoles(nextRoles);
    nextAgent = pendingRoles.length > 0 ? "WAIT_HUMAN" : "END";
    waitingForHuman = pendingRoles.length > 0;
    workflowStatus = waitingForHuman ? "waiting_human" : "completed";
    taskStatus = waitingForHuman ? "review" : "done";
    currentAssignee = waitingForHuman ? role : null;
  } else {
    if (decision.status === "needs_human") {
      nextAgent = "WAIT_HUMAN";
      waitingForHuman = true;
      workflowStatus = "waiting_human";
      taskStatus = "review";
      currentAssignee = role;
    } else {
      nextAgent = resolveAutonomousNextRole(role, decision, workflowRoles, coordinatorRole);
      workflowStatus = nextAgent === "END" ? "completed" : "running";
      taskStatus =
        nextAgent === "END"
          ? "done"
          : decision.status === "rejected"
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

  if (nextAgent === "END") {
    await setWorkflowIdleState(nextState, context, "Task completed. Team is ready for the next cycle.");
    await clearWorkflowCheckpoint(nextState.task_id, nextState.office_id ?? null);
  } else if (waitingForHuman) {
    await setWorkflowIdleState(nextState, context, "Waiting for human review.");
    await persistWorkflowState(nextState);
  } else {
    await persistWorkflowState(nextState);
  }

  return nextState;
};
