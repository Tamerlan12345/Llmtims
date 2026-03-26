import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    
    if (body.message) {
      const text = body.message.text;
      const chatId = body.message.chat.id;

      if (text === "/status") {
        // Fetch active tasks from Supabase
        const { data: tasks, error } = await supabase
          .from('tasks')
          .select('title, status, agents(name, tg_nickname)')
          .limit(5);

        if (error) throw error;

        let statusMessage = "📝 **Active Tasks:**\n\n";
        tasks.forEach((task: any) => {
          const statusIcon = task.status === 'done' ? '✅' : '⚙️';
          statusMessage += `${statusIcon} **${task.title}**\n   └ Status: ${task.status}\n   └ Assignee: @${task.agents?.tg_nickname || 'unassigned'}\n\n`;
        });

        return NextResponse.json({
          method: "sendMessage",
          chat_id: chatId,
          text: statusMessage,
          parse_mode: "Markdown"
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json({ ok: true }); // Always return OK to Telegram
  }
}
