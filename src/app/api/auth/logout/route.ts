import { NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  getSessionTokenFromCookies,
  revokeAdminSession,
} from "@/lib/auth/adminSession";
import { logSystemEvent } from "@/lib/agents/persistence";

export async function POST() {
  try {
    const sessionToken = getSessionTokenFromCookies();
    await revokeAdminSession(sessionToken);
    await logSystemEvent({
      scope: "auth.logout",
      event: "logout_success",
    });

    const response = NextResponse.json({ success: true });
    response.cookies.set({
      name: ADMIN_SESSION_COOKIE,
      value: "",
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    return response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "logout failed";
    await logSystemEvent({
      level: "error",
      scope: "auth.logout",
      event: "logout_error",
      metadata: { reason },
    });
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
