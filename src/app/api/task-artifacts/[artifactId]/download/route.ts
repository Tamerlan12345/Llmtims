import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

interface RouteContext {
  params: {
    artifactId?: string;
  };
}

export async function GET(_req: NextRequest, context: RouteContext) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const artifactId = context.params?.artifactId?.trim() ?? "";
  if (!artifactId) {
    return NextResponse.json({ error: "artifactId is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("task_artifacts")
    .select("id, office_id, storage_bucket, storage_path")
    .eq("id", artifactId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data?.id || typeof data.office_id !== "string") {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  const hasOfficeAccess = session.offices.some((office) => office.id === data.office_id);
  if (!hasOfficeAccess) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const bucketName =
    typeof data.storage_bucket === "string" && data.storage_bucket.trim().length > 0
      ? data.storage_bucket.trim()
      : "office-artifacts";
  const storagePath =
    typeof data.storage_path === "string" && data.storage_path.trim().length > 0
      ? data.storage_path.trim()
      : "";

  if (!storagePath) {
    return NextResponse.json({ error: "Artifact storage path is missing" }, { status: 422 });
  }

  const signed = await supabase.storage.from(bucketName).createSignedUrl(storagePath, 60 * 60);
  if (signed.error || !signed.data?.signedUrl) {
    return NextResponse.json(
      { error: signed.error?.message ?? "Failed to create signed download URL" },
      { status: 500 }
    );
  }

  return NextResponse.redirect(signed.data.signedUrl, { status: 307 });
}

