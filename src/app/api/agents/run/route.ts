import { NextRequest, NextResponse } from "next/server";
import { graph } from "@/lib/agents/graph";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { logSystemEvent } from "@/lib/agents/persistence";
import { DEFAULT_ROOM_KEY, patchRoomState, publishTeamEvent } from "@/lib/agents/realtime";

interface RunBody {
  taskId?: string;
  input?: string;
  targetRole?: string;
  roomKey?: string;
  approved?: boolean;
}

interface TaskRow {
  id: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
}

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
  const roomKey = DEFAULT_ROOM_KEY;

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
    const resolvedRoomKey = body?.roomKey?.trim() || roomKey;

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
      .select("id, description, metadata")
      .eq("id", taskId)
      .single();

    if (taskError || !task) throw new Error("Task not found");
    const taskRow = task as TaskRow;
    const approvedForRun = isTaskApproved(taskRow, approved);

    if (!approvedForRun) {
      await patchRoomState({
        roomKey: resolvedRoomKey,
        mode: "approval",
        taskStatus: "waiting_approval",
        activeRole: "PM",
        pendingTaskId: taskId,
        metadata: {
          awaitingTaskApproval: true,
          pendingTaskId: taskId,
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
    await supabase
      .from("tasks")
      .update({
        status: "in_progress",
        metadata: nextMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq("id", taskId);

    await patchRoomState({
      roomKey: resolvedRoomKey,
      mode: "execution",
      taskStatus: "in_progress",
      activeRole: "PM",
      pendingTaskId: taskId,
      metadata: {
        awaitingTaskApproval: false,
        targetRole: targetRole ?? "All",
      },
    });

    await publishTeamEvent({
      roomKey: resolvedRoomKey,
      eventName: "task.execution_started",
      scope: "broadcast",
      senderRole: "PM",
      senderName: "PM",
      targetRole: (targetRole as "PM" | "Developer" | "QA" | "DevOps" | "All") ?? "All",
      payload: {
        taskId,
        targetRole: targetRole ?? "All",
      },
    });

    const initialState = {
      task_id: taskId,
      messages: [{ type: "human", content: `${routeHint}\n${input || taskRow.description || ""}` }],
      next_agent: "PM",
      artifacts: [],
      iterations: 0,
    };

    const result = await graph.invoke(initialState, {
      configurable: { thread_id: taskId },
    });

    await patchRoomState({
      roomKey: resolvedRoomKey,
      mode: "discussion",
      taskStatus: "done",
      activeRole: "DevOps",
      pendingTaskId: null,
      metadata: { lastCompletedTaskId: taskId },
    });

    await publishTeamEvent({
      roomKey: resolvedRoomKey,
      eventName: "task.execution_completed",
      scope: "broadcast",
      senderRole: "DevOps",
      senderName: "DevOps",
      targetRole: "All",
      payload: {
        taskId,
      },
    });

    await logSystemEvent({
      scope: "agents.run",
      event: "task_run_completed",
      taskId,
      metadata: { targetRole: targetRole ?? "All" },
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
      metadata: { reason },
    });

    if (taskId) {
      try {
        await supabase
          .from("tasks")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("id", taskId);

        await patchRoomState({
          mode: "discussion",
          taskStatus: "failed",
          activeRole: "PM",
          pendingTaskId: taskId,
          metadata: {
            lastFailedTaskId: taskId,
            lastError: reason,
          },
        });

        await publishTeamEvent({
          eventName: "task.execution_failed",
          scope: "broadcast",
          senderRole: "PM",
          senderName: "PM",
          targetRole: "All",
          payload: {
            taskId,
            reason,
          },
        });
      } catch (statusError) {
        console.error("Failed to set task status to failed:", statusError);
      }
    }

    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
