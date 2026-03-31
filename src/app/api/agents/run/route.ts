import { NextRequest, NextResponse } from "next/server";
import { buildDynamicAgentGraph, DEFAULT_WORKFLOW_ROLES } from "@/lib/agents/graph";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { logSystemEvent } from "@/lib/agents/persistence";
import { buildOfficeRoomKey, DEFAULT_ROOM_KEY } from "@/lib/offices/utils";
import { patchRoomState, publishTeamEvent } from "@/lib/agents/realtime";

interface RunBody {
  taskId?: string;
  input?: string;
  targetRole?: string;
  roomKey?: string;
  officeId?: string;
  approved?: boolean;
}

interface TaskRow {
  id: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  office_id?: string | null;
  workflow_mode?: string | null;
  manual_workflow_roles?: unknown;
  dependencies?: unknown;
  artifacts?: unknown;
}

type RuntimeWorkflowRole = (typeof DEFAULT_WORKFLOW_ROLES)[number];

const isRuntimeWorkflowRole = (value: unknown): value is RuntimeWorkflowRole => {
  return typeof value === "string" && DEFAULT_WORKFLOW_ROLES.includes(value as RuntimeWorkflowRole);
};

const normalizeWorkflowRoles = (value: unknown): RuntimeWorkflowRole[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(isRuntimeWorkflowRole)));
};

const deriveWorkflowRoles = (
  task: TaskRow,
  targetRole?: string | null
): RuntimeWorkflowRole[] => {
  const metadata = task.metadata ?? {};
  const explicitMode =
    typeof task.workflow_mode === "string" && task.workflow_mode.trim().length > 0
      ? task.workflow_mode.trim().toLowerCase()
      : String(metadata.workflowMode ?? "").toLowerCase();
  const manualRoles = normalizeWorkflowRoles(
    task.manual_workflow_roles ??
      metadata.manualWorkflowRoles ??
      metadata.workflowRoles ??
      task.dependencies ??
      metadata.dependencies
  );
  if (manualRoles.length > 0) {
    if (explicitMode === "manual") {
      return manualRoles;
    }
    return manualRoles.includes("PM") ? manualRoles : (["PM", ...manualRoles] as RuntimeWorkflowRole[]);
  }

  if (isRuntimeWorkflowRole(targetRole) && targetRole !== "PM") {
    const sequence: RuntimeWorkflowRole[] = ["PM", targetRole];
    if (targetRole === "Developer") {
      sequence.push("QA", "DevOps");
    } else if (targetRole === "QA") {
      sequence.push("DevOps");
    }
    return Array.from(new Set(sequence));
  }

  return [...DEFAULT_WORKFLOW_ROLES];
};

const isTaskApproved = (task: TaskRow, approvedFlag: boolean): boolean => {
  if (approvedFlag) return true;
  const metadata = task.metadata ?? {};
  return Boolean(metadata.approved === true);
};

const normalizeTaskMetadata = (
  metadata: Record<string, unknown> | null,
  approved: boolean
): Record<string, unknown> => {
  const next = { ...(metadata ?? {}) };
  if (approved) {
    next.approved = true;
    next.approved_at = new Date().toISOString();
  }
  return next;
};

export async function POST(req: NextRequest) {
  let taskId: string | undefined;
  let officeId: string | null = null;
  const roomKey = DEFAULT_ROOM_KEY;
  let resolvedRoomKey = roomKey;

  try {
    if (!isServerSupabaseConfigured) {
      return NextResponse.json(
        { error: "Supabase is not configured. Set env vars or config.env values first." },
        { status: 500 }
      );
    }

    const body = (await req.json()) as RunBody;
    taskId = body?.taskId;
    const input = body?.input;
    const targetRole = body?.targetRole;
    const approved = Boolean(body?.approved);
    officeId = body?.officeId?.trim() || null;
    resolvedRoomKey = body?.roomKey?.trim() || buildOfficeRoomKey(officeId) || roomKey;

    await logSystemEvent({
      scope: "agents.run",
      event: "task_run_requested",
      taskId: taskId ?? null,
      metadata: { targetRole: targetRole ?? "All", approved },
    });

    if (!taskId) {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 });
    }

    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("id, description, metadata, office_id, workflow_mode, manual_workflow_roles, dependencies, artifacts")
      .eq("id", taskId)
      .single();

    if (taskError || !task) throw new Error("Task not found");
    const taskRow = task as TaskRow;
    const resolvedOfficeId = officeId ?? taskRow.office_id ?? null;
    const approvedForRun = isTaskApproved(taskRow, approved);
    const workflowRoles = deriveWorkflowRoles(taskRow, typeof targetRole === "string" ? targetRole : null);
    const entryRole = workflowRoles[0] ?? "PM";
    const workflowMode =
      String(taskRow.workflow_mode ?? taskRow.metadata?.workflowMode ?? "").toLowerCase() === "manual"
        ? "manual"
        : "autonomous";

    if (!approvedForRun) {
      await patchRoomState({
        roomKey: resolvedRoomKey,
        mode: "approval",
        taskStatus: "waiting_approval",
        activeRole: entryRole,
        pendingTaskId: taskId,
        metadata: {
          awaitingTaskApproval: true,
          pendingTaskId: taskId,
          officeId: resolvedOfficeId,
        },
      });
      await publishTeamEvent({
        roomKey: resolvedRoomKey,
        eventName: "task.execution_blocked",
        scope: "system",
        senderRole: "PM",
        senderName: "PM",
        requiresAck: true,
      payload: {
        taskId,
        reason: "approval_required",
        officeId: resolvedOfficeId,
      },
      });
      return NextResponse.json(
        { error: "Task requires approval before execution." },
        { status: 409 }
      );
    }

    const routeHint =
      typeof targetRole === "string" && targetRole && targetRole !== "All"
        ? `[TARGET_ROLE:${targetRole}]`
        : "[TARGET_ROLE:All]";

    const nextMetadata = normalizeTaskMetadata(taskRow.metadata, approvedForRun);
    let taskUpdateQuery = supabase
      .from("tasks")
      .update({
        status: "in_progress",
        metadata: nextMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq("id", taskId);
    if (resolvedOfficeId) {
      taskUpdateQuery = taskUpdateQuery.eq("office_id", resolvedOfficeId);
    }
    await taskUpdateQuery;

    await patchRoomState({
      roomKey: resolvedRoomKey,
      mode: "execution",
      taskStatus: "in_progress",
      activeRole: entryRole,
      pendingTaskId: taskId,
        metadata: {
          awaitingTaskApproval: false,
          targetRole: targetRole ?? "All",
          workflowMode,
          workflowRoles,
          officeId: resolvedOfficeId,
        },
      });

    await publishTeamEvent({
      roomKey: resolvedRoomKey,
      eventName: "task.execution_started",
      scope: "broadcast",
      senderRole: entryRole,
      senderName: entryRole,
      targetRole: (targetRole as "PM" | "Developer" | "QA" | "DevOps" | "All") ?? "All",
      payload: {
        taskId,
        targetRole: targetRole ?? "All",
        officeId: resolvedOfficeId,
      },
    });

    const initialState = {
      task_id: taskId,
      messages: [{ type: "human", content: `${routeHint}\n${input || taskRow.description || ""}` }],
      next_agent: entryRole,
      artifacts: Array.isArray(taskRow.artifacts) ? taskRow.artifacts : [],
        iterations: 0,
        office_id: resolvedOfficeId,
        room_key: resolvedRoomKey,
        target_role: targetRole ?? "All",
        sub_tasks: [],
        current_assignee: entryRole,
        workflow_mode: workflowMode,
        workflow_roles: workflowRoles,
      };

    const workflowGraph = buildDynamicAgentGraph(workflowRoles);
    const result = await workflowGraph.invoke(initialState, {
      configurable: { thread_id: taskId },
    });

    await patchRoomState({
      roomKey: resolvedRoomKey,
      mode: "discussion",
      taskStatus: "done",
      activeRole: (workflowRoles[workflowRoles.length - 1] ?? "DevOps"),
      pendingTaskId: null,
      metadata: {
        lastCompletedTaskId: taskId,
        officeId: resolvedOfficeId,
        subTasks: result?.sub_tasks ?? [],
        currentAssignee: null,
        artifacts: result?.artifacts ?? [],
      },
    });

    await publishTeamEvent({
      roomKey: resolvedRoomKey,
      eventName: "task.execution_completed",
      scope: "broadcast",
      senderRole: (workflowRoles[workflowRoles.length - 1] ?? "DevOps"),
      senderName: (workflowRoles[workflowRoles.length - 1] ?? "DevOps"),
      targetRole: "All",
      payload: {
        taskId,
        officeId: resolvedOfficeId,
      },
    });

    await logSystemEvent({
      scope: "agents.run",
      event: "task_run_completed",
      taskId,
      metadata: { targetRole: targetRole ?? "All", officeId: resolvedOfficeId },
    });

    return NextResponse.json({ success: true, result });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "Agent run failed";
    console.error("Run Error:", error);
    await logSystemEvent({
      level: "error",
      scope: "agents.run",
      event: "task_run_failed",
      taskId: taskId ?? null,
      metadata: { reason, officeId },
    });

    if (taskId) {
      try {
        let failedTaskQuery = supabase
          .from("tasks")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("id", taskId);
        if (officeId) {
          failedTaskQuery = failedTaskQuery.eq("office_id", officeId);
        }
        await failedTaskQuery;

        await patchRoomState({
          roomKey: resolvedRoomKey,
          mode: "discussion",
          taskStatus: "failed",
          activeRole: "PM",
          pendingTaskId: taskId,
          metadata: {
            lastFailedTaskId: taskId,
            lastError: reason,
            officeId,
          },
        });

        await publishTeamEvent({
          roomKey: resolvedRoomKey,
          eventName: "task.execution_failed",
          scope: "broadcast",
          senderRole: "PM",
          senderName: "PM",
          targetRole: "All",
          payload: {
            taskId,
            reason,
            officeId,
          },
        });
      } catch (statusError) {
        console.error("Failed to set task status to failed:", statusError);
      }
    }

    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
