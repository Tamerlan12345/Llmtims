import { AgentState } from "./graph";
import { AGENT_PROMPTS } from "./prompts";
import { invokeAgentModel } from "./tools";
import { supabaseServer as supabase } from "../supabase/server";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { buildRoleSkillsPromptBlock, loadRoleSkillContextFromDb, type AgentRole } from "./skillProfiles";
import {
  patchPlayerStateByRole,
  patchRoomState,
  publishTeamEvent,
  syncRoleTokenUsage,
  type TeamRole,
} from "./realtime";

// Helper to get formatted messages for LangGraph
const getRecentMessages = async (
  state: AgentState,
  role: "PM" | "Developer" | "QA" | "DevOps"
) => {
  const { roleSkills, skillCatalog } = await loadRoleSkillContextFromDb();
  const roleSkillPrompt = buildRoleSkillsPromptBlock(role as AgentRole, roleSkills, skillCatalog);

  return [
    new SystemMessage(`${AGENT_PROMPTS[role]}\n${roleSkillPrompt}`),
    ...state.messages.map(m => m.type === 'human' ? new HumanMessage(m.content) : new AIMessage(m.content))
  ];
};

const TEAM_ROLES: TeamRole[] = ["PM", "Developer", "QA", "DevOps"];

const setActiveRole = async (role: "PM" | "Developer" | "QA" | "DevOps", action?: string) => {
  try {
    await supabase.from("agents").update({ is_active: false }).in("role", ["PM", "Developer", "QA", "DevOps"]);
    await supabase.from("agents").update({ is_active: true }).eq("role", role);

    await patchRoomState({
      activeRole: role,
      metadata: { 
        lastActiveRoleAt: new Date().toISOString(),
        currentAction: action ?? `Анализ задачи...`
      },
    });

    await Promise.all(
      TEAM_ROLES.map((teamRole) =>
        patchPlayerStateByRole(teamRole, {
          status: teamRole === role ? "working" : "idle",
          isOnline: true,
          metadata: { source: "workflow" },
        })
      )
    );
  } catch (error) {
    console.error(`[Agents] Failed to set active role ${role}:`, error);
  }
};

const updateTaskState = async (
  taskId: string,
  status: "in_progress" | "review" | "waiting_approval" | "done" | "failed",
  role?: "PM" | "Developer" | "QA" | "DevOps"
) => {
  try {
    let assigneeId: string | null | undefined = undefined;
    if (role) {
      const { data: agent } = await supabase.from("agents").select("id").eq("role", role).single();
      assigneeId = agent?.id ?? null;
    }

    const payload: { status: string; updated_at: string; assignee_id?: string | null } = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (assigneeId !== undefined) {
      payload.assignee_id = assigneeId;
    }

    await supabase
      .from("tasks")
      .update(payload)
      .eq("id", taskId);

    await patchRoomState({
      taskStatus: status,
      activeRole: role ?? null,
      pendingTaskId: status === "done" ? null : taskId,
      mode: status === "waiting_approval" ? "approval" : status === "in_progress" ? "execution" : "discussion",
      metadata: { lastTaskStateUpdateAt: new Date().toISOString() },
    });
  } catch (error) {
    console.error(`[Tasks] Failed to update state ${status} for task ${taskId}:`, error);
  }
};

const persistUsage = async (
  taskId: string,
  role: "PM" | "Developer" | "QA" | "DevOps",
  model: string,
  promptTokens: number,
  completionTokens: number
) => {
  try {
    const totalTokens = promptTokens + completionTokens;
    const cost = Number(((totalTokens / 1000) * 0.001).toFixed(6));
    const { data: agent } = await supabase.from("agents").select("id").eq("role", role).single();

    await supabase.from("token_logs").insert({
      agent_id: agent?.id ?? null,
      task_id: taskId,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      model,
      cost,
    });

    if (agent?.id) {
      const { data: usageRows } = await supabase
        .from("token_logs")
        .select("prompt_tokens, completion_tokens")
        .eq("agent_id", agent.id);

      const aggregateTotal = (usageRows ?? []).reduce((sum, row) => {
        return sum + Number(row.prompt_tokens ?? 0) + Number(row.completion_tokens ?? 0);
      }, 0);

      await syncRoleTokenUsage(role, aggregateTotal);
    }
  } catch (error) {
    console.error(`[Usage] Failed to persist token usage for ${role}:`, error);
  }
};

export const pmNode = async (state: AgentState) => {
  console.log("PM Node: Planning...");
  await setActiveRole("PM", "PM анализирует требования и выбирает платформу (GitHub/Railway)...");
  await publishTeamEvent({
    eventName: "workflow.stage_started",
    scope: "broadcast",
    senderRole: "PM",
    senderName: "PM",
    targetRole: "All",
    payload: { taskId: state.task_id, stage: "PM" },
  });
  const messages = await getRecentMessages(state, "PM");
  const response = await invokeAgentModel("PM", messages);
  
  await updateTaskState(state.task_id, "in_progress", "PM");
  await persistUsage(
    state.task_id,
    "PM",
    response.model,
    response.promptTokens,
    response.completionTokens
  );
  await publishTeamEvent({
    eventName: "workflow.stage_completed",
    scope: "broadcast",
    senderRole: "PM",
    senderName: "PM",
    targetRole: "Developer",
    payload: { taskId: state.task_id, stage: "PM", nextStage: "Developer" },
  });

  return { 
    ...state, 
    messages: [...state.messages, { type: 'ai', content: response.content }],
    next_agent: "Developer" 
  };
};

export const devNode = async (state: AgentState) => {
  console.log("Dev Node: Implementing...");
  await setActiveRole("Developer", "Разработчик пишет код и проектирует архитектуру решения...");
  await publishTeamEvent({
    eventName: "workflow.stage_started",
    scope: "targeted",
    senderRole: "Developer",
    senderName: "Developer",
    targetRole: "Developer",
    payload: { taskId: state.task_id, stage: "Developer" },
  });
  const messages = await getRecentMessages(state, "Developer");
  const response = await invokeAgentModel("Developer", messages);
  await updateTaskState(state.task_id, "in_progress", "Developer");
  await persistUsage(
    state.task_id,
    "Developer",
    response.model,
    response.promptTokens,
    response.completionTokens
  );
  await publishTeamEvent({
    eventName: "workflow.stage_completed",
    scope: "targeted",
    senderRole: "Developer",
    senderName: "Developer",
    targetRole: "QA",
    payload: { taskId: state.task_id, stage: "Developer", nextStage: "QA" },
  });

  return { 
    ...state, 
    messages: [...state.messages, { type: 'ai', content: response.content }],
    next_agent: "QA" 
  };
};

export const qaNode = async (state: AgentState) => {
  console.log("QA Node: Validating...");
  await setActiveRole("QA", "QA-инженер проверяет регрессию, пишет автотесты и чеклисты...");
  await publishTeamEvent({
    eventName: "workflow.stage_started",
    scope: "targeted",
    senderRole: "QA",
    senderName: "QA",
    targetRole: "QA",
    payload: { taskId: state.task_id, stage: "QA" },
  });
  const messages = await getRecentMessages(state, "QA");
  const response = await invokeAgentModel("QA", messages);
  await updateTaskState(state.task_id, "review", "QA");
  await persistUsage(
    state.task_id,
    "QA",
    response.model,
    response.promptTokens,
    response.completionTokens
  );
  await publishTeamEvent({
    eventName: "workflow.stage_completed",
    scope: "targeted",
    senderRole: "QA",
    senderName: "QA",
    targetRole: "DevOps",
    payload: { taskId: state.task_id, stage: "QA", nextStage: "DevOps" },
  });

  return { 
    ...state, 
    messages: [...state.messages, { type: 'ai', content: response.content }],
    next_agent: "DevOps" 
  };
};

export const devOpsNode = async (state: AgentState) => {
  console.log("DevOps Node: Finalizing...");
  await setActiveRole("DevOps", "DevOps готовит инфраструктуру, деплоит проект и генерирует URL...");
  await publishTeamEvent({
    eventName: "workflow.stage_started",
    scope: "targeted",
    senderRole: "DevOps",
    senderName: "DevOps",
    targetRole: "DevOps",
    payload: { taskId: state.task_id, stage: "DevOps" },
  });
  const messages = await getRecentMessages(state, "DevOps");
  const response = await invokeAgentModel("DevOps", messages);
  await persistUsage(
    state.task_id,
    "DevOps",
    response.model,
    response.promptTokens,
    response.completionTokens
  );
  await updateTaskState(state.task_id, "done", "DevOps");
  await publishTeamEvent({
    eventName: "workflow.stage_completed",
    scope: "broadcast",
    senderRole: "DevOps",
    senderName: "DevOps",
    targetRole: "All",
    payload: { taskId: state.task_id, stage: "DevOps", nextStage: "END" },
  });

  return {
    ...state,
    messages: [...state.messages, { type: "ai", content: response.content }],
    next_agent: "END",
    iterations: state.iterations + 1,
  };
};
