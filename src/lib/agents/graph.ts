import { END, StateGraph } from "@langchain/langgraph";
import {
  createRoleNode,
  routeWorkflowState,
  routerNode,
  waitForHumanNode,
  type WorkflowRole,
} from "./nodes";
import { checkpointer as officeCheckpointer } from "./persistence";

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
  task_status?: string | null;
  error_message?: string | null;
  [key: string]: unknown;
}

interface BuildDynamicAgentGraphOptions {
  workflowMode?: string | null;
  workflowStatus?: string | null;
  checkpointer?: unknown;
}

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
  workflow_roles: { value: null, default: () => [] },
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
  task_status: { value: null, default: () => null },
  error_message: { value: null, default: () => null },
});

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

const normalizeWorkflowRoles = (roles?: WorkflowRole[] | null): WorkflowRole[] => {
  return uniqueRoles(Array.isArray(roles) ? roles : []);
};

const resolveRejectedFallbackRole = (
  state: AgentState,
  currentRole: string,
  workflowRoles: string[]
): string | null => {
  const lastActor = normalizeRoleName(state.last_actor);
  if (lastActor && lastActor !== currentRole && workflowRoles.includes(lastActor)) {
    return lastActor;
  }

  if (Array.isArray(state.sub_tasks)) {
    const orderedSubTaskRoles = state.sub_tasks
      .map((subTask) => normalizeRoleName(subTask.assignee))
      .filter((role): role is string => Boolean(role));
    const currentIndex = orderedSubTaskRoles.lastIndexOf(currentRole);
    if (currentIndex > 0) {
      const previousRole = orderedSubTaskRoles[currentIndex - 1];
      if (previousRole && workflowRoles.includes(previousRole)) {
        return previousRole;
      }
    }
  }

  const byOrderIndex = workflowRoles.indexOf(currentRole);
  if (byOrderIndex > 0) {
    return workflowRoles[byOrderIndex - 1];
  }

  const completedRoles = uniqueRoles(Array.isArray(state.completed_roles) ? state.completed_roles : []);
  for (let index = completedRoles.length - 1; index >= 0; index -= 1) {
    const completedRole = completedRoles[index];
    if (completedRole !== currentRole && workflowRoles.includes(completedRole)) {
      return completedRole;
    }
  }

  return null;
};

const routeFromRoleState = (
  state: AgentState,
  currentRole: string,
  workflowRoles: string[]
): string => {
  const normalizedTaskStatus = String(state.task_status ?? state.route_status ?? "")
    .trim()
    .toLowerCase();
  const nextAgent = normalizeRoleName(state.next_agent);
  const currentAssignee = normalizeRoleName(state.current_assignee);

  if (state.workflow_status === "completed" || nextAgent === "END") {
    return "end";
  }

  if (state.waiting_for_human && !state.human_decision) {
    return "wait_human";
  }

  if (normalizedTaskStatus === "rejected") {
    if (currentAssignee && workflowRoles.includes(currentAssignee)) {
      return currentAssignee;
    }

    const fallbackRole = resolveRejectedFallbackRole(state, currentRole, workflowRoles);
    if (fallbackRole) {
      return fallbackRole;
    }
  }

  if (currentAssignee && workflowRoles.includes(currentAssignee)) {
    return currentAssignee;
  }

  const routeFromState = routeWorkflowState(state);
  if (routeFromState === "end" || routeFromState === "wait_human") {
    return routeFromState;
  }
  if (workflowRoles.includes(routeFromState)) {
    return routeFromState;
  }

  return "router";
};

const routeFromRouterState = (state: AgentState, workflowRoles: string[]): string => {
  const routeFromState = routeWorkflowState(state);
  if (routeFromState === "end" || routeFromState === "wait_human") {
    return routeFromState;
  }
  if (workflowRoles.includes(routeFromState)) {
    return routeFromState;
  }

  const currentAssignee = normalizeRoleName(state.current_assignee);
  if (currentAssignee && workflowRoles.includes(currentAssignee)) {
    return currentAssignee;
  }

  return workflowRoles[0] ?? "wait_human";
};

const shouldInterruptAfterEveryRole = (options?: BuildDynamicAgentGraphOptions): boolean => {
  const mode = String(options?.workflowMode ?? "").trim().toLowerCase();
  const status = String(options?.workflowStatus ?? "").trim().toLowerCase();
  return mode === "manual" || mode === "waiting_approval" || status === "waiting_approval";
};

export const buildDynamicAgentGraph = (
  roles?: WorkflowRole[] | null,
  options?: BuildDynamicAgentGraphOptions
) => {
  const workflowRoles = normalizeWorkflowRoles(roles);
  const workflow = new StateGraph<AgentState>({
    channels: createStateChannels(),
  });

  const routeMap: Record<string, string> = Object.fromEntries([
    ...workflowRoles.map((role) => [role, role]),
    ["router", "router"],
    ["wait_human", "wait_human"],
    ["end", END],
  ]);

  workflow.addNode("router", routerNode);
  workflow.addNode("wait_human", waitForHumanNode);

  for (const role of workflowRoles) {
    workflow.addNode(role, createRoleNode(role));
    workflow.addConditionalEdges(
      role,
      (state) => routeFromRoleState(state as AgentState, role, workflowRoles),
      routeMap
    );
  }

  workflow.addEdge("wait_human", END);
  workflow.addConditionalEdges(
    "router",
    (state) => routeFromRouterState(state as AgentState, workflowRoles),
    routeMap
  );
  workflow.setEntryPoint("router");

  const compiled = workflow.compile((options?.checkpointer ?? officeCheckpointer) as any);

  if (shouldInterruptAfterEveryRole(options) && workflowRoles.length > 0) {
    (compiled as any).interrupt = [...workflowRoles];
  }

  return compiled;
};

export const graph = buildDynamicAgentGraph();
