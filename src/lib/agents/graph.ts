import { StateGraph } from "@langchain/langgraph";
import { pmNode, devNode, qaNode, devOpsNode } from "./nodes";

export interface AgentState {
  task_id: string;
  messages: any[];
  next_agent: string;
  artifacts: any[];
  iterations: number;
  office_id?: string | null;
  room_key?: string | null;
  target_role?: string | null;
  sub_tasks?: Array<{ id: string; title: string; status: string; assignee?: string | null }>;
  current_assignee?: string | null;
}

const workflow = new StateGraph<AgentState>({
  channels: {
    task_id: { value: null },
    messages: { value: null, default: () => [] },
    next_agent: { value: null, default: () => "PM" },
    artifacts: { value: null, default: () => [] },
    iterations: { value: null, default: () => 0 },
    office_id: { value: null, default: () => null },
    room_key: { value: null, default: () => null },
    target_role: { value: null, default: () => "All" },
    sub_tasks: { value: null, default: () => [] },
    current_assignee: { value: null, default: () => "PM" },
  },
});

workflow.addNode("PM", pmNode);
workflow.addNode("Developer", devNode);
workflow.addNode("QA", qaNode);
workflow.addNode("DevOps", devOpsNode);
workflow.addEdge("PM", "Developer");
workflow.addEdge("Developer", "QA");
workflow.addEdge("QA", "DevOps");
workflow.setEntryPoint("PM");
workflow.setFinishPoint("DevOps");

// Compile with checkpointer for persistence
export const graph = workflow.compile();
