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
    .select("id, office_id, storage_bucket, storage_path, mime_type, title, status")
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
  const artifactStatus =
    typeof data.status === "string" && data.status.trim().length > 0 ? data.status.trim() : "ready";

  if (artifactStatus === "processing") {
    return NextResponse.json({ error: "Artifact is still processing" }, { status: 409 });
  }

  if (artifactStatus === "failed") {
    return NextResponse.json({ error: "Artifact generation failed" }, { status: 410 });
  }

  if (!storagePath) {
    return NextResponse.json({ error: "Artifact storage path is missing" }, { status: 422 });
  }

  // Download the file via Supabase storage and serve it directly with correct headers
  const { data: fileData, error: downloadError } = await supabase.storage
    .from(bucketName)
    .download(storagePath);

  if (downloadError || !fileData) {
    return NextResponse.json(
      { error: downloadError?.message ?? "Failed to download artifact" },
      { status: 500 }
    );
  }

  const rawMime =
    typeof data.mime_type === "string" && data.mime_type.trim().length > 0
      ? data.mime_type.trim()
      : guessContentType(storagePath);

  // Always serve HTML with utf-8 charset so browsers render correctly
  const contentType = rawMime.startsWith("text/html")
    ? "text/html; charset=utf-8"
    : rawMime.includes("charset")
      ? rawMime
      : `${rawMime}; charset=utf-8`;

  const bytes = await fileData.arrayBuffer();

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function guessContentType(path: string): string {
  if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html";
  if (path.endsWith(".pdf")) return "application/pdf";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}
