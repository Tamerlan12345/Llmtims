import { NextRequest, NextResponse } from "next/server";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";
import { exportOfficeBundle } from "@/lib/offices/bundle";

export async function GET(_req: NextRequest, { params }: { params: { officeId: string } }) {
  const officeId = params.officeId?.trim();
  if (!officeId) {
    return NextResponse.json({ error: "officeId is required" }, { status: 400 });
  }

  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  const bundle = await exportOfficeBundle(officeId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `office-${officeId}-${timestamp}.json`;

  return new NextResponse(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
