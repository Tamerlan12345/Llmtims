import { END, StateGraph } from "@langchain/langgraph";
import {
  createRoleNode,
  routeWorkflowState,
  routerNode,
  waitForHumanNode,
  type WorkflowRole,
} from "./nodes";

export interface WorkflowArtifact {
  id: string;
  role: string;
  skill?: string | null;
  status?: string | null;
  summary: string;
  content?: string;
  createdAt: string;
}

export interface WorkflowEdge {
  from: string;
  to: string | null;
  condition?: string | null;
}

export interface WorkflowSubTask {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
  dependsOn?: string[];
}

export interface HumanDecision {
  action: "approve" | "reject";
  target?: string | null;
  note?: string | null;
  at?: string | null;
}

export interface AgentState {
  task_id: string;
  messages: Array<{ type: "human" | "ai"; content: string }>;
  next_agent: string | null;
  artifacts: WorkflowArtifact[];
  iterations: number;
  office_id?: string | null;
  room_key?: string | null;
  target_role?: string | null;
  sub_tasks?: WorkflowSubTask[];
  current_assignee?: string | null;
  workflow_mode?: "autonomous" | "manual" | string | null;
  workflow_roles?: WorkflowRole[];
  workflow_edges?: WorkflowEdge[];
  completed_roles?: string[];
  pending_roles?: string[];
  coordinator_role?: string | null;
  workflow_status?: "running" | "waiting_human" | "completed" | "failed" | string | null;
  waiting_for_human?: boolean;
  human_decision?: HumanDecision | null;
  last_actor?: string | null;
  router_notes?: string | null;
  route_status?: string | null;
  error_message?: string | null;
  [key: string]: unknown;
}

export const DEFAULT_WORKFLOW_ROLES: WorkflowRole[] = ["PM", "Developer", "QA", "DevOps"];

const createStateChannels = () => ({
  task_id: { value: null },
  messages: { value: null, default: () => [] },
  next_agent: { value: null, default: () => null },
  artifacts: { value: null, default: () => [] },
  iterations: { value: null, default: () => 0 },
  office_id: { value: null, default: () => null },
  room_key: { value: null, default: () => null },
  target_role: { value: null, default: () => "All" },
  sub_tasks: { value: null, default: () => [] },
  current_assignee: { value: null, default: () => null },
  workflow_mode: { value: null, default: () => "autonomous" },
  workflow_roles: { value: null, default: () => [...DEFAULT_WORKFLOW_ROLES] },
  workflow_edges: { value: null, default: () => [] },
  completed_roles: { value: null, default: () => [] },
  pending_roles: { value: null, default: () => [] },
  coordinator_role: { value: null, default: () => null },
  workflow_status: { value: null, default: () => "running" },
  waiting_for_human: { value: null, default: () => false },
  human_decision: { value: null, default: () => null },
  last_actor: { value: null, default: () => null },
  router_notes: { value: null, default: () => null },
  route_status: { value: null, default: () => null },
  error_message: { value: null, default: () => null },
});

const normalizeWorkflowRoles = (roles?: WorkflowRole[] | null): WorkflowRole[] => {
  const normalized = Array.from(
    new Set(
      (roles ?? [])
        .map((role) => (typeof role === "string" ? role.trim() : ""))
        .filter((role): role is string => role.length > 0)
    )
  );
  return normalized.length > 0 ? normalized : [...DEFAULT_WORKFLOW_ROLES];
};

export const buildDynamicAgentGraph = (roles?: WorkflowRole[] | null) => {
  const workflowRoles = normalizeWorkflowRoles(roles);
  const workflow = new StateGraph<AgentState>({
    channels: createStateChannels(),
  });

  workflow.addNode("router", routerNode);
  workflow.addNode("wait_human", waitForHumanNode);

  for (const role of workflowRoles) {
    workflow.addNode(role, createRoleNode(role));
    workflow.addEdge(role, "router");
  }

  workflow.addEdge("wait_human", END);
  workflow.addConditionalEdges(
    "router",
    routeWorkflowState,
    Object.fromEntries([
      ...workflowRoles.map((role) => [role, role]),
      ["wait_human", "wait_human"],
      ["end", END],
    ])
  );
  workflow.setEntryPoint("router");

  return workflow.compile();
};

export const graph = buildDynamicAgentGraph(DEFAULT_WORKFLOW_ROLES);
