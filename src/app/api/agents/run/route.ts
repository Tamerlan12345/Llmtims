import { NextRequest, NextResponse } from "next/server";
import { graph } from "@/lib/agents/graph";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { logSystemEvent } from "@/lib/agents/persistence";

export async function POST(req: NextRequest) {
  let taskId: string | undefined;

  try {
    if (!isServerSupabaseConfigured) {
      return NextResponse.json(
        { error: "Supabase is not configured. Set env vars or config.env values first." },
        { status: 500 }
      );
    }

    const body = await req.json();
    taskId = body?.taskId;
    const input = body?.input;
    const targetRole = body?.targetRole;
    await logSystemEvent({
      scope: "agents.run",
      event: "task_run_requested",
      taskId: taskId ?? null,
      metadata: { targetRole: targetRole ?? "All" },
    });

    const routeHint =
      typeof targetRole === "string" && targetRole && targetRole !== "All"
        ? `[TARGET_ROLE:${targetRole}]`
        : "[TARGET_ROLE:All]";
    if (!taskId) {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 });
    }

    // 1. Fetch task details
    const { data: task, error: taskError } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single();

    if (taskError || !task) throw new Error("Task not found");

    // 2. Initialize LangGraph State
    const initialState = {
      task_id: taskId,
      messages: [{ type: "human", content: `${routeHint}\n${input || task.description}` }],
      next_agent: 'PM',
      artifacts: [],
      iterations: 0
    };

    // 3. Run the Graph (background)
    // We run it as a stream or just invoke it
    const result = await graph.invoke(initialState, {
      configurable: { thread_id: taskId }
    });

    await logSystemEvent({
      scope: "agents.run",
      event: "task_run_completed",
      taskId,
      metadata: { targetRole: targetRole ?? "All" },
    });

    return NextResponse.json({ success: true, result });
  } catch (error: any) {
    console.error("Run Error:", error);
    await logSystemEvent({
      level: "error",
      scope: "agents.run",
      event: "task_run_failed",
      taskId: taskId ?? null,
      metadata: { reason: error?.message ?? "unknown_error" },
    });

    if (taskId) {
      try {
        await supabase
          .from("tasks")
          .update({ status: "failed", updated_at: new Date().toISOString() })
          .eq("id", taskId);
      } catch (statusError) {
        console.error("Failed to set task status to failed:", statusError);
      }
    }

    return NextResponse.json({ error: error?.message ?? "Agent run failed" }, { status: 500 });
  }
}
