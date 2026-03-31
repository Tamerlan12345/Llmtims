import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentState } from "./graph";
import { AGENT_PROMPTS } from "./prompts";
import { buildRoleSkillsPromptBlock, loadRoleSkillContextFromDb, type AgentRole } from "./skillProfiles";
import { invokeAgentModel } from "./tools";
import { supabaseServer as supabase } from "../supabase/server";
import {
  patchAgentRuntimeByRole,
  patchPlayerStateByRole,
  patchRoomState,
  publishTeamEvent,
  syncRoleTokenUsage,
  type TeamRole,
  type TeamEventScope,
} from "./realtime";

type WorkflowRole = "PM" | "Developer" | "QA" | "DevOps";
type WorkflowSubTask = NonNullable<AgentState["sub_tasks"]>[number];

const TEAM_ROLES: TeamRole[] = ["PM", "Developer", "QA", "DevOps"];
const IDLE_WORKFLOW_ACTION = "Awaiting the next autonomous task.";
const WORKFLOW_TARGETS: Record<WorkflowRole, { x: number; y: number }> = {
  PM: { x: 21, y: 47 },
  Developer: { x: 79, y: 47 },
  QA: { x: 21, y: 81 },
  DevOps: { x: 79, y: 81 },
};
const WORKFLOW_STAGE_TITLES: Record<WorkflowRole, string> = {
  PM: "Plan and delegate the office task",
  Developer: "Implement the agreed solution",
  QA: "Review and validate the result",
  DevOps: "Release, monitor, and finalize delivery",
};

const ensureWorkflowSubTasks = (state: AgentState): WorkflowSubTask[] => {
  if (Array.isArray(state.sub_tasks) && state.sub_tasks.length > 0) {
    return state.sub_tasks;
  }

  return (TEAM_ROLES as WorkflowRole[]).map((role, index) => ({
    id: `${state.task_id}-${index + 1}-${role.toLowerCase()}`,
    title: WORKFLOW_STAGE_TITLES[role],
    status: role === "PM" ? "in_progress" : "pending",
    assignee: role,
  }));
};

const activateWorkflowStage = (
  subTasks: WorkflowSubTask[],
  activeRole: WorkflowRole
): WorkflowSubTask[] => {
  return subTasks.map((subTask) => {
    if (subTask.assignee === activeRole) {
      return { ...subTask, status: "in_progress" };
    }
    if (subTask.status === "done") {
      return subTask;
    }
    return { ...subTask, status: "pending" };
  });
};

const advanceWorkflowSubTasks = (
  subTasks: WorkflowSubTask[],
  completedRole: WorkflowRole,
  nextRole: string
): WorkflowSubTask[] => {
  return subTasks.map((subTask) => {
    if (subTask.assignee === completedRole) {
      return { ...subTask, status: "done" };
    }
    if (nextRole !== "END" && subTask.assignee === nextRole) {
      return { ...subTask, status: "in_progress" };
    }
    if (subTask.status === "done") {
      return subTask;
    }
    return { ...subTask, status: "pending" };
  });
};

const getRecentMessages = async (state: AgentState, role: WorkflowRole) => {
  const { roleSkills, skillCatalog } = await loadRoleSkillContextFromDb(state.office_id ?? null);
  const roleSkillPrompt = buildRoleSkillsPromptBlock(role as AgentRole, roleSkills, skillCatalog);

  return [
    new SystemMessage(`${AGENT_PROMPTS[role]}\n${roleSkillPrompt}`),
    ...state.messages.map((message) =>
      message.type === "human" ? new HumanMessage(message.content) : new AIMessage(message.content)
    ),
  ];
};

const resolvePrimarySkill = async (
  state: AgentState,
  role: WorkflowRole
): Promise<string | null> => {
  const { roleSkills, skillCatalog } = await loadRoleSkillContextFromDb(state.office_id ?? null);
  const primarySkillName = roleSkills[role as AgentRole]?.[0];
  if (!primarySkillName) return null;
  return skillCatalog[primarySkillName]?.displayName ?? primarySkillName;
};

const resolveAgentQueryByRole = (role: WorkflowRole, officeId?: string | null) => {
  let query = supabase.from("agents").select("id, role, name").eq("role", role);
  if (officeId) {
    query = query.eq("office_id", officeId);
  }
  return query;
};

const resolveResponseScope = (state: AgentState, fallback: TeamEventScope): TeamEventScope => {
  return state.target_role === "All" ? "broadcast" : fallback;
};

const resolveResponseTargetRole = (state: AgentState, role: WorkflowRole): TeamRole => {
  const targetRole = state.target_role;
  if (targetRole === "PM" || targetRole === "Developer" || targetRole === "QA" || targetRole === "DevOps" || targetRole === "All") {
    return targetRole;
  }
  return role;
};

const publishRoleResponse = async (state: AgentState, role: WorkflowRole, content: string) => {
  const message = String(content ?? "").trim();
  if (!message) return;

  await publishTeamEvent({
    roomKey: state.room_key ?? undefined,
    eventName: "chat.agent_response",
    scope: resolveResponseScope(state, role === "PM" ? "broadcast" : "targeted"),
    senderRole: role,
    senderName: role,
    targetRole: resolveResponseTargetRole(state, role),
    payload: {
      message,
      role,
      agentName: role,
      coordinator: "PM",
      source: "workflow",
      taskId: state.task_id,
    },
  });
};

const setActiveRole = async (
  state: AgentState,
  role: WorkflowRole,
  action?: string,
  currentSkill?: string | null,
  subTasks: WorkflowSubTask[] = []
) => {
  try {
    let deactivateQuery = supabase
      .from("agents")
      .update({ is_active: false })
      .in("role", ["PM", "Developer", "QA", "DevOps"]);
    let activateQuery = supabase.from("agents").update({ is_active: true }).eq("role", role);

    if (state.office_id) {
      deactivateQuery = deactivateQuery.eq("office_id", state.office_id);
      activateQuery = activateQuery.eq("office_id", state.office_id);
    }

    await deactivateQuery;
    await activateQuery;

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
      TEAM_ROLES.map(async (teamRole) => {
        const target = WORKFLOW_TARGETS[teamRole as WorkflowRole];
        await patchPlayerStateByRole(teamRole, {
          roomKey: state.room_key ?? undefined,
          officeId: state.office_id ?? null,
          status: teamRole === role ? "working" : "idle",
          isOnline: true,
          metadata: { source: "workflow", officeId: state.office_id ?? null },
        });
        await patchAgentRuntimeByRole(teamRole, {
          officeId: state.office_id ?? null,
          status: teamRole === role ? "working" : "idle",
          currentAction: teamRole === role ? action ?? "Working on task..." : IDLE_WORKFLOW_ACTION,
          currentSkill: teamRole === role ? currentSkill ?? null : null,
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
    console.error(`[Agents] Failed to set active role ${role}:`, error);
  }
};

const updateTaskState = async (
  state: AgentState,
  status: "in_progress" | "review" | "waiting_approval" | "done" | "failed",
  role?: WorkflowRole
) => {
  try {
    let assigneeId: string | null | undefined = undefined;
    if (role) {
      const { data: agent } = await resolveAgentQueryByRole(role, state.office_id ?? null).maybeSingle();
      assigneeId = agent?.id ?? null;
    }

    const payload: { status: string; updated_at: string; assignee_id?: string | null } = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (assigneeId !== undefined) {
      payload.assignee_id = assigneeId;
    }

    let taskQuery = supabase.from("tasks").update(payload).eq("id", state.task_id);
    if (state.office_id) {
      taskQuery = taskQuery.eq("office_id", state.office_id);
    }
    await taskQuery;

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
    console.error(`[Tasks] Failed to update state ${status} for task ${state.task_id}:`, error);
  }
};

const persistUsage = async (
  state: AgentState,
  role: WorkflowRole,
  model: string,
  promptTokens: number,
  completionTokens: number
) => {
  try {
    const totalTokens = promptTokens + completionTokens;
    const cost = Number(((totalTokens / 1000) * 0.001).toFixed(6));
    const { data: agent } = await resolveAgentQueryByRole(role, state.office_id ?? null).maybeSingle();

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
    console.error(`[Usage] Failed to persist token usage for ${role}:`, error);
  }
};

const setWorkflowIdleState = async (state: AgentState, action: string) => {
  await Promise.all(
    (TEAM_ROLES as WorkflowRole[]).map(async (role) => {
      const target = WORKFLOW_TARGETS[role];
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

const runRoleStep = async (
  state: AgentState,
  {
    role,
    action,
    scope,
    targetRole,
    nextRole,
    statusAfter,
  }: {
    role: WorkflowRole;
    action: string;
    scope: TeamEventScope;
    targetRole: TeamRole;
    nextRole: string;
    statusAfter: "in_progress" | "review" | "done";
  }
) => {
  const preparedSubTasks = activateWorkflowStage(ensureWorkflowSubTasks(state), role);
  const currentSkill = await resolvePrimarySkill(state, role);

  await setActiveRole(state, role, action, currentSkill, preparedSubTasks);
  await publishTeamEvent({
    roomKey: state.room_key ?? undefined,
    eventName: "workflow.stage_started",
    scope,
    senderRole: role,
    senderName: role,
    targetRole,
    payload: {
      taskId: state.task_id,
      stage: role,
      officeId: state.office_id ?? null,
      currentAssignee: role,
      subTasks: preparedSubTasks,
    },
  });

  const messages = await getRecentMessages(state, role);
  const response = await invokeAgentModel(role, messages, {
    officeId: state.office_id ?? null,
  });
  const nextSubTasks = advanceWorkflowSubTasks(preparedSubTasks, role, nextRole);

  await updateTaskState(state, statusAfter, role);
  await persistUsage(state, role, response.model, response.promptTokens, response.completionTokens);
  await publishRoleResponse(state, role, response.content);
  await patchRoomState({
    roomKey: state.room_key ?? undefined,
    metadata: {
      currentAssignee: nextRole === "END" ? null : nextRole,
      currentSkill: currentSkill ?? null,
      subTasks: nextSubTasks,
      officeId: state.office_id ?? null,
    },
  });
  await publishTeamEvent({
    roomKey: state.room_key ?? undefined,
    eventName: "workflow.stage_completed",
    scope,
    senderRole: role,
    senderName: role,
    targetRole: nextRole === "END" ? "All" : targetRole,
    payload: {
      taskId: state.task_id,
      stage: role,
      nextStage: nextRole,
      officeId: state.office_id ?? null,
      currentAssignee: nextRole === "END" ? null : nextRole,
      subTasks: nextSubTasks,
    },
  });

  return {
    ...state,
    messages: [...state.messages, { type: "ai", content: response.content }],
    next_agent: nextRole,
    sub_tasks: nextSubTasks,
    current_assignee: nextRole === "END" ? null : nextRole,
  };
};

export const pmNode = async (state: AgentState) => {
  console.log("PM Node: Planning...");
  return runRoleStep(state, {
    role: "PM",
    action: "PM coordinates scope, priorities, and execution plan.",
    scope: "broadcast",
    targetRole: "All",
    nextRole: "Developer",
    statusAfter: "in_progress",
  });
};

export const devNode = async (state: AgentState) => {
  console.log("Dev Node: Implementing...");
  return runRoleStep(state, {
    role: "Developer",
    action: "Developer implements the agreed technical path.",
    scope: "targeted",
    targetRole: "Developer",
    nextRole: "QA",
    statusAfter: "in_progress",
  });
};

export const qaNode = async (state: AgentState) => {
  console.log("QA Node: Validating...");
  return runRoleStep(state, {
    role: "QA",
    action: "QA validates regression, edge cases, and readiness.",
    scope: "targeted",
    targetRole: "QA",
    nextRole: "DevOps",
    statusAfter: "review",
  });
};

export const devOpsNode = async (state: AgentState) => {
  console.log("DevOps Node: Finalizing...");
  const nextState = await runRoleStep(state, {
    role: "DevOps",
    action: "DevOps prepares runtime environment, delivery, and release notes.",
    scope: "targeted",
    targetRole: "DevOps",
    nextRole: "END",
    statusAfter: "done",
  });
  await setWorkflowIdleState(nextState, "Task completed. Team is ready for the next autonomous cycle.");

  return {
    ...nextState,
    iterations: state.iterations + 1,
  };
};
