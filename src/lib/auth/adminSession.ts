import "server-only";

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { loadServerEnv } from "@/lib/config/serverEnv";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

loadServerEnv();

export const ADMIN_SESSION_COOKIE = "cic_admin_session";

const DEFAULT_ADMIN_EMAIL = "admin@cic.kz";
const DEFAULT_ADMIN_PASSWORD = "Tamer25";
const ADMIN_SESSION_TTL_HOURS = Number(process.env.ADMIN_SESSION_TTL_HOURS ?? 12);
const ADMIN_SESSION_TTL_MS = Math.max(1, ADMIN_SESSION_TTL_HOURS) * 60 * 60 * 1000;
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET ?? "cic-admin-session-dev-secret";

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
}

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

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

  return {
    id: adminRow.id,
    email: adminRow.email,
    fullName: adminRow.full_name ?? "Administrator",
    source: "db",
  };
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

  return {
    token,
    identity: {
      id: row.id,
      email: row.email,
      fullName: row.full_name ?? "Administrator",
      source: "db",
    },
  };
};

const authenticateViaFallback = (
  email: string,
  password: string
): { token: string; identity: AdminSessionIdentity } | null => {
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail !== DEFAULT_ADMIN_EMAIL || password !== DEFAULT_ADMIN_PASSWORD) {
    return null;
  }

  const identity: AdminSessionIdentity = {
    id: "mock-admin",
    email: DEFAULT_ADMIN_EMAIL,
    fullName: "CIC Administrator",
    source: "mock",
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
  if (!email?.trim() || !password) return null;

  if (!isServerSupabaseConfigured) {
    return authenticateViaFallback(email, password);
  }

  return authenticateViaDb(email, password);
};

export const getSessionTokenFromCookies = (): string | null => {
  return cookies().get(ADMIN_SESSION_COOKIE)?.value ?? null;
};

export const getAdminSession = async (): Promise<AdminSessionIdentity | null> => {
  const token = getSessionTokenFromCookies();
  if (!token) return null;

  if (!isServerSupabaseConfigured) {
    const payload = parseMockToken(token);
    if (!payload) return null;
    return {
      id: payload.id,
      email: payload.email,
      fullName: payload.fullName,
      source: "mock",
    };
  }

  return validateDbSession(token);
};

export const revokeAdminSession = async (token: string | null | undefined): Promise<void> => {
  if (!token || !isServerSupabaseConfigured) return;
  await supabase.from("admin_sessions").delete().eq("token_hash", hashToken(token));
};
