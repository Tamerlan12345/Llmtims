import { NextRequest, NextResponse } from "next/server";
import { requireAdminOfficeAccess } from "@/lib/auth/apiGuard";
import { importOfficeBundle, type BundleImportMode } from "@/lib/offices/bundle";

const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

export async function POST(req: NextRequest, { params }: { params: { officeId: string } }) {
  const officeId = params.officeId?.trim();
  if (!officeId) {
    return NextResponse.json({ error: "officeId is required" }, { status: 400 });
  }

  // Reject oversized payloads before parsing to keep memory bounded. Some
  // clients omit Content-Length; in that case we still cap via JSON parse below.
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BUNDLE_BYTES) {
    return NextResponse.json({ error: "bundle_too_large" }, { status: 413 });
  }

  const guard = await requireAdminOfficeAccess(officeId);
  if (guard.response) {
    return guard.response;
  }

  let body: { bundle?: unknown; mode?: string; dryRun?: boolean };
  try {
    const raw = await req.text();
    if (raw.length > MAX_BUNDLE_BYTES) {
      return NextResponse.json({ error: "bundle_too_large" }, { status: 413 });
    }
    body = raw ? (JSON.parse(raw) as typeof body) : {};
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const bundle = body.bundle;
  if (!bundle || typeof bundle !== "object") {
    return NextResponse.json({ error: "bundle_required" }, { status: 400 });
  }

  const mode: BundleImportMode = body.mode === "replace" ? "replace" : "merge";
  const dryRun = body.dryRun === true;

  const result = await importOfficeBundle(bundle, { targetOfficeId: officeId, mode, dryRun });
  const hasFatalError = result.errors.some(
    (code) => code === "bundle_invalid" || code === "bundle_version_unsupported"
  );
  if (hasFatalError) {
    return NextResponse.json({ error: result.errors[0] }, { status: 400 });
  }

  return NextResponse.json({ ok: result.errors.length === 0, result });
}
