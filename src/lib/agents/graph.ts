import { StateGraph } from "@langchain/langgraph";
import { pmNode, devNode, qaNode, devOpsNode } from "./nodes";

export interface AgentState {
  task_id: string;
  messages: any[];
  next_agent: string;
  artifacts: any[];
  iterations: number;
}

const workflow = new StateGraph<AgentState>({
  channels: {
    task_id: { value: null },
    messages: { value: null, default: () => [] },
    next_agent: { value: null, default: () => "PM" },
    artifacts: { value: null, default: () => [] },
    iterations: { value: null, default: () => 0 },
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
