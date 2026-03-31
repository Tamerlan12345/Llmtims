import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return NextResponse.json({ authenticated: false }, { status: 200 });
    }

    return NextResponse.json({
      authenticated: true,
      admin: {
        id: session.id,
        email: session.email,
        fullName: session.fullName,
      },
      activeOffice: session.activeOfficeId
        ? {
            id: session.activeOfficeId,
            name: session.activeOfficeName,
          }
        : null,
      offices: session.offices,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "session check failed";
    return NextResponse.json({ authenticated: false, error: reason }, { status: 500 });
  }
}
