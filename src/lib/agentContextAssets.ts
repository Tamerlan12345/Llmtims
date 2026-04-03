export interface AgentContextReferenceAsset {
  kind: string;
  label: string;
  usage: string;
  fileName: string;
  mimeType: string;
  storageBucket: string;
  storagePath: string;
  url?: string | null;
}

const REFERENCE_ASSET_BLOCK_PATTERN = /\[REFERENCE_ASSET\]([\s\S]*?)\[\/REFERENCE_ASSET\]/gi;

const trimTo = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
};

const normalizeKind = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "reference";
  if (normalized === "logo" || normalized === "reference" || normalized === "product" || normalized === "character") {
    return normalized;
  }
  return normalized.slice(0, 40);
};

export const deriveReferenceAssetLabel = (fileName: string): string => {
  const withoutExtension = fileName.replace(/\.[a-z0-9]+$/i, "");
  const cleaned = withoutExtension.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "Reference asset";
};

export const getDefaultReferenceAssetUsage = (kind: string, label?: string): string => {
  const normalizedKind = normalizeKind(kind);
  const normalizedLabel = trimTo(label, 120) || "this asset";

  if (normalizedKind === "logo") {
    return `Use ${normalizedLabel} as the official logo when the user asks to place, reuse, or preserve the brand mark.`;
  }
  if (normalizedKind === "product") {
    return `Use ${normalizedLabel} as the official product reference when the user asks for packaging, product shots, or branded visuals.`;
  }
  if (normalizedKind === "character") {
    return `Use ${normalizedLabel} as the canonical character reference when the user asks for the same character again.`;
  }
  return `Use ${normalizedLabel} as an official visual reference when the user explicitly asks to match or reuse it.`;
};

const normalizeReferenceAsset = (
  asset: Partial<AgentContextReferenceAsset>
): AgentContextReferenceAsset | null => {
  const storageBucket = trimTo(asset.storageBucket, 120);
  const storagePath = trimTo(asset.storagePath, 400);
  if (!storageBucket || !storagePath) {
    return null;
  }

  const fileName = trimTo(asset.fileName, 160) || "reference-asset";
  const label = trimTo(asset.label, 120) || deriveReferenceAssetLabel(fileName);
  const kind = normalizeKind(trimTo(asset.kind, 40) || "reference");
  const usage = trimTo(asset.usage, 300) || getDefaultReferenceAssetUsage(kind, label);
  const mimeType = trimTo(asset.mimeType, 120) || "image/*";
  const url = trimTo(asset.url, 2000) || null;

  return {
    kind,
    label,
    usage,
    fileName,
    mimeType,
    storageBucket,
    storagePath,
    url,
  };
};

export const parseAgentContextReferenceAssets = (content: string): AgentContextReferenceAsset[] => {
  const assets: AgentContextReferenceAsset[] = [];
  const seen = new Set<string>();
  const normalizedContent = typeof content === "string" ? content : "";
  let match = REFERENCE_ASSET_BLOCK_PATTERN.exec(normalizedContent);

  while (match) {
    const blockBody = String(match[1] ?? "");
    const lines = blockBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const candidate: Partial<AgentContextReferenceAsset> = {};
    for (const line of lines) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex <= 0) continue;

      const rawKey = line.slice(0, separatorIndex).trim().toLowerCase();
      const rawValue = line.slice(separatorIndex + 1).trim();
      if (!rawValue) continue;

      if (rawKey === "kind") candidate.kind = rawValue;
      if (rawKey === "label") candidate.label = rawValue;
      if (rawKey === "usage") candidate.usage = rawValue;
      if (rawKey === "file_name") candidate.fileName = rawValue;
      if (rawKey === "mime_type") candidate.mimeType = rawValue;
      if (rawKey === "storage_bucket") candidate.storageBucket = rawValue;
      if (rawKey === "storage_path") candidate.storagePath = rawValue;
      if (rawKey === "url") candidate.url = rawValue;
    }

    const asset = normalizeReferenceAsset(candidate);
    if (asset) {
      const dedupeKey = `${asset.storageBucket}:${asset.storagePath}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        assets.push(asset);
      }
    }

    match = REFERENCE_ASSET_BLOCK_PATTERN.exec(normalizedContent);
  }

  return assets;
};

export const stripAgentContextReferenceAssets = (content: string): string =>
  String(content ?? "")
    .replace(REFERENCE_ASSET_BLOCK_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const serializeAgentContextReferenceAsset = (asset: AgentContextReferenceAsset): string => {
  const normalized = normalizeReferenceAsset(asset);
  if (!normalized) return "";

  return [
    "[REFERENCE_ASSET]",
    `kind: ${normalized.kind}`,
    `label: ${normalized.label}`,
    `usage: ${normalized.usage}`,
    `file_name: ${normalized.fileName}`,
    `mime_type: ${normalized.mimeType}`,
    `storage_bucket: ${normalized.storageBucket}`,
    `storage_path: ${normalized.storagePath}`,
    "[/REFERENCE_ASSET]",
  ].join("\n");
};

export const composeAgentContextTextWithAssets = (
  baseText: string,
  assets: AgentContextReferenceAsset[]
): string => {
  const normalizedBaseText = stripAgentContextReferenceAssets(baseText);
  const serializedAssets = assets
    .map((asset) => serializeAgentContextReferenceAsset(asset))
    .filter((value) => value.length > 0);

  return [normalizedBaseText, ...serializedAssets].filter((value) => value.length > 0).join("\n\n");
};

export const summarizeReferenceAssetForPrompt = (
  asset: AgentContextReferenceAsset,
  resolvedUrl?: string | null
): string => {
  const parts = [
    `kind=${asset.kind}`,
    `label=${asset.label}`,
    `usage=${asset.usage}`,
    `file=${asset.fileName}`,
    resolvedUrl ? `url=${resolvedUrl}` : null,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  return `Reference asset: ${parts.join("; ")}. Treat it as authoritative when the user explicitly asks to use it.`;
};
