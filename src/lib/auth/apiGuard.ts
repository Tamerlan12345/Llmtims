import "server-only";

import { NextResponse } from "next/server";
import { getAdminSession, type AdminSessionIdentity } from "@/lib/auth/adminSession";

export type ApiGuardResult =
  | { session: AdminSessionIdentity; response?: never }
  | { session?: never; response: NextResponse };

export const hasOfficeAccess = (
  session: AdminSessionIdentity,
  officeId: string | null | undefined
): boolean => {
  const normalizedOfficeId = String(officeId ?? "").trim();
  return Boolean(normalizedOfficeId) && session.offices.some((office) => office.id === normalizedOfficeId);
};

export const requireAdminSession = async (): Promise<ApiGuardResult> => {
  const session = await getAdminSession();
  if (!session) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  return { session };
};

export const requireAdminOfficeAccess = async (
  officeId: string | null | undefined
): Promise<ApiGuardResult> => {
  const normalizedOfficeId = String(officeId ?? "").trim();
  if (!normalizedOfficeId) {
    return { response: NextResponse.json({ error: "officeId is required" }, { status: 400 }) };
  }

  const sessionResult = await requireAdminSession();
  if (sessionResult.response) {
    return sessionResult;
  }

  if (!hasOfficeAccess(sessionResult.session, normalizedOfficeId)) {
    return { response: NextResponse.json({ error: "Office access denied" }, { status: 403 }) };
  }

  return { session: sessionResult.session };
};
