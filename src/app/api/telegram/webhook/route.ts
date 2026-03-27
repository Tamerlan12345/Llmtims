import { NextRequest, NextResponse } from "next/server";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  try {
    if (!isServerSupabaseConfigured) {
      return NextResponse.json({ ok: true });
    }

    const body = await req.json();

    if (body.message) {
      const text = body.message.text;
      const chatId = body.message.chat.id;

      if (text === "/status") {
        const { data: tasks, error } = await supabase
          .from("tasks")
          .select("title, status, agents(name, tg_nickname)")
          .limit(5);

        if (error) {
          throw error;
        }

        let statusMessage = "Active Tasks:\n\n";
        for (const task of tasks ?? []) {
          const statusIcon = task.status === "done" ? "[OK]" : "[RUN]";
          const assignee = (task as any).agents?.tg_nickname || "unassigned";
          statusMessage += `${statusIcon} ${task.title}\n- Status: ${task.status}\n- Assignee: @${assignee}\n\n`;
        }

        return NextResponse.json({
          method: "sendMessage",
          chat_id: chatId,
          text: statusMessage,
          parse_mode: "Markdown",
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json({ ok: true });
  }
}
