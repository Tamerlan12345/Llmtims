import { AgentState } from "./graph";
import { AGENT_PROMPTS } from "./prompts";
import { invokeAgentModel } from "./tools";
import { supabaseServer as supabase } from "../supabase/server";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

// Helper to get formatted messages for LangGraph
const getRecentMessages = (state: AgentState, role: keyof typeof AGENT_PROMPTS) => {
  return [
    new SystemMessage(AGENT_PROMPTS[role]),
    ...state.messages.map(m => m.type === 'human' ? new HumanMessage(m.content) : new AIMessage(m.content))
  ];
};

const setActiveRole = async (role: "PM" | "Developer" | "QA" | "DevOps") => {
  try {
    await supabase.from("agents").update({ is_active: false }).in("role", ["PM", "Developer", "QA", "DevOps"]);
    await supabase.from("agents").update({ is_active: true }).eq("role", role);
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
  } catch (error) {
    console.error(`[Usage] Failed to persist token usage for ${role}:`, error);
  }
};

export const pmNode = async (state: AgentState) => {
  console.log("PM Node: Planning...");
  await setActiveRole("PM");
  const messages = getRecentMessages(state, 'PM');
  const response = await invokeAgentModel("PM", messages);
  
  await updateTaskState(state.task_id, "in_progress", "PM");
  await persistUsage(
    state.task_id,
    "PM",
    response.model,
    response.promptTokens,
    response.completionTokens
  );

  return { 
    ...state, 
    messages: [...state.messages, { type: 'ai', content: response.content }],
    next_agent: "Developer" 
  };
};

export const devNode = async (state: AgentState) => {
  console.log("Dev Node: Implementing...");
  await setActiveRole("Developer");
  const messages = getRecentMessages(state, 'Developer');
  const response = await invokeAgentModel("Developer", messages);
  await updateTaskState(state.task_id, "in_progress", "Developer");
  await persistUsage(
    state.task_id,
    "Developer",
    response.model,
    response.promptTokens,
    response.completionTokens
  );

  return { 
    ...state, 
    messages: [...state.messages, { type: 'ai', content: response.content }],
    next_agent: "QA" 
  };
};

export const qaNode = async (state: AgentState) => {
  console.log("QA Node: Validating...");
  await setActiveRole("QA");
  const messages = getRecentMessages(state, 'QA');
  const response = await invokeAgentModel("QA", messages);
  await updateTaskState(state.task_id, "review", "QA");
  await persistUsage(
    state.task_id,
    "QA",
    response.model,
    response.promptTokens,
    response.completionTokens
  );

  return { 
    ...state, 
    messages: [...state.messages, { type: 'ai', content: response.content }],
    next_agent: "DevOps" 
  };
};

export const devOpsNode = async (state: AgentState) => {
  console.log("DevOps Node: Finalizing...");
  await setActiveRole("DevOps");
  const messages = getRecentMessages(state, "DevOps");
  const response = await invokeAgentModel("DevOps", messages);
  await persistUsage(
    state.task_id,
    "DevOps",
    response.model,
    response.promptTokens,
    response.completionTokens
  );
  await updateTaskState(state.task_id, "done", "DevOps");

  return {
    ...state,
    messages: [...state.messages, { type: "ai", content: response.content }],
    next_agent: "END",
    iterations: state.iterations + 1,
  };
};
