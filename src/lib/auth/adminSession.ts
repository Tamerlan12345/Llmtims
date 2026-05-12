import "server-only";

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { loadServerEnv } from "@/lib/config/serverEnv";
import {
  DEFAULT_OFFICE_NAME,
  type OfficeSummary,
  dedupeOffices,
} from "@/lib/offices/utils";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

loadServerEnv();

export const ADMIN_SESSION_COOKIE = "cic_admin_session";

const DEV_ADMIN_EMAIL = process.env.DEV_ADMIN_EMAIL ?? "";
const DEV_ADMIN_PASSWORD = process.env.DEV_ADMIN_PASSWORD ?? "";
const ADMIN_SESSION_TTL_HOURS = Number(process.env.ADMIN_SESSION_TTL_HOURS ?? 12);
const ADMIN_SESSION_TTL_MS = Math.max(1, ADMIN_SESSION_TTL_HOURS) * 60 * 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ALLOW_MOCK_ADMIN_AUTH =
  process.env.ALLOW_MOCK_ADMIN_AUTH === "true" && !IS_PRODUCTION;

if (ALLOW_MOCK_ADMIN_AUTH) {
  console.warn(
    "[adminSession] ALLOW_MOCK_ADMIN_AUTH is enabled — mock auth is active. " +
    "Set DEV_ADMIN_EMAIL and DEV_ADMIN_PASSWORD env vars for the fallback credentials. " +
    "Never enable this in production."
  );
}
const SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET ??
  (ALLOW_MOCK_ADMIN_AUTH ? "cic-admin-session-dev-secret" : "");

export const ADMIN_SESSION_MAX_AGE_SECONDS = Math.floor(ADMIN_SESSION_TTL_MS / 1000);

interface VerifyAdminRow {
  id: string;
  email: string;
  full_name: string | null;
}

interface DbAdminRow {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
}

interface DbSessionRow {
  admin_id: string;
  expires_at: string;
}

interface DbOfficeRow {
  id: string;
  name: string | null;
}

interface DbOfficeMemberRow {
  office_id: string;
  role: string | null;
}

interface MockSessionPayload {
  id: string;
  email: string;
  fullName: string;
  exp: number;
}

export interface AdminSessionIdentity {
  id: string;
  email: string;
  fullName: string;
  source: "db" | "mock";
  offices: OfficeSummary[];
  activeOfficeId: string | null;
  activeOfficeName: string | null;
}

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const assertProductionSessionSecret = (): void => {
  if (IS_PRODUCTION && !process.env.ADMIN_SESSION_SECRET?.trim()) {
    throw new Error("ADMIN_SESSION_SECRET is required in production.");
  }
};

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const createRandomToken = (): string => crypto.randomBytes(48).toString("base64url");

const signPayload = (encodedPayload: string): string => {
  return crypto.createHmac("sha256", SESSION_SECRET).update(encodedPayload).digest("base64url");
};

const createMockToken = (payload: MockSessionPayload): string => {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
};

const parseMockToken = (token: string): MockSessionPayload | null => {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const expected = signPayload(encodedPayload);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length) return null;
  if (!crypto.timingSafeEqual(expectedBuffer, actualBuffer)) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as MockSessionPayload;
    if (!payload?.email || !payload?.id || !payload?.fullName || !payload?.exp) return null;
    if (payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};

const buildMockOfficeContext = (): Pick<
  AdminSessionIdentity,
  "offices" | "activeOfficeId" | "activeOfficeName"
> => {
  return {
    offices: [
      {
        id: "mock-office",
        name: DEFAULT_OFFICE_NAME,
        accessRole: "owner",
      },
    ],
    activeOfficeId: "mock-office",
    activeOfficeName: DEFAULT_OFFICE_NAME,
  };
};

const resolveAdminOffices = async (adminId: string): Promise<OfficeSummary[]> => {
  if (!isServerSupabaseConfigured) {
    return buildMockOfficeContext().offices;
  }

  try {
    const [ownedResponse, memberResponse] = await Promise.all([
      supabase.from("offices").select("id, name").eq("owner_id", adminId),
      supabase.from("office_members").select("office_id, role").eq("admin_id", adminId).eq("is_active", true),
    ]);

    const ownedOffices = ((ownedResponse.data ?? []) as DbOfficeRow[]).map((office) => ({
      id: office.id,
      name: office.name?.trim() || DEFAULT_OFFICE_NAME,
      accessRole: "owner" as const,
    }));

    const memberRows = (memberResponse.data ?? []) as DbOfficeMemberRow[];
    const memberOfficeIds = memberRows
      .map((row) => row.office_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0);

    let memberOffices: OfficeSummary[] = [];
    if (memberOfficeIds.length > 0) {
      const { data: officeRows } = await supabase.from("offices").select("id, name").in("id", memberOfficeIds);
      const officeNameById = new Map<string, string>();
      for (const office of (officeRows ?? []) as DbOfficeRow[]) {
        officeNameById.set(office.id, office.name?.trim() || DEFAULT_OFFICE_NAME);
      }

      memberOffices = memberRows.map((row) => ({
        id: row.office_id,
        name: officeNameById.get(row.office_id) ?? DEFAULT_OFFICE_NAME,
        accessRole: row.role === "owner" ? "owner" : "member",
      }));
    }

    return dedupeOffices([...ownedOffices, ...memberOffices]);
  } catch (error) {
    console.error("[auth] failed to resolve offices:", error);
    return [];
  }
};

const withOfficeContext = async (
  identity: Omit<AdminSessionIdentity, "offices" | "activeOfficeId" | "activeOfficeName">
): Promise<AdminSessionIdentity> => {
  const offices = await resolveAdminOffices(identity.id);
  const activeOffice = offices[0] ?? null;

  return {
    ...identity,
    offices,
    activeOfficeId: activeOffice?.id ?? null,
    activeOfficeName: activeOffice?.name ?? null,
  };
};

const createDbSession = async (adminId: string): Promise<string | null> => {
  const token = createRandomToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString();
  const { error } = await supabase.from("admin_sessions").insert({
    admin_id: adminId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });

  if (error) {
    console.error("[auth] failed to create admin session:", error.message);
    return null;
  }

  return token;
};

const validateDbSession = async (token: string): Promise<AdminSessionIdentity | null> => {
  const tokenHash = hashToken(token);
  const { data: session, error: sessionError } = await supabase
    .from("admin_sessions")
    .select("admin_id, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (sessionError) {
    console.error("[auth] failed to read admin session:", sessionError.message);
    return null;
  }

  const sessionRow = session as DbSessionRow | null;
  if (!sessionRow) return null;
  if (new Date(sessionRow.expires_at).getTime() <= Date.now()) {
    await supabase.from("admin_sessions").delete().eq("token_hash", tokenHash);
    return null;
  }

  const { data: admin, error: adminError } = await supabase
    .from("admin_users")
    .select("id, email, full_name, is_active")
    .eq("id", sessionRow.admin_id)
    .maybeSingle();

  if (adminError) {
    console.error("[auth] failed to read admin user:", adminError.message);
    return null;
  }

  const adminRow = admin as DbAdminRow | null;
  if (!adminRow || !adminRow.is_active) {
    return null;
  }

  await supabase
    .from("admin_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("token_hash", tokenHash);

  return withOfficeContext({
    id: adminRow.id,
    email: adminRow.email,
    fullName: adminRow.full_name ?? "Administrator",
    source: "db",
  });
};

const authenticateViaDb = async (
  email: string,
  password: string
): Promise<{ token: string; identity: AdminSessionIdentity } | null> => {
  const normalizedEmail = normalizeEmail(email);
  const { data, error } = await supabase.rpc("verify_admin_credentials", {
    p_email: normalizedEmail,
    p_password: password,
  });

  if (error) {
    console.error("[auth] verify_admin_credentials failed:", error.message);
    return null;
  }

  const row = (Array.isArray(data) ? data[0] : null) as VerifyAdminRow | null;
  if (!row?.id || !row?.email) return null;

  const token = await createDbSession(row.id);
  if (!token) return null;

  const identity = await withOfficeContext({
    id: row.id,
    email: row.email,
    fullName: row.full_name ?? "Administrator",
    source: "db",
  });

  return {
    token,
    identity,
  };
};

const authenticateViaFallback = (
  email: string,
  password: string
): { token: string; identity: AdminSessionIdentity } | null => {
  if (!DEV_ADMIN_EMAIL || !DEV_ADMIN_PASSWORD) {
    console.warn("[adminSession] DEV_ADMIN_EMAIL or DEV_ADMIN_PASSWORD not set — fallback auth disabled.");
    return null;
  }
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail !== normalizeEmail(DEV_ADMIN_EMAIL) || password !== DEV_ADMIN_PASSWORD) {
    return null;
  }

  const identity: AdminSessionIdentity = {
    id: "mock-admin",
    email: DEV_ADMIN_EMAIL,
    fullName: "CIC Administrator",
    source: "mock",
    ...buildMockOfficeContext(),
  };

  const token = createMockToken({
    id: identity.id,
    email: identity.email,
    fullName: identity.fullName,
    exp: Date.now() + ADMIN_SESSION_TTL_MS,
  });

  return { token, identity };
};

export const authenticateAdmin = async (
  email: string,
  password: string
): Promise<{ token: string; identity: AdminSessionIdentity } | null> => {
  assertProductionSessionSecret();
  if (!email?.trim() || !password) return null;

  if (!isServerSupabaseConfigured) {
    return ALLOW_MOCK_ADMIN_AUTH ? authenticateViaFallback(email, password) : null;
  }

  const dbResult = await authenticateViaDb(email, password);
  if (dbResult) return dbResult;

  // DB unreachable (e.g. network restriction) → fall back to mock if allowed
  if (ALLOW_MOCK_ADMIN_AUTH) {
    return authenticateViaFallback(email, password);
  }

  return null;
};

export const getSessionTokenFromCookies = (): string | null => {
  return cookies().get(ADMIN_SESSION_COOKIE)?.value ?? null;
};

export const getAdminSession = async (): Promise<AdminSessionIdentity | null> => {
  const token = getSessionTokenFromCookies();
  if (!token) return null;

  // Try mock token first — works both when Supabase is unconfigured and when
  // ALLOW_MOCK_ADMIN_AUTH is on but DB is unreachable (network restriction).
  if (ALLOW_MOCK_ADMIN_AUTH) {
    const payload = parseMockToken(token);
    if (payload) {
      return {
        id: payload.id,
        email: payload.email,
        fullName: payload.fullName,
        source: "mock",
        ...buildMockOfficeContext(),
      };
    }
  }

  if (!isServerSupabaseConfigured) return null;
  return validateDbSession(token);
};

export const revokeAdminSession = async (token: string | null | undefined): Promise<void> => {
  if (!token || !isServerSupabaseConfigured) return;
  await supabase.from("admin_sessions").delete().eq("token_hash", hashToken(token));
};
