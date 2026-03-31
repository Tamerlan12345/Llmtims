import { StateGraph } from "@langchain/langgraph";
import { createWorkflowNode, type WorkflowRole } from "./nodes";

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
  workflow_mode?: "autonomous" | "manual" | string | null;
  workflow_roles?: WorkflowRole[];
}

export const DEFAULT_WORKFLOW_ROLES: WorkflowRole[] = ["PM", "Developer", "QA", "DevOps"];

const createStateChannels = () => ({
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
  workflow_mode: { value: null, default: () => "autonomous" },
  workflow_roles: { value: null, default: () => [...DEFAULT_WORKFLOW_ROLES] },
});

const normalizeWorkflowRoles = (roles?: WorkflowRole[] | null): WorkflowRole[] => {
  const normalized = Array.from(
    new Set((roles ?? []).filter((role): role is WorkflowRole => DEFAULT_WORKFLOW_ROLES.includes(role)))
  );
  return normalized.length > 0 ? normalized : [...DEFAULT_WORKFLOW_ROLES];
};

export const buildDynamicAgentGraph = (roles?: WorkflowRole[] | null) => {
  const orderedRoles = normalizeWorkflowRoles(roles);
  const workflow = new StateGraph<AgentState>({
    channels: createStateChannels(),
  });

  orderedRoles.forEach((role, index) => {
    const nextRole = orderedRoles[index + 1] ?? "END";
    workflow.addNode(role, createWorkflowNode(role, nextRole, index));
  });

  orderedRoles.forEach((role, index) => {
    const nextRole = orderedRoles[index + 1];
    if (nextRole) {
      workflow.addEdge(role, nextRole);
    }
  });

  workflow.setEntryPoint(orderedRoles[0]);
  workflow.setFinishPoint(orderedRoles[orderedRoles.length - 1]);

  return workflow.compile();
};

export const graph = buildDynamicAgentGraph(DEFAULT_WORKFLOW_ROLES);
