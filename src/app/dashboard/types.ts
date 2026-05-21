"use client";

import { TaskStatus } from "@/lib/office/engine";

export type RoleTarget = string;
export type WorkflowMode = "autonomous" | "manual";
export type WorkflowRole = string;
export type TeamEventScope = "broadcast" | "targeted" | "system";
export type ChatScope = "auto" | "broadcast" | "targeted";
export type RoomMode = "discussion" | "approval" | "execution";
export type ActivityCategory = "task" | "chat" | "devops" | "mcp" | "system";
export type ChatTimelineMode = "selected" | "all";
export type ActivityFilter = "all" | ActivityCategory;

export interface Agent {
  id: string;
  name: string;
  role: string;
  status?: string;
  avatar_url?: string;
  is_active: boolean;
  skills?: string[];
  role_md?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ChatMessage {
  id: string;
  sender: "user" | "agent";
  content: string;
  role?: string;
  agentName?: string;
  coordinator?: string;
  scope?: TeamEventScope;
  targetRole?: RoleTarget | null;
  clientMessageId?: string | null;
  createdAt?: string;
  taskId?: string | null;
  category?: ActivityCategory;
  thoughtTrace?: string;
}

export interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  targetRole: RoleTarget | null;
  currentAssignee?: string | null;
  assignedAgentId?: string | null;
  workflowSignal?: string | null;
  attachmentsCount?: number;
  attachmentsPreview?: Array<{
    id: string;
    title: string;
    artifactType: string | null;
    status: "ready" | "processing" | "failed";
    downloadUrl: string | null;
  }>;
  workflowMode?: WorkflowMode;
  manualWorkflowRoles?: WorkflowRole[];
  createdAt: string | null;
  updatedAt: string | null;
  source: "database" | "local";
}

export interface ApprovalRequestView {
  id: string;
  runId?: string | null;
  taskId?: string | null;
  toolId: string;
  riskLevel: string;
  actionSummary: string;
  arguments?: unknown;
  resource?: string | null;
  status: string;
  decision?: string | null;
  decisionAt?: string | null;
  createdAt?: string | null;
}

export interface AgentRunView {
  id: string;
  taskId?: string | null;
  status: string;
  mode?: string | null;
  blockedReason?: string | null;
  failureCategory?: string | null;
  attemptCount?: number | null;
  maxAttempts?: number | null;
  heartbeatAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type AgentWorkerHealthStatus = "idle" | "running" | "stale";

export interface AgentWorkerRunHealth {
  id: string;
  taskId: string;
  status: string;
  workerId: string | null;
  lockedAt: string | null;
  heartbeatAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  failureCategory: string | null;
  lastError: string | null;
  blockedReason: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  isStale: boolean;
}

export interface AgentWorkerHealth {
  status: AgentWorkerHealthStatus;
  staleAfterMs: number;
  now: string;
  runningCount: number;
  queuedCount: number;
  waitingApprovalCount: number;
  retryQueuedCount: number;
  deadLetterCount: number;
  lastHeartbeatAt: string | null;
  currentRun: AgentWorkerRunHealth | null;
  activeRuns: AgentWorkerRunHealth[];
  retryRuns: AgentWorkerRunHealth[];
  deadLetterRuns: AgentWorkerRunHealth[];
}

export interface AgentRunTraceStep {
  id: string;
  title?: string | null;
  stepType?: string | null;
  status?: string | null;
  phase?: string | null;
  role?: string | null;
  agentRole?: string | null;
  summary?: string | null;
  output?: unknown;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  durationMs?: number | null;
}

export interface AgentRunTraceValidation {
  id: string;
  status?: string | null;
  toolName?: string | null;
  created_at?: string | null;
}

export interface AgentRunTraceToolInvocation {
  id: string;
  toolId?: string | null;
  tool_id?: string | null;
  decision?: string | null;
  riskLevel?: string | null;
  risk_level?: string | null;
  status?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
  output?: unknown;
}

export interface AgentRunTraceArtifact {
  id: string;
  title?: string | null;
  artifact_type?: string | null;
  status?: string | null;
  created_at?: string | null;
}

export type AgentRunTimelineItem =
  | (AgentRunTraceStep & { _type: "step" })
  | (AgentRunTraceToolInvocation & { _type: "tool_invocation"; phase?: string | null; durationMs?: number | null })
  | (ApprovalRequestView & { _type: "approval"; phase?: string | null; durationMs?: number | null });

export interface AgentMemoryHit {
  id: string;
  key: string;
  namespace: string;
  summary: string;
  valuePreview: string;
  confidence: number;
  score: number;
  tags: string[];
  sourceRunId?: string | null;
  sourceTaskId?: string | null;
  createdAt?: string | null;
}

export interface SwarmTraceSummary {
  topology: string;
  strategy: string;
  maxAgents: number;
  consensusMode: string;
  memoryNamespace: string;
  antiDrift: {
    coordinatorGate: boolean;
    maxIterations: number;
    reworkLimit: number;
  };
}

export interface AgentRunTaskCard {
  id: string;
  step?: number | null;
  toolCallId: string | null;
  toolName: string;
  status: string;
  decision: string | null;
  riskLevel: string | null;
  argsPreview: string | null;
  summary: string | null;
  detailToken: string | null;
  durationMs: number | null;
  createdAt: string | null;
}

export interface AgentRunTaskGroup {
  id: string;
  step: number;
  status: "running" | "completed" | "failed" | "mixed";
  durationMs: number | null;
  tasks: AgentRunTaskCard[];
}

export interface TracePayload {
  run?: AgentRunView | null;
  steps?: AgentRunTraceStep[];
  validations?: AgentRunTraceValidation[];
  approvals?: ApprovalRequestView[];
  toolInvocations?: AgentRunTraceToolInvocation[];
  artifacts?: AgentRunTraceArtifact[];
  timeline?: AgentRunTimelineItem[];
  swarm?: SwarmTraceSummary | null;
  memoryHits?: AgentMemoryHit[];
  taskGroups?: AgentRunTaskGroup[];
}

export type ProcessTone = "info" | "run" | "ok" | "warn" | "error";

export interface ProcessStep {
  id: string;
  label: string;
  detail: string;
  time: string;
  tone: ProcessTone;
  taskId?: string | null;
  category?: ActivityCategory;
}
