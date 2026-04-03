import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth/adminSession";
import {
  deriveReferenceAssetLabel,
  getDefaultReferenceAssetUsage,
  serializeAgentContextReferenceAsset,
  type AgentContextReferenceAsset,
} from "@/lib/agentContextAssets";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

const CONTEXT_ASSETS_BUCKET = process.env.SKILL_ARTIFACTS_BUCKET ?? "office-artifacts";
const MAX_CONTEXT_ASSET_BYTES = 15 * 1024 * 1024;

const normalizeText = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
};

const hasOfficeAccess = (officeId: string, officeIds: string[]) => officeIds.includes(officeId);

const sanitizeFileName = (value: string, fallback: string): string => {
  const normalized = value.trim().replace(/[^a-zA-Z0-9\-_. ]+/g, "").replace(/\s+/g, "_");
  return normalized.length > 0 ? normalized : fallback;
};

const normalizeAssetKind = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "logo" || normalized === "reference" || normalized === "product" || normalized === "character") {
    return normalized;
  }
  return "reference";
};

const ensureStorageBucket = async (bucketName: string) => {
  try {
    await supabase.storage.createBucket(bucketName, { public: false });
  } catch {
    // Bucket may already exist or the key may not have bucket-admin rights.
  }
};

const createSignedStorageUrl = async (bucketName: string, storagePath: string): Promise<string | null> => {
  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 30);

    if (error || typeof data?.signedUrl !== "string" || data.signedUrl.trim().length === 0) {
      return null;
    }

    return data.signedUrl;
  } catch {
    return null;
  }
};

export async function POST(req: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isServerSupabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const formData = await req.formData();
  const officeId = normalizeText(formData.get("officeId"), 120);
  if (!officeId || !hasOfficeAccess(officeId, session.offices.map((office) => office.id))) {
    return NextResponse.json({ error: "Office access denied" }, { status: 403 });
  }

  const uploadedFile = formData.get("file");
  if (!(uploadedFile instanceof File)) {
    return NextResponse.json({ error: "Image file is required" }, { status: 400 });
  }

  if (uploadedFile.size <= 0 || uploadedFile.size > MAX_CONTEXT_ASSET_BYTES) {
    return NextResponse.json({ error: "Image is empty or exceeds the 15 MB limit" }, { status: 400 });
  }

  const mimeType = normalizeText(uploadedFile.type, 120).toLowerCase();
  if (!mimeType.startsWith("image/")) {
    return NextResponse.json({ error: "Only image files are supported in instructions" }, { status: 400 });
  }

  const kind = normalizeAssetKind(normalizeText(formData.get("kind"), 40) || "reference");
  const originalFileName = normalizeText(uploadedFile.name, 160) || `reference-${Date.now()}.png`;
  const fileName = sanitizeFileName(originalFileName, `reference-${Date.now()}.png`);
  const label = normalizeText(formData.get("label"), 120) || deriveReferenceAssetLabel(fileName);
  const usage = normalizeText(formData.get("usage"), 300) || getDefaultReferenceAssetUsage(kind, label);

  const storagePath = `${officeId}/instruction-assets/${randomUUID()}-${fileName}`;
  const payload = Buffer.from(await uploadedFile.arrayBuffer());

  const upload = async () =>
    supabase.storage.from(CONTEXT_ASSETS_BUCKET).upload(storagePath, payload, {
      upsert: true,
      contentType: mimeType,
    });

  let uploadResult = await upload();
  if (uploadResult.error && /bucket|not found|404/i.test(uploadResult.error.message)) {
    await ensureStorageBucket(CONTEXT_ASSETS_BUCKET);
    uploadResult = await upload();
  }

  if (uploadResult.error) {
    return NextResponse.json({ error: uploadResult.error.message }, { status: 500 });
  }

  const signedUrl = await createSignedStorageUrl(CONTEXT_ASSETS_BUCKET, storagePath);
  const asset: AgentContextReferenceAsset = {
    kind,
    label,
    usage,
    fileName,
    mimeType,
    storageBucket: CONTEXT_ASSETS_BUCKET,
    storagePath,
    url: signedUrl,
  };

  return NextResponse.json(
    {
      asset,
      manifestBlock: serializeAgentContextReferenceAsset(asset),
    },
    { status: 201 }
  );
}
