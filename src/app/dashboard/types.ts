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
  workflowMode?: WorkflowMode;
  manualWorkflowRoles?: WorkflowRole[];
  createdAt: string | null;
  updatedAt: string | null;
  source: "database" | "local";
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
