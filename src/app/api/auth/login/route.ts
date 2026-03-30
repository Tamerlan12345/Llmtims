import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  authenticateAdmin,
} from "@/lib/auth/adminSession";
import { logSystemEvent } from "@/lib/agents/persistence";

interface LoginBody {
  email?: string;
  password?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as LoginBody;
    const email = body?.email?.trim() ?? "";
    const password = body?.password ?? "";

    if (!email || !password) {
      return NextResponse.json({ error: "email and password are required" }, { status: 400 });
    }

    const authResult = await authenticateAdmin(email, password);
    if (!authResult) {
      await logSystemEvent({
        level: "warn",
        scope: "auth.login",
        event: "login_failed",
        actorEmail: email,
      });
      return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
    }

    const response = NextResponse.json({
      success: true,
      admin: {
        email: authResult.identity.email,
        fullName: authResult.identity.fullName,
      },
    });

    response.cookies.set({
      name: ADMIN_SESSION_COOKIE,
      value: authResult.token,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
    });

    await logSystemEvent({
      scope: "auth.login",
      event: "login_success",
      actorEmail: authResult.identity.email,
      metadata: { source: authResult.identity.source },
    });

    return response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "login failed";
    await logSystemEvent({
      level: "error",
      scope: "auth.login",
      event: "login_error",
      metadata: { reason },
    });
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
