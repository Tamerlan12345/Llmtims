import { NextRequest, NextResponse } from "next/server";
import { graph } from "@/lib/agents/graph";
import { supabase } from "@/lib/supabase/client";

export async function POST(req: NextRequest) {
  try {
    const { taskId, input } = await req.json();

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
      messages: [{ type: 'human', content: input || task.description }],
      next_agent: 'PM',
      artifacts: [],
      iterations: 0
    };

    // 3. Run the Graph (background)
    // We run it as a stream or just invoke it
    const result = await graph.invoke(initialState, {
      configurable: { thread_id: taskId }
    });

    return NextResponse.json({ success: true, result });
  } catch (error: any) {
    console.error("Run Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
