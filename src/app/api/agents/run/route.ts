import { NextRequest, NextResponse } from "next/server";
import { buildDynamicAgentGraph } from "@/lib/agents/graph";
import { clearWorkflowCheckpoint, logSystemEvent } from "@/lib/agents/persistence";
import { loadRoleSkillContextFromDb } from "@/lib/agents/skillProfiles";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
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

interface WorkflowEdge {
  from: string;
  to: string | null;
  condition?: string | null;
}

const normalizeRoleList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item): item is string => item.length > 0)
    )
  );
};

const normalizeWorkflowEdges = (value: unknown): WorkflowEdge[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map<WorkflowEdge | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const from = typeof row.from === "string" ? row.from.trim() : "";
      const to = typeof row.to === "string" ? row.to.trim() : "";
      const condition =
        typeof row.condition === "string"
          ? row.condition.trim()
          : typeof row.on === "string"
            ? row.on.trim()
            : "approve";
      if (!from) return null;

      return {
        from,
        to: to || null,
        condition: condition || "approve",
      } satisfies WorkflowEdge;
    })
    .filter((edge): edge is WorkflowEdge => edge !== null);
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

const deriveWorkflowRoles = async (
  task: TaskRow,
  officeId: string | null,
  targetRole?: string | null
) => {
  const metadata = task.metadata ?? {};
  const explicitMode =
    typeof task.workflow_mode === "string" && task.workflow_mode.trim().length > 0
      ? task.workflow_mode.trim().toLowerCase()
      : String(metadata.workflowMode ?? "").toLowerCase();
  const manualRoles = normalizeRoleList(
    task.manual_workflow_roles ?? metadata.manualWorkflowRoles
  );
  const manualEdges = normalizeWorkflowEdges(task.dependencies ?? metadata.dependencies);
  const context = await loadRoleSkillContextFromDb(officeId);
  const officeRoles = Array.from(
    new Set(
      (context.availableRoles ?? [])
        .map((role) => role.trim())
        .filter((role) => role.length > 0)
    )
  );
  const coordinatorRole = context.coordinatorRole ?? officeRoles[0] ?? "Coordinator";

  if (explicitMode === "manual") {
    const edgeRoles = Array.from(
      new Set(
        manualEdges.flatMap((edge) => [edge.from, edge.to ?? ""]).filter((value) => value.length > 0)
      )
    );
    const workflowRoles = manualRoles.length > 0 ? manualRoles : edgeRoles.length > 0 ? edgeRoles : officeRoles;
    return {
      workflowMode: "manual" as const,
      workflowRoles,
      workflowEdges: manualEdges,
      coordinatorRole,
    };
  }

  const autonomousRoles = officeRoles.length > 0 ? officeRoles : manualRoles;
  const normalizedTargetRole =
    typeof targetRole === "string" && targetRole.trim().length > 0 && targetRole !== "All"
      ? targetRole.trim()
      : null;
  const workflowRoles =
    normalizedTargetRole && autonomousRoles.includes(normalizedTargetRole)
      ? Array.from(new Set([coordinatorRole, normalizedTargetRole, ...autonomousRoles]))
      : autonomousRoles.length > 0
        ? autonomousRoles
        : [coordinatorRole];

  return {
    workflowMode: "autonomous" as const,
    workflowRoles,
    workflowEdges: manualEdges,
    coordinatorRole,
  };
};

export async function POST(req: NextRequest) {
  let taskId: string | undefined;
  let officeId: string | null = null;
  let resolvedRoomKey = DEFAULT_ROOM_KEY;

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
    resolvedRoomKey = body?.roomKey?.trim() || buildOfficeRoomKey(officeId) || DEFAULT_ROOM_KEY;

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
    const derivedWorkflow = await deriveWorkflowRoles(
      taskRow,
      resolvedOfficeId,
      typeof targetRole === "string" ? targetRole : null
    );
    const entryRole =
      derivedWorkflow.workflowMode === "autonomous"
        ? derivedWorkflow.coordinatorRole
        : derivedWorkflow.workflowRoles[0] ?? derivedWorkflow.coordinatorRole;

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
        senderRole: derivedWorkflow.coordinatorRole,
        senderName: derivedWorkflow.coordinatorRole,
        requiresAck: true,
        payload: {
          taskId,
          reason: "approval_required",
          officeId: resolvedOfficeId,
        },
      });
      return NextResponse.json({ error: "Task requires approval before execution." }, { status: 409 });
    }

    const routeHint =
      typeof targetRole === "string" && targetRole && targetRole !== "All"
        ? `[TARGET_ROLE:${targetRole}]`
        : "[TARGET_ROLE:All]";

    const nextMetadata = normalizeTaskMetadata(taskRow.metadata, approvedForRun);
    let taskUpdateQuery = supabase
      .from("tasks")
      .update({
        status:
          derivedWorkflow.workflowMode === "manual"
            ? "review"
            : "in_progress",
        metadata: {
          ...nextMetadata,
          workflowMode: derivedWorkflow.workflowMode,
          workflowRoles: derivedWorkflow.workflowRoles,
          workflowEdges: derivedWorkflow.workflowEdges,
          coordinatorRole: derivedWorkflow.coordinatorRole,
        },
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
        workflowMode: derivedWorkflow.workflowMode,
        workflowRoles: derivedWorkflow.workflowRoles,
        workflowEdges: derivedWorkflow.workflowEdges,
        coordinatorRole: derivedWorkflow.coordinatorRole,
        officeId: resolvedOfficeId,
      },
    });

    await publishTeamEvent({
      roomKey: resolvedRoomKey,
      eventName: "task.execution_started",
      scope: "broadcast",
      senderRole: entryRole,
      senderName: entryRole,
      targetRole: targetRole ?? "All",
      payload: {
        taskId,
        targetRole: targetRole ?? "All",
        officeId: resolvedOfficeId,
      },
    });

    const initialState = {
      task_id: taskId,
      messages: [{ type: "human" as const, content: `${routeHint}\n${input || taskRow.description || ""}` }],
      next_agent: entryRole,
      artifacts: Array.isArray(taskRow.artifacts) ? taskRow.artifacts : [],
      iterations: 0,
      office_id: resolvedOfficeId,
      room_key: resolvedRoomKey,
      target_role: targetRole ?? "All",
      sub_tasks: [],
      current_assignee: entryRole,
      workflow_mode: derivedWorkflow.workflowMode,
      workflow_roles: derivedWorkflow.workflowRoles,
      workflow_edges: derivedWorkflow.workflowEdges,
      completed_roles: [],
      pending_roles:
        derivedWorkflow.workflowMode === "manual"
          ? derivedWorkflow.workflowRoles.slice(1)
          : [],
      coordinator_role: derivedWorkflow.coordinatorRole,
      workflow_status: "running",
      waiting_for_human: false,
      human_decision: null,
      last_actor: null,
      router_notes: null,
      route_status: null,
      error_message: null,
    };

    const workflowGraph = buildDynamicAgentGraph(derivedWorkflow.workflowRoles, {
      workflowMode: derivedWorkflow.workflowMode,
    });
    const result = await workflowGraph.invoke(initialState, {
      configurable: { thread_id: taskId, threadId: taskId },
    });

    if (result?.waiting_for_human || result?.workflow_status === "waiting_human") {
      await patchRoomState({
        roomKey: resolvedRoomKey,
        mode: "approval",
        taskStatus: "review",
        activeRole: result?.last_actor ?? result?.current_assignee ?? entryRole,
        pendingTaskId: taskId,
        metadata: {
          officeId: resolvedOfficeId,
          subTasks: result?.sub_tasks ?? [],
          currentAssignee: result?.current_assignee ?? null,
          artifacts: result?.artifacts ?? [],
          waitingForHuman: true,
        },
      });

      await logSystemEvent({
        scope: "agents.run",
        event: "task_run_paused_for_human",
        taskId,
        metadata: { officeId: resolvedOfficeId },
      });

      return NextResponse.json({ success: true, paused: true, result });
    }

    if (result?.workflow_status !== "completed" && result?.next_agent !== "END") {
      return NextResponse.json({ success: true, result });
    }

    await patchRoomState({
      roomKey: resolvedRoomKey,
      mode: "discussion",
      taskStatus: "done",
      activeRole: result?.last_actor ?? derivedWorkflow.coordinatorRole,
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
      senderRole: result?.last_actor ?? derivedWorkflow.coordinatorRole,
      senderName: result?.last_actor ?? derivedWorkflow.coordinatorRole,
      targetRole: "All",
      payload: {
        taskId,
        officeId: resolvedOfficeId,
      },
    });

    await clearWorkflowCheckpoint(taskId, resolvedOfficeId);

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
          activeRole: null,
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
          senderRole: null,
          senderName: null,
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
