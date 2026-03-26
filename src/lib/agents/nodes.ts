import { graph, AgentState } from "./graph";
import { AGENT_PROMPTS } from "./prompts";
import { llm } from "./tools";
import { supabase } from "../supabase/client";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

// Helper to get formatted messages for LangGraph
const getRecentMessages = (state: AgentState, role: keyof typeof AGENT_PROMPTS) => {
  return [
    new SystemMessage(AGENT_PROMPTS[role]),
    ...state.messages.map(m => m.type === 'human' ? new HumanMessage(m.content) : new AIMessage(m.content))
  ];
};

export const pmNode = async (state: AgentState) => {
  console.log("PM Node: Planning...");
  const messages = getRecentMessages(state, 'PM');
  const response = await llm.invoke(messages);
  
  // Update task in Supabase
  await supabase.from('tasks').update({ status: 'in_progress' }).eq('id', state.task_id);

  return { 
    ...state, 
    messages: [...state.messages, { type: 'ai', content: response.content }],
    next_agent: "Developer" 
  };
};

export const devNode = async (state: AgentState) => {
  console.log("Dev Node: Implementing...");
  const messages = getRecentMessages(state, 'Developer');
  const response = await llm.invoke(messages);

  return { 
    ...state, 
    messages: [...state.messages, { type: 'ai', content: response.content }],
    next_agent: "QA" 
  };
};

export const qaNode = async (state: AgentState) => {
  console.log("QA Node: Validating...");
  const messages = getRecentMessages(state, 'QA');
  const response = await llm.invoke(messages);

  // Logic: if approval needed, set status to 'waiting_approval'
  await supabase.from('tasks').update({ status: 'waiting_approval' }).eq('id', state.task_id);

  return { 
    ...state, 
    messages: [...state.messages, { type: 'ai', content: response.content }],
    next_agent: "END" 
  };
};

export const archivistNode = async (state: AgentState) => {
  console.log("Archivist Node: Summarizing...");
  // Implement summarization logic here if iterations > limit
  return state;
};
