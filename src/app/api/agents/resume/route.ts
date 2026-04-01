import { NextRequest, NextResponse } from "next/server";
import { buildDynamicAgentGraph } from "@/lib/agents/graph";
import type { AgentState } from "@/lib/agents/graph";
import {
  clearWorkflowCheckpoint,
  getWorkflowCheckpoint,
  logSystemEvent,
} from "@/lib/agents/persistence";
import { patchRoomState, publishTeamEvent } from "@/lib/agents/realtime";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { buildOfficeRoomKey, DEFAULT_ROOM_KEY } from "@/lib/offices/utils";

interface ResumeBody {
  taskId?: string;
  officeId?: string;
  roomKey?: string;
  action?: "approve" | "reject" | string;
  targetRole?: string | null;
  note?: string | null;
}

const normalizeAction = (value: unknown): "approve" | "reject" => {
  return value === "reject" ? "reject" : "approve";
};

export async function POST(req: NextRequest) {
  try {
    if (!isServerSupabaseConfigured) {
      return NextResponse.json({ error: "Supabase is not configured." }, { status: 500 });
    }

    const body = (await req.json()) as ResumeBody;
    const taskId = body.taskId?.trim();
    const officeId = body.officeId?.trim() || null;
    const roomKey = body.roomKey?.trim() || buildOfficeRoomKey(officeId) || DEFAULT_ROOM_KEY;
    const action = normalizeAction(body.action);
    const targetRole = typeof body.targetRole === "string" ? body.targetRole.trim() || null : null;
    const note = typeof body.note === "string" ? body.note.trim() || null : null;

    if (!taskId) {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 });
    }

    const checkpoint = await getWorkflowCheckpoint(taskId, officeId);
    if (!checkpoint) {
      return NextResponse.json({ error: "Workflow checkpoint not found" }, { status: 404 });
    }

    const workflowRoles = Array.isArray(checkpoint.workflow_roles)
      ? checkpoint.workflow_roles.filter((role): role is string => typeof role === "string" && role.trim().length > 0)
      : [];
    if (workflowRoles.length === 0) {
      return NextResponse.json({ error: "Checkpoint has no workflow roles" }, { status: 400 });
    }

    const resumedState: AgentState = {
      ...checkpoint,
      task_id: checkpoint.task_id ?? taskId,
      messages: Array.isArray(checkpoint.messages)
        ? checkpoint.messages.filter(
            (message): message is { type: "human" | "ai"; content: string } =>
              Boolean(message) &&
              (message.type === "human" || message.type === "ai") &&
              typeof message.content === "string"
          )
        : [],
      next_agent: typeof checkpoint.next_agent === "string" ? checkpoint.next_agent : null,
      artifacts: Array.isArray(checkpoint.artifacts) ? checkpoint.artifacts : [],
      iterations:
        typeof checkpoint.iterations === "number" && Number.isFinite(checkpoint.iterations)
          ? checkpoint.iterations
          : 0,
      office_id: officeId ?? checkpoint.office_id ?? null,
      room_key: roomKey,
      human_decision: {
        action,
        target: targetRole,
        note,
        at: new Date().toISOString(),
      },
      waiting_for_human: true,
      workflow_status: "running",
    };

    await patchRoomState({
      roomKey,
      mode: "execution",
      taskStatus: "in_progress",
      activeRole: resumedState.last_actor ?? resumedState.current_assignee ?? null,
      pendingTaskId: taskId,
      metadata: {
        officeId: resumedState.office_id ?? null,
        humanDecision: resumedState.human_decision,
      },
    });

    await publishTeamEvent({
      roomKey,
      eventName: "workflow.resumed",
      scope: "broadcast",
      senderRole: resumedState.last_actor ?? null,
      senderName: resumedState.last_actor ?? null,
      targetRole: "All",
      payload: {
        taskId,
        action,
        targetRole,
        officeId: resumedState.office_id ?? null,
      },
    });

    const workflowGraph = buildDynamicAgentGraph(workflowRoles, {
      workflowMode: resumedState.workflow_mode ?? null,
      workflowStatus: resumedState.workflow_status ?? null,
    });
    const result = await workflowGraph.invoke(resumedState, {
      configurable: { thread_id: taskId, threadId: taskId },
    });

    if (result?.waiting_for_human || result?.workflow_status === "waiting_human") {
      await patchRoomState({
        roomKey,
        mode: "approval",
        taskStatus: "review",
        activeRole: result?.last_actor ?? result?.current_assignee ?? null,
        pendingTaskId: taskId,
        metadata: {
          officeId: resumedState.office_id ?? null,
          currentAssignee: result?.current_assignee ?? null,
          subTasks: result?.sub_tasks ?? [],
          artifacts: result?.artifacts ?? [],
          waitingForHuman: true,
        },
      });

      return NextResponse.json({ success: true, paused: true, result });
    }

    if (result?.workflow_status !== "completed" && result?.next_agent !== "END") {
      return NextResponse.json({ success: true, result });
    }

    let completeTaskQuery = supabase
      .from("tasks")
      .update({ status: "done", updated_at: new Date().toISOString() })
      .eq("id", taskId);
    if (resumedState.office_id) {
      completeTaskQuery = completeTaskQuery.eq("office_id", resumedState.office_id);
    }
    await completeTaskQuery;

    await patchRoomState({
      roomKey,
      mode: "discussion",
      taskStatus: "done",
      activeRole: result?.last_actor ?? null,
      pendingTaskId: null,
      metadata: {
        officeId: resumedState.office_id ?? null,
        currentAssignee: null,
        subTasks: result?.sub_tasks ?? [],
        artifacts: result?.artifacts ?? [],
      },
    });

    await clearWorkflowCheckpoint(taskId, resumedState.office_id ?? null);

    await logSystemEvent({
      scope: "agents.resume",
      event: "workflow_resumed_successfully",
      taskId,
      metadata: {
        officeId: resumedState.office_id ?? null,
        action,
        targetRole,
      },
    });

    return NextResponse.json({ success: true, result });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "workflow_resume_failed";
    await logSystemEvent({
      level: "error",
      scope: "agents.resume",
      event: "workflow_resume_failed",
      metadata: { reason },
    });
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
