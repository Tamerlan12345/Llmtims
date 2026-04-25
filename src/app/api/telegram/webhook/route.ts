import { NextRequest, NextResponse } from "next/server";
import { buildOfficeRoomKey } from "@/lib/offices/utils";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { runAgentWorkflow } from "@/lib/agents/workflowRunner";

interface TelegramMessage {
  chat?: { id?: number };
  from?: { id?: number; username?: string | null };
  text?: string;
}

interface TelegramWebhookBody {
  message?: TelegramMessage;
}

const getOfficeContextByTelegramUser = async (telegramUserId: number) => {
  const { data: member } = await supabase
    .from("office_members")
    .select("office_id")
    .eq("telegram_user_id", telegramUserId)
    .eq("is_active", true)
    .maybeSingle();

  const officeId = typeof member?.office_id === "string" ? member.office_id : null;
  if (!officeId) {
    return null;
  }

  const { data: office } = await supabase
    .from("offices")
    .select("id, name")
    .eq("id", officeId)
    .maybeSingle();

  if (!office?.id) {
    return null;
  }

  return {
    officeId: office.id as string,
    officeName: String(office.name ?? "Office"),
  };
};

const buildTelegramResponse = (chatId: number, text: string) => {
  return NextResponse.json({
    method: "sendMessage",
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  });
};

const verifyTelegramWebhookSecret = (req: NextRequest): NextResponse | null => {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expectedSecret) {
    return NextResponse.json({ error: "telegram_webhook_secret_required" }, { status: 503 });
  }

  const actualSecret = req.headers.get("x-telegram-bot-api-secret-token")?.trim();
  if (actualSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
};

export async function POST(req: NextRequest) {
  try {
    const secretError = verifyTelegramWebhookSecret(req);
    if (secretError) {
      return secretError;
    }

    if (!isServerSupabaseConfigured) {
      return NextResponse.json({ ok: true });
    }

    const body = (await req.json()) as TelegramWebhookBody;
    const message = body.message;
    const text = message?.text?.trim();
    const chatId = Number(message?.chat?.id ?? 0);
    const telegramUserId = Number(message?.from?.id ?? 0);

    if (!text || !chatId || !telegramUserId) {
      return NextResponse.json({ ok: true });
    }

    const officeContext = await getOfficeContextByTelegramUser(telegramUserId);
    if (!officeContext) {
      return buildTelegramResponse(
        chatId,
        "Office is not linked to this Telegram user yet. Add the user to `office_members.telegram_user_id` first."
      );
    }

    if (text === "/status") {
      const { data: tasks, error } = await supabase
        .from("tasks")
        .select("title, status")
        .eq("office_id", officeContext.officeId)
        .order("updated_at", { ascending: false })
        .limit(5);

      if (error) {
        throw error;
      }

      const statusMessage =
        (tasks ?? []).length > 0
          ? [
              `Office: ${officeContext.officeName}`,
              "",
              ...(tasks ?? []).map((task) => {
                const icon = task.status === "done" ? "[OK]" : task.status === "failed" ? "[ERR]" : "[RUN]";
                return `${icon} ${task.title}\n- Status: ${task.status}`;
              }),
            ].join("\n")
          : `Office: ${officeContext.officeName}\n\nNo active tasks yet.`;

      return buildTelegramResponse(chatId, statusMessage);
    }

    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .insert({
        title: `Telegram task: ${text.slice(0, 72)}`,
        description: text,
        status: "pending",
        office_id: officeContext.officeId,
        metadata: {
          approved: true,
          initiatedBy: "telegram",
          telegramUserId,
          telegramUsername: message?.from?.username ?? null,
        },
      })
      .select("id")
      .single();

    if (taskError || !task?.id) {
      throw taskError ?? new Error("telegram_task_insert_failed");
    }

    void runAgentWorkflow({
      taskId: task.id,
      input: text,
      targetRole: "All",
      approved: true,
      officeId: officeContext.officeId,
      roomKey: buildOfficeRoomKey(officeContext.officeId),
    }).catch((error) => {
      console.error("Telegram workflow launch failed:", error);
    });

    return buildTelegramResponse(
      chatId,
      `Task accepted for office *${officeContext.officeName}*.\nTask ID: \`${task.id}\`\nWorkflow has started.`
    );
  } catch (error) {
    console.error("Webhook error:", error);
    return NextResponse.json({ ok: true });
  }
}
