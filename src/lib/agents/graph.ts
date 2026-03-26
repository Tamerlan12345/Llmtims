import { StateGraph } from "@langchain/langgraph";
import { pmNode, devNode, qaNode } from "./nodes";
import { checkpointer } from "./persistence";

export interface AgentState {
  task_id: string;
  messages: any[];
  next_agent: string;
  artifacts: any[];
  iterations: number;
}

const workflow = new StateGraph<AgentState>({
  channels: {
    task_id: null,
    messages: null,
    next_agent: null,
    artifacts: null,
    iterations: null,
  },
})
  .addNode("PM", pmNode)
  .addNode("Developer", devNode)
  .addNode("QA", qaNode)
  .addEdge("PM", "Developer")
  .addEdge("Developer", "QA")
  .setEntryPoint("PM");

// Compile with checkpointer for persistence
export const graph = workflow.compile({
  checkpointer: checkpointer
});
