import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { DynamicStructuredTool, DynamicTool } from "@langchain/core/tools";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { randomUUID } from "node:crypto";
import { z, type ZodTypeAny } from "zod";
import { loadServerEnv } from "@/lib/config/serverEnv";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { callPreferredMcpTool, loadDynamicMcpTools, MCP_TEMPLATE_POLICIES } from "@/lib/mcp/client";
import {
  authorizeToolInvocation,
  recordToolInvocation,
  redactSensitiveValue,
  type ToolRiskLevel,
} from "@/lib/agents/toolPolicy";
import {
  patchAgentRuntimeByRole,
  patchPlayerStateByRole,
  patchRoomState,
  publishTeamEvent,
} from "./realtime";
import { buildOfficeRoomKey } from "@/lib/offices/utils";
import { createCapabilityRequest } from "./capabilityService";
import {
  getRunSwarmSummary,
  persistAgentRunToolDetail,
  retrieveAgentMemoryPattern,
  searchAgentMemoryPatterns,
  storeAgentMemoryPattern,
} from "./rufloCore";
import {
  DEFAULT_MEMORY_MIN_CONFIDENCE,
  DEFAULT_MEMORY_NAMESPACE,
  TOOL_DETAIL_PERSIST_THRESHOLD,
} from "./rufloCoreShared";
import {
  FALLBACK_MODEL,
  MODEL_TIER_ORDER,
  resolveModelName,
  resolveTierForInvocation,
  type ModelTier,
} from "./modelRegistry";
import { evaluateBudget } from "./budgetGuard";

loadServerEnv();

const enableMockMcpTools = process.env.ENABLE_MOCK_MCP_TOOLS === "true";

export const LLM_TOOL_RUNTIME_MODE = enableMockMcpTools
  ? "stub-tools-enabled"
  : "mcp-dispatcher";

// Stub helpers are kept for future live MCP wiring, but they are disabled by default.
export const githubTool = new DynamicTool({
  name: "github_mcp",
  description: "Manage GitHub repositories, branches, and PRs.",
  func: async (input: string) => {
    console.warn("[MCP stub] GitHub tool invoked without live connector:", input);
    return "GitHub MCP stub: live GitHub connector is not wired in this service build.";
  },
});

export const railwayTool = new DynamicTool({
  name: "railway_mcp",
  description: "Manage Railway deployments and view logs.",
  func: async (input: string) => {
    console.warn("[MCP stub] Railway tool invoked through LLM binding:", input);
    return "Railway MCP stub: use the dedicated Railway executor instead of the generic LLM tool wrapper.";
  },
});

export const sandboxTool = new DynamicTool({
  name: "sandbox_execution",
  description: "Execute code in an isolated Docker sandbox.",
  func: async (input: string) => {
    console.warn("[MCP stub] Sandbox tool invoked without live connector:", input);
    return "Sandbox stub: isolated execution connector is not wired in this service build.";
  },
});

export const tools = [githubTool, railwayTool, sandboxTool];

export interface OfficeSkillToolDefinition {
  id: string;
  name: string;
  description: string;
  instructionMarkdown?: string | null;
  runtime?: string | null;
  endpoint?: string | null;
  parameterSchema?: Record<string, unknown> | null;
  isVerified?: boolean;
  implementationRef?: string | null;
}

type AgentTool = DynamicTool | DynamicStructuredTool<any>;

interface OfficeSkillExecutionContext {
  officeId?: string | null;
  runId?: string | null;
  role?: string | null;
  taskId?: string | null;
  threadId?: string | null;
  roomKey?: string | null;
  approveModeEnabled?: boolean;
  approveModeMinRisk?: import("@/lib/agents/toolPolicy").ToolRiskLevel;
}

type TaskArtifactStatus = "ready" | "processing" | "failed";

interface OfficeRoleCatalog {
  roles: string[];
  byNormalizedRole: Map<string, string>;
}

export interface AgentToolEvent {
  name: string;
  status: "started" | "completed" | "failed";
  argsPreview?: string | null;
  message?: string | null;
  output?: string | null;
}

const parseStructuredToolInput = (input: string): Record<string, unknown> => {
  const normalized = input.trim();
  if (!normalized) return {};

  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return { input: normalized };
  }

  return { input: normalized };
};

const toStructuredPayload = (input: unknown): Record<string, unknown> => {
  if (!input) return {};
  if (typeof input === "string") {
    return parseStructuredToolInput(input);
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { input };
};

const formatToolPayload = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const normalizeRoleLike = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const compactLookupToken = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, "");
const extractFirstToken = (value: string): string => value.trim().split(/\s+/)[0] ?? "";

const toPlainObject = (value: unknown): Record<string, unknown> => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
};

const DELEGATE_TOOL_NAME = "delegate_task";
const PLAN_GSD_TOOL_NAME = "plan_gsd_project";
const REQUEST_CAPABILITY_TOOL_NAME = "request_capability";
const CREATE_SITE_PREVIEW_TOOL_NAME = "create_site_preview";
const MEMORY_SEARCH_TOOL_NAME = "memory_search";
const MEMORY_STORE_TOOL_NAME = "memory_store";
const MEMORY_RETRIEVE_TOOL_NAME = "memory_retrieve";
const SWARM_STATUS_TOOL_NAME = "swarm_status";
const AGENT_STATUS_TOOL_NAME = "agent_status";
const INSTAGRAM_PUBLISHER_TOOL_NAME = "instagram_publisher";
const DELEGATION_REWORK_LIMIT = 2;
const SKILL_ARTIFACTS_BUCKET = process.env.SKILL_ARTIFACTS_BUCKET ?? "office-artifacts";
const TASK_ARTIFACT_STATUS_READY: TaskArtifactStatus = "ready";
const TASK_ARTIFACT_STATUS_PROCESSING: TaskArtifactStatus = "processing";
const TASK_ARTIFACT_STATUS_FAILED: TaskArtifactStatus = "failed";
const GSD_PHASES = ["Capture", "Clarify", "Organize", "Reflect", "Engage"] as const;

const SKILL_ENDPOINT_ENV_BY_NAME: Record<string, string> = {
  vercel_project_deployer: "VERCEL_DEPLOYER_ENDPOINT",
};
const skillHttpAllowlist = (process.env.SKILL_HTTP_ALLOWLIST ?? "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const normalizeSkillName = (value: string): string => value.trim().toLowerCase();

const isAllowedSkillEndpoint = (endpoint: string): boolean => {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    ) {
      return false;
    }
    return skillHttpAllowlist.length === 0 || skillHttpAllowlist.includes(hostname);
  } catch {
    return false;
  }
};

const mergeToolNames = (current: string[], incoming: string[]): string[] =>
  Array.from(
    new Set(
      [...current, ...incoming]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  ).sort((left, right) => left.localeCompare(right));

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const pdfEscape = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const sanitizeFileName = (value: string, fallback: string): string => {
  const normalized = value.trim().replace(/[^a-zA-Z0-9\-_. ]+/g, "").replace(/\s+/g, "_");
  return normalized.length > 0 ? normalized : fallback;
};

const resolveArtifactType = (fileName: string, contentType: string): string => {
  const normalizedName = fileName.toLowerCase();
  const normalizedType = contentType.toLowerCase();
  if (normalizedType.includes("pdf") || normalizedName.endsWith(".pdf")) return "pdf";
  if (normalizedType.includes("spreadsheet") || normalizedName.endsWith(".xlsx") || normalizedName.endsWith(".xls")) {
    return "xlsx";
  }
  if (normalizedType.startsWith("image/")) return "image";
  if (normalizedType.startsWith("video/")) return "video";
  if (normalizedName.endsWith(".zip")) return "zip";
  return "file";
};

const toDataUrl = (contentType: string, payload: Buffer): string =>
  `data:${contentType};base64,${payload.toString("base64")}`;

const ensureStorageBucket = async (bucketName: string) => {
  try {
    await supabase.storage.createBucket(bucketName, { public: false });
  } catch {
    // Ignore, bucket may already exist or current key may not have bucket admin rights.
  }
};

const createStorageSignedUrl = async (
  bucketName: string,
  storagePath: string
): Promise<string | null> => {
  if (!isServerSupabaseConfigured || !storagePath) {
    return null;
  }

  try {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .createSignedUrl(storagePath, 60 * 60 * 24 * 30);

    if (error || typeof data?.signedUrl !== "string" || data.signedUrl.trim().length === 0) {
      console.error("[tools] failed to create signed URL:", error?.message ?? "missing_signed_url");
      return null;
    }

    return data.signedUrl;
  } catch (error) {
    console.error("[tools] unexpected signed URL error:", error);
    return null;
  }
};

const createTaskArtifactRecord = async ({
  officeId,
  taskId,
  role,
  skillName,
  title,
  storagePath,
  contentType,
  artifactType,
  metadata,
  status,
}: {
  officeId?: string | null;
  taskId?: string | null;
  role?: string | null;
  skillName: string;
  title: string;
  storagePath: string;
  contentType: string;
  artifactType: string;
  metadata?: Record<string, unknown> | null;
  status?: TaskArtifactStatus;
}): Promise<string | null> => {
  if (!isServerSupabaseConfigured || !officeId || !taskId || !storagePath) {
    return null;
  }

  try {
    const payload: Record<string, unknown> = {
      task_id: taskId,
      office_id: officeId,
      role: role ?? null,
      skill_name: skillName,
      artifact_type: artifactType,
      title,
      storage_bucket: SKILL_ARTIFACTS_BUCKET,
      storage_path: storagePath,
      mime_type: contentType,
      metadata: metadata ?? {},
    };
    if (status && status !== TASK_ARTIFACT_STATUS_READY) {
      payload.status = status;
    }
    const { data, error } = await supabase
      .from("task_artifacts")
      .insert(payload)
      .select("id")
      .single();

    if (error) {
      if (/task_artifacts|schema cache|could not find the table/i.test(error.message)) {
        console.warn("[tools] task_artifacts table is unavailable, skipping artifact row persistence.", {
          message: error.message,
          taskId,
          officeId,
          skillName,
        });
      } else {
        console.error("[tools] failed to persist task artifact:", error.message, payload);
      }
      return null;
    }

    return typeof data?.id === "string" ? data.id : null;
  } catch (error) {
    console.error("[tools] unexpected task artifact persistence error:", error);
    return null;
  }
};

const uploadArtifactToStorage = async (
  executionContext: OfficeSkillExecutionContext,
  skillName: string,
  fileName: string,
  contentType: string,
  payload: Buffer
): Promise<{
  url: string;
  artifactId: string | null;
  storagePath: string | null;
  bucket: string | null;
  artifactType: string;
  transport: "storage" | "data_url";
}> => {
  if (!isServerSupabaseConfigured) {
    return {
      url: toDataUrl(contentType, payload),
      artifactId: null,
      storagePath: null,
      bucket: null,
      artifactType: resolveArtifactType(fileName, contentType),
      transport: "data_url",
    };
  }

  const safeName = sanitizeFileName(fileName, `artifact-${Date.now()}`);
  const officeId =
    typeof executionContext.officeId === "string" && executionContext.officeId.trim().length > 0
      ? executionContext.officeId.trim()
      : null;
  const taskId =
    typeof executionContext.taskId === "string" && executionContext.taskId.trim().length > 0
      ? executionContext.taskId.trim()
      : null;
  const threadId =
    typeof executionContext.threadId === "string" && executionContext.threadId.trim().length > 0
      ? executionContext.threadId.trim()
      : null;
  const artifactId = randomUUID();
  const artifactType = resolveArtifactType(fileName, contentType);

  if (!officeId) {
    return {
      url: toDataUrl(contentType, payload),
      artifactId: null,
      storagePath: null,
      bucket: null,
      artifactType,
      transport: "data_url",
    };
  }

  const storagePath = taskId
    ? `${officeId}/${taskId}/${artifactId}-${safeName}`
    : `${officeId}/chat/${threadId ?? "adhoc"}/${artifactId}-${safeName}`;

  const upload = async () =>
    supabase.storage.from(SKILL_ARTIFACTS_BUCKET).upload(storagePath, payload, {
      upsert: true,
      contentType,
    });

  let uploadResult = await upload();
  if (uploadResult.error && /bucket|not found|404/i.test(uploadResult.error.message)) {
    await ensureStorageBucket(SKILL_ARTIFACTS_BUCKET);
    uploadResult = await upload();
  }

  if (uploadResult.error) {
    return {
      url: toDataUrl(contentType, payload),
      artifactId: null,
      storagePath: null,
      bucket: null,
      artifactType,
      transport: "data_url",
    };
  }

  const persistedArtifactId = taskId
    ? await createTaskArtifactRecord({
        officeId,
        taskId,
        role: executionContext.role ?? null,
        skillName,
        title: safeName,
        storagePath,
        contentType,
        artifactType,
        metadata: {
          fileName: safeName,
          byteLength: payload.length,
          threadId,
        },
      })
    : null;
  const signedUrl =
    persistedArtifactId ? `/api/task-artifacts/${persistedArtifactId}/download` : await createStorageSignedUrl(SKILL_ARTIFACTS_BUCKET, storagePath);
  if (!signedUrl) {
    return {
      url: toDataUrl(contentType, payload),
      artifactId: null,
      storagePath: null,
      bucket: null,
      artifactType,
      transport: "data_url",
    };
  }

  return {
    url: signedUrl,
    artifactId: persistedArtifactId,
    storagePath,
    bucket: SKILL_ARTIFACTS_BUCKET,
    artifactType,
    transport: "storage",
  };
};

const readJsonObject = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const parsed = await response.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const loadOfficeRoleCatalog = async (officeId?: string | null): Promise<OfficeRoleCatalog> => {
  const normalizedOfficeId = normalizeRoleLike(officeId);
  if (!isServerSupabaseConfigured || !normalizedOfficeId) {
    return {
      roles: [],
      byNormalizedRole: new Map<string, string>(),
    };
  }

  try {
    const { data, error } = await supabase
      .from("agents")
      .select("role")
      .eq("office_id", normalizedOfficeId);

    if (error || !Array.isArray(data)) {
      return {
        roles: [],
        byNormalizedRole: new Map<string, string>(),
      };
    }

    const byNormalizedRole = new Map<string, string>();
    for (const row of data as Array<Record<string, unknown>>) {
      const role = normalizeRoleLike(row.role);
      if (!role) continue;
      const normalizedRole = compactLookupToken(role);
      if (!normalizedRole || byNormalizedRole.has(normalizedRole)) continue;
      byNormalizedRole.set(normalizedRole, role);
    }

    const roles = Array.from(byNormalizedRole.values()).sort((left, right) => left.localeCompare(right));
    return { roles, byNormalizedRole };
  } catch (error) {
    console.error("[tools] failed to load office role catalog:", error);
    return {
      roles: [],
      byNormalizedRole: new Map<string, string>(),
    };
  }
};

const resolveGsdPhase = (index: number): (typeof GSD_PHASES)[number] => {
  return GSD_PHASES[Math.min(index, GSD_PHASES.length - 1)] ?? "Engage";
};

const buildQueuedVideoArtifactPath = (
  officeId: string,
  taskId: string,
  fileName: string
): string => {
  return `${officeId}/${taskId}/processing/${randomUUID()}-${sanitizeFileName(fileName, "queued-video.mp4")}`;
};

const createSimplePdfBuffer = (title: string, markdown: string): Buffer => {
  const source = `${title}\n\n${markdown}`.trim();
  const rawLines = source.split(/\r?\n/).flatMap((line) => {
    if (line.length <= 92) return [line];
    const chunks: string[] = [];
    for (let index = 0; index < line.length; index += 92) {
      chunks.push(line.slice(index, index + 92));
    }
    return chunks;
  });

  const lines = rawLines.slice(0, 52).map((line) => pdfEscape(line));
  const streamLines = [
    "BT",
    "/F1 11 Tf",
    "50 790 Td",
    "14 TL",
    ...lines.flatMap((line) => [`(${line}) Tj`, "T*"]),
    "ET",
  ];
  const streamContent = streamLines.join("\\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(streamContent, "utf8")} >>\nstream\n${streamContent}\nendstream`,
  ];

  let output = "%PDF-1.4\\n";
  const offsets: number[] = [0];

  objects.forEach((objectBody, index) => {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += `${index + 1} 0 obj\n${objectBody}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \\n";
  for (let index = 1; index < offsets.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(output, "utf8");
};

const zipCrcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
})();

const crc32 = (payload: Buffer): number => {
  let crc = 0xffffffff;
  for (let index = 0; index < payload.length; index += 1) {
    const byte = payload[index];
    crc = zipCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const buildZipArchive = (entries: Array<{ name: string; content: string }>): Buffer => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const contentBuffer = Buffer.from(entry.content, "utf8");
    const checksum = crc32(contentBuffer);
    const size = contentBuffer.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, contentBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + contentBuffer.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
};

const stripDangerousHtml = (html: string): string =>
  html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");

const stripHtmlCodeFence = (value: string): string => {
  const trimmed = value.trim();
  const htmlFence = trimmed.match(/^```(?:html|json|tool_code)?\s*([\s\S]*?)\s*```$/i);
  return htmlFence?.[1]?.trim() ?? trimmed;
};

const extractJsonHtmlPayload = (value: string): string | null => {
  const trimmed = stripHtmlCodeFence(value);
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  try {
    const parsed = JSON.parse(trimmed) as {
      html?: unknown;
      arguments?: { html?: unknown };
    };
    if (typeof parsed?.html === "string") return parsed.html;
    if (typeof parsed?.arguments?.html === "string") return parsed.arguments.html;
  } catch {
    return null;
  }

  return null;
};

const decodeWrappedJsonString = (value: string): string => {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    )
  ) {
    return value;
  }

  try {
    const decoded = JSON.parse(trimmed);
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
};

const extractCompleteHtmlDocument = (value: string): string => {
  const startMatch = /(?:<!doctype html>|<html[\s>])/i.exec(value);
  if (!startMatch) return value.trim();

  let html = value.slice(startMatch.index).trim();
  const endIndex = html.toLowerCase().lastIndexOf("</html>");
  if (endIndex !== -1) {
    html = html.slice(0, endIndex + "</html>".length);
  }

  return html.trim();
};

const previewImageDataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#0f172a"/><stop offset="1" stop-color="#0ea5e9"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="900" cy="170" r="180" fill="#ffffff" opacity=".12"/><path d="M210 560h780" stroke="#fff" stroke-width="32" stroke-linecap="round" opacity=".78"/><path d="M300 450h600" stroke="#fff" stroke-width="24" stroke-linecap="round" opacity=".52"/><text x="96" y="150" fill="#fff" font-family="Arial, sans-serif" font-size="62" font-weight="700">Фото товара</text></svg>'
)}`;

const replacePlaceholderImageUrls = (html: string): string =>
  html.replace(
    /https?:\/\/(?:via\.placeholder\.com|placehold\.co|dummyimage\.com)[^"'\s>]*/gi,
    previewImageDataUrl
  );

const normalizeSitePreviewHtmlPayload = (value: string): string => {
  let html = stripHtmlCodeFence(value);
  const jsonHtml = extractJsonHtmlPayload(html);
  if (jsonHtml) html = jsonHtml;

  html = decodeWrappedJsonString(html);
  html = stripHtmlCodeFence(html)
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\\t/g, "  ")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\//g, "/")
    .replace(/\\[ \t]*(\r?\n)/g, "$1")
    .replace(/\\(?=\s*(?:<!doctype|<\/?[a-z][\w:-]*\b))/gi, "\n");

  html = extractCompleteHtmlDocument(html);
  html = replacePlaceholderImageUrls(html);
  html = html.replace(/(&copy;|©)\s*20\d{2}/gi, `$1 ${new Date().getFullYear()}`);

  return html.trim();
};

const looksLikeToolChatter = (value: string): boolean =>
  /```|<tool_code>|tool_code|вызываю\s+инструмент|не\s+могу\s+создать|image_generator\s+недоступен|create_site_preview/i.test(
    value
  );

const hasTrailingContentAfterHtml = (value: string): boolean => {
  const endIndex = value.toLowerCase().lastIndexOf("</html>");
  if (endIndex === -1) return false;
  return value.slice(endIndex + "</html>".length).trim().length > 0;
};

const looksLikeEscapedOrWrappedHtml = (value: string): boolean =>
  /\\r\\n|\\n|\\\"|\\[ \t]*(?:\r?\n|<\/?[a-z][\w:-]*\b)|<\/html>\s*["']?\s*\\?\s*[\]}]/i.test(
    value
  );

const hasPlaceholderContent = (value: string): boolean =>
  /https?:\/\/(?:via\.placeholder\.com|placehold\.co|dummyimage\.com)\b|lorem ipsum/i.test(value);

const looksLikeUsableHtml = (value: string): boolean => {
  if (looksLikeToolChatter(value)) return false;
  if (looksLikeEscapedOrWrappedHtml(value)) return false;
  if (hasTrailingContentAfterHtml(value)) return false;
  if (hasPlaceholderContent(value)) return false;
  const hasHtmlStructure =
    /<html[\s>]/i.test(value) ||
    /<(main|section|article|header|footer|nav|div|h1|h2|p|ul|ol|form|style)[\s>]/i.test(value);
  const visibleText = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return hasHtmlStructure && visibleText.length >= 120;
};

const buildFallbackSitePreviewHtml = (input: {
  title: string;
  brief: string;
  primaryColor?: string | null;
}): string => {
  const title = xmlEscape(input.title || "Сайт");
  const brief = xmlEscape(input.brief || "Подберите подходящее решение и оставьте заявку на консультацию.");
  const accent = /^#[0-9a-f]{6}$/i.test(input.primaryColor ?? "") ? input.primaryColor! : "#e11d48";

  return stripDangerousHtml(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; --accent: ${accent}; --bg: #09090b; --panel: #18181b; --text: #fafafa; --muted: #a1a1aa; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    main { min-height: 100vh; }
    .wrap { width: min(1120px, calc(100% - 32px)); margin: 0 auto; }
    header { padding: 28px 0; display: flex; justify-content: space-between; align-items: center; gap: 18px; }
    .brand { font-weight: 800; letter-spacing: .02em; }
    .pill { border: 1px solid color-mix(in srgb, var(--accent), white 18%); color: #fff; padding: 10px 14px; border-radius: 999px; text-decoration: none; background: color-mix(in srgb, var(--accent), transparent 82%); }
    .hero { padding: 72px 0 56px; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(280px, .85fr); gap: 40px; align-items: center; }
    h1 { font-size: clamp(42px, 7vw, 82px); line-height: .92; margin: 0; letter-spacing: 0; }
    .lead { margin-top: 24px; color: var(--muted); font-size: clamp(18px, 2vw, 22px); line-height: 1.55; max-width: 720px; }
    .hero-card { min-height: 360px; border-radius: 8px; background: linear-gradient(135deg, color-mix(in srgb, var(--accent), #111 30%), #27272a); padding: 28px; display: grid; align-content: end; box-shadow: 0 24px 80px rgba(0,0,0,.32); }
    .metric { font-size: 56px; font-weight: 850; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; padding: 24px 0 72px; }
    section h2 { margin: 0 0 18px; font-size: 28px; }
    .item { border: 1px solid rgba(255,255,255,.10); background: var(--panel); border-radius: 8px; padding: 22px; min-height: 160px; }
    .item h3 { margin: 0 0 10px; font-size: 18px; }
    .item p { margin: 0; color: var(--muted); line-height: 1.5; }
    .cta { margin: 0 0 64px; padding: 34px; border-radius: 8px; background: #fff; color: #09090b; display: flex; justify-content: space-between; align-items: center; gap: 20px; }
    .cta a { background: var(--accent); color: #fff; padding: 13px 18px; border-radius: 6px; text-decoration: none; font-weight: 700; }
    @media (max-width: 820px) { .hero { grid-template-columns: 1fr; padding-top: 42px; } .grid { grid-template-columns: 1fr; } .cta { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <div class="wrap">
      <header><div class="brand">${title}</div><a class="pill" href="#contact">Обсудить заказ</a></header>
      <section class="hero">
        <div>
          <h1>${title}</h1>
          <p class="lead">${brief}</p>
        </div>
        <div class="hero-card"><div class="metric">100%</div><p>Витрина, которая быстро объясняет предложение, показывает преимущества и ведет клиента к заявке.</p></div>
      </section>
      <section><h2>Что внутри</h2><div class="grid">
        <article class="item"><h3>Подбор</h3><p>Помогаем быстро выбрать подходящее решение под интерьер, бюджет и сценарий использования.</p></article>
        <article class="item"><h3>Качество</h3><p>Показываем ключевые преимущества: надежные материалы, понятная гарантия и аккуратная установка.</p></article>
        <article class="item"><h3>Сервис</h3><p>Оставляем понятный путь к заявке: консультация, подбор, доставка и сопровождение.</p></article>
      </div></section>
      <section><h2>Преимущества</h2><div class="grid">
        <article class="item"><h3>Визуальный выбор</h3><p>Карточки товаров, акцентные блоки и понятные категории помогают клиенту не потеряться.</p></article>
        <article class="item"><h3>Быстрая заявка</h3><p>Контактный блок всегда рядом, поэтому посетитель может перейти от интереса к действию.</p></article>
        <article class="item"><h3>Адаптивность</h3><p>Страница корректно выглядит на телефоне, планшете и широком экране.</p></article>
      </div></section>
      <section id="contact" class="cta"><div><strong>Нужна консультация?</strong><br />Оставьте заявку, и мы поможем подобрать лучшее решение.</div><a href="mailto:hello@example.com">Связаться</a></section>
    </div>
  </main>
</body>
</html>`);
};

const buildSitePreviewHtml = (input: {
  title: string;
  brief: string;
  primaryColor?: string | null;
  html?: string | null;
}): string => {
  let rawHtml = typeof input.html === "string" ? normalizeSitePreviewHtmlPayload(input.html) : "";

  if (looksLikeUsableHtml(rawHtml)) {
    if (!/<html[\s>]/i.test(rawHtml)) {
      const hasHead = /<head[\s>]/i.test(rawHtml);
      const hasBody = /<body[\s>]/i.test(rawHtml);
      if (!hasHead && !hasBody) {
        rawHtml = `<!doctype html>\n<html lang="ru">\n<head><meta charset="utf-8"/><title>${input.title || "Preview"}</title></head>\n<body>\n${rawHtml}\n</body>\n</html>`;
      } else {
        rawHtml = `<!doctype html>\n<html lang="ru">\n${rawHtml}\n</html>`;
      }
    }
    return stripDangerousHtml(rawHtml);
  }

  return buildFallbackSitePreviewHtml(input);
};

const validateSitePreviewHtml = (html: string): { passed: boolean; issues: string[] } => {
  const issues: string[] = [];
  if (!/<html[\s>]/i.test(html)) issues.push("missing_html_root");
  if (!/<title>[^<]*<\/title>/i.test(html)) issues.push("missing_title");
  if (html.length < 1200) issues.push("html_too_short");
  if (looksLikeToolChatter(html)) issues.push("tool_chatter_in_html");
  if (looksLikeEscapedOrWrappedHtml(html)) issues.push("escaped_or_wrapped_html");
  if (hasTrailingContentAfterHtml(html)) issues.push("trailing_content_after_html");
  if (hasPlaceholderContent(html)) issues.push("placeholder_content");
  if (!/<(main|section|article|header|footer|h1|h2)[\s>]/i.test(html)) issues.push("missing_page_sections");
  if (/javascript:/i.test(html) || /<script[\s>]/i.test(html) || /\son[a-z]+\s*=/i.test(html)) {
    issues.push("dangerous_inline_script");
  }
  return { passed: issues.length === 0, issues };
};

const toColumnLetters = (columnIndex: number): string => {
  let current = columnIndex + 1;
  let result = "";
  while (current > 0) {
    const mod = (current - 1) % 26;
    result = String.fromCharCode(65 + mod) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
};

interface ExcelSheetPayload {
  sheet_name?: unknown;
  data_json?: unknown;
}

const parseExcelRows = (value: unknown): Array<Record<string, unknown>> => {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is Record<string, unknown> =>
        row !== null && typeof row === "object" && !Array.isArray(row)
    );
  } catch {
    return [];
  }
};

const buildWorksheetXml = (rows: Array<Record<string, unknown>>): string => {
  const columns = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row).map((key) => key.trim()).filter((key) => key.length > 0)))
  );

  if (columns.length === 0) {
    columns.push("Data");
  }

  const allRows: Array<Array<unknown>> = [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))];

  const xmlRows = allRows
    .map((row, rowIndex) => {
      const cellXml = row
        .map((cell, columnIndex) => {
          const cellRef = `${toColumnLetters(columnIndex)}${rowIndex + 1}`;
          if (typeof cell === "number" && Number.isFinite(cell)) {
            return `<c r="${cellRef}"><v>${cell}</v></c>`;
          }
          if (typeof cell === "boolean") {
            return `<c r="${cellRef}" t="b"><v>${cell ? 1 : 0}</v></c>`;
          }
          const text = xmlEscape(String(cell ?? ""));
          return `<c r="${cellRef}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cellXml}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${xmlRows}</sheetData>
</worksheet>`;
};

const buildWorkbookBuffer = (sheets: Array<{ name: string; rows: Array<Record<string, unknown>> }>): Buffer => {
  const normalizedSheets = sheets.length > 0 ? sheets : [{ name: "Sheet1", rows: [] }];

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${normalizedSheets
      .map(
        (sheet, index) =>
          `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
      )
      .join("")}
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${normalizedSheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )
    .join("")}
  <Relationship Id="rId${normalizedSheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${normalizedSheets
    .map(
      (_sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join("")}
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const entries: Array<{ name: string; content: string }> = [
    { name: "[Content_Types].xml", content: contentTypesXml },
    { name: "_rels/.rels", content: relsXml },
    { name: "xl/workbook.xml", content: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRelsXml },
    { name: "xl/styles.xml", content: stylesXml },
    ...normalizedSheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: buildWorksheetXml(sheet.rows),
    })),
  ];

  return buildZipArchive(entries);
};

const resolveGeminiApiKey = (): string | null => {
  const value =
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    null;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

const resolveImagenAspectRatio = (value: unknown): "1:1" | "16:9" | "9:16" => {
  if (value === "1:1" || value === "16:9" || value === "9:16") return value;
  return "16:9";
};

type ImageModelTransport = "gemini_generate_content" | "imagen_predict";

interface ImageModelCandidate {
  model: string;
  label: string;
  transport: ImageModelTransport;
}

interface VideoModelCandidate {
  model: string;
  label: string;
}

const IMAGE_MODEL_FALLBACK_CHAIN: ImageModelCandidate[] = [
  {
    model: "gemini-3-pro-image-preview",
    label: "Nano Banana Pro",
    transport: "gemini_generate_content",
  },
  {
    model: "gemini-2.5-flash-image",
    label: "Nano Banana",
    transport: "gemini_generate_content",
  },
  {
    model: "imagen-4.0-fast-generate-001",
    label: "Imagen 4 Fast",
    transport: "imagen_predict",
  },
];

const VIDEO_MODEL_FALLBACK_CHAIN: VideoModelCandidate[] = [
  {
    model: "veo-3.1-generate-preview",
    label: "Veo 3.1 Preview",
  },
  {
    model: "veo-3.0-generate-001",
    label: "Veo 3.0",
  },
  {
    model: "veo-3.1-fast-generate-preview",
    label: "Veo 3.1 Fast",
  },
  {
    model: "veo-3.0-fast-generate-001",
    label: "Veo 3.0 Fast",
  },
  {
    model: "veo-3.1-lite-generate-preview",
    label: "Veo 3.1 Lite",
  },
];

const buildAutomaticImagePrompt = (prompt: string): string => {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return normalizedPrompt;
  }

  return [
    normalizedPrompt,
    "Automatic art-direction refinement:",
    "- Build a visually strong hero image with one clear focal subject and a readable composition.",
    "- Use layered foreground, midground, and background depth when appropriate.",
    "- Preserve the explicitly requested culture, country, holiday, brand, clothing, food, architecture, symbols, props, typography, and landscape from the brief.",
    "- If the brief includes an official logo or reference asset, treat it as authoritative and do not invent a replacement brand mark or unrelated symbol.",
    "- Do not substitute another culture, ethnicity, city, country, festival, or generic stock scene.",
    "- Preserve the requested style, mood, atmosphere, palette, and subject matter from the brief.",
    "- Prefer premium editorial or cinematic composition instead of generic marketplace imagery.",
    "- If the brief implies people, render anatomically correct, natural, expressive faces and hands with realistic proportions.",
    "- Avoid extra fingers, duplicated people, warped eyes, distorted anatomy, blurry facial features, and unrelated props.",
    "- Keep culturally specific garments, food, ornaments, architecture, and visual symbols authentic to the brief.",
  ].join("\n");
};

const resolveVideoAspectRatio = (value: unknown): "16:9" | "9:16" => {
  if (value === "16:9" || value === "9:16") return value;
  return "16:9";
};

const resolveVideoDurationSeconds = (value: unknown): "4" | "6" | "8" => {
  const normalized = String(value ?? "").trim();
  if (normalized === "4" || normalized === "6" || normalized === "8") return normalized;
  const numeric = Number(value);
  if (numeric === 4 || numeric === 6 || numeric === 8) {
    return String(numeric) as "4" | "6" | "8";
  }
  return "6";
};

const resolveVideoResolution = (value: unknown): "720p" | "1080p" | "4k" => {
  if (value === "720p" || value === "1080p" || value === "4k") return value;
  return "720p";
};

const resolveVideoPersonGeneration = (value: unknown): "allow_all" | "allow_adult" | "dont_allow" => {
  if (value === "allow_all" || value === "allow_adult" || value === "dont_allow") return value;
  return "allow_all";
};

const buildAutomaticVideoPrompt = (prompt: string): string => {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return normalizedPrompt;
  }

  return [
    normalizedPrompt,
    "Automatic video-direction refinement:",
    "- Build a premium short-form video concept with a clear subject, clear action, and a readable emotional arc.",
    "- Preserve the explicitly requested culture, country, brand, holiday, clothing, props, symbols, architecture, and environment from the brief.",
    "- If the brief includes an official logo or reference asset, treat it as authoritative and do not invent a replacement brand mark or unrelated symbol.",
    "- Do not substitute another culture, ethnicity, city, country, festival, or generic stock footage scenario.",
    "- Specify cinematic motion through camera movement, staging, framing, and depth, but keep the scene coherent and physically plausible.",
    "- Prefer premium cinematic, editorial, or commercial-quality direction over generic slideshow or marketplace visuals.",
    "- Faces, hands, body motion, lip sync, and anatomy must look natural and believable.",
    "- Avoid distorted anatomy, jitter, flicker, duplicated limbs, broken object continuity, random scene swaps, warped eyes, and unrelated props.",
    "- Keep lighting, palette, wardrobe, art direction, and mood consistent across the whole clip.",
    "- If the brief implies sound, use subtle native ambient or cinematic audio cues that match the scene.",
  ].join("\n");
};

const shouldFallbackToNextImageModel = (status: number, errorMessage: string): boolean => {
  const normalized = errorMessage.toLowerCase();
  return (
    status === 429 ||
    status === 403 ||
    status === 404 ||
    status >= 500 ||
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("resource_exhausted") ||
    normalized.includes("permission") ||
    normalized.includes("not found")
  );
};

const extractInlineImageFromGeminiResponse = (payload: Record<string, unknown>): string | null => {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const content =
      candidate && typeof candidate === "object"
        ? (candidate as Record<string, unknown>).content
        : null;
    const parts =
      content && typeof content === "object" && Array.isArray((content as Record<string, unknown>).parts)
        ? ((content as Record<string, unknown>).parts as Array<Record<string, unknown>>)
        : [];

    for (const part of parts) {
      const inlineData =
        part.inlineData && typeof part.inlineData === "object"
          ? (part.inlineData as Record<string, unknown>)
          : part.inline_data && typeof part.inline_data === "object"
            ? (part.inline_data as Record<string, unknown>)
            : null;
      const data =
        inlineData && typeof inlineData.data === "string" && inlineData.data.trim().length > 0
          ? inlineData.data.trim()
          : null;
      if (data) return data;
    }
  }

  return null;
};

const requestGeminiNativeImage = async (
  apiKey: string,
  model: string,
  prompt: string
): Promise<{
  ok: boolean;
  status: number;
  imageBase64?: string | null;
  errorMessage?: string;
}> => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
    }
  );

  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const apiError =
      typeof (data.error as Record<string, unknown> | undefined)?.message === "string"
        ? String((data.error as Record<string, unknown>).message)
        : JSON.stringify(data);
    return {
      ok: false,
      status: response.status,
      errorMessage: apiError,
    };
  }

  const imageBase64 = extractInlineImageFromGeminiResponse(data);
  if (!imageBase64) {
    return {
      ok: false,
      status: response.status,
      errorMessage: "Gemini image model returned no inline image data.",
    };
  }

  return {
    ok: true,
    status: response.status,
    imageBase64,
  };
};

const requestImagenPredictImage = async (
  apiKey: string,
  model: string,
  prompt: string,
  aspectRatio: "1:1" | "16:9" | "9:16"
): Promise<{
  ok: boolean;
  status: number;
  imageBase64?: string | null;
  errorMessage?: string;
}> => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio,
        },
      }),
    }
  );

  const data = (await response.json()) as {
    predictions?: Array<{ bytesBase64Encoded?: string }>;
    error?: { message?: string };
    [key: string]: unknown;
  };

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      errorMessage:
        typeof data.error?.message === "string" ? data.error.message : JSON.stringify(data),
    };
  }

  const imageBase64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
    return {
      ok: false,
      status: response.status,
      errorMessage: "Imagen model returned no image bytes.",
    };
  }

  return {
    ok: true,
    status: response.status,
    imageBase64,
  };
};

const executeImagenSkill = async (
  payload: Record<string, unknown>,
  executionContext: OfficeSkillExecutionContext = {}
): Promise<string> => {
  const prompt =
    typeof payload.prompt === "string" && payload.prompt.trim().length > 0
      ? payload.prompt.trim()
      : typeof payload.input === "string" && payload.input.trim().length > 0
        ? payload.input.trim()
        : "";

  if (!prompt) {
    return "[Tool Error]: image_generator prompt is required.";
  }

  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    return "[Tool Error]: GEMINI_API_KEY is not configured for image generation.";
  }

  const aspectRatio = resolveImagenAspectRatio(payload.aspect_ratio);
  const effectivePrompt = buildAutomaticImagePrompt(prompt);
  const attemptErrors: string[] = [];

  try {
    for (const candidate of IMAGE_MODEL_FALLBACK_CHAIN) {
        console.info("[image_generator] attempting model", {
          model: candidate.model,
          label: candidate.label,
          transport: candidate.transport,
          role: executionContext.role ?? null,
          officeId: executionContext.officeId ?? null,
          promptPreview: effectivePrompt.slice(0, 280),
        });

      const result =
        candidate.transport === "gemini_generate_content"
          ? await requestGeminiNativeImage(apiKey, candidate.model, effectivePrompt)
          : await requestImagenPredictImage(apiKey, candidate.model, effectivePrompt, aspectRatio);

      if (!result.ok || !result.imageBase64) {
        const normalizedError = result.errorMessage ?? "unknown_error";
        attemptErrors.push(`${candidate.model}: ${normalizedError}`);
        console.warn("[image_generator] model attempt failed", {
          model: candidate.model,
          label: candidate.label,
          status: result.status,
          error: normalizedError,
        });

        if (shouldFallbackToNextImageModel(result.status, normalizedError)) {
          continue;
        }

        return `[Tool Error]: ${candidate.label} (${candidate.model}) failed: ${normalizedError}`;
      }

      const imageBuffer = Buffer.from(result.imageBase64, "base64");
      const uploaded = await uploadArtifactToStorage(
        executionContext,
        "image_generator",
        `generated-image-${Date.now()}.jpg`,
        "image/jpeg",
        imageBuffer
      );

      if (uploaded.transport === "data_url" && executionContext.officeId) {
        return `[Tool Error]: ${candidate.label} created the image, but upload to office-artifacts failed.`;
      }

      return [
        `![Сгенерированное изображение](${uploaded.url})`,
        `[Скачать изображение.jpg](${uploaded.url})`,
      ].join("\n\n");
    }

    return `[Tool Error]: All configured image models failed. Attempts: ${attemptErrors.join(" | ")}`;
  } catch (error) {
    return `[Tool Error]: Network or internal error during image generation: ${
      error instanceof Error ? error.message : "unknown_error"
    }`;
  }
};

const executeInstagramPublisherSkill = async (payload: Record<string, unknown>): Promise<string> => {
  const imageUrl =
    typeof payload.image_url === "string" && payload.image_url.trim().length > 0
      ? payload.image_url.trim()
      : "";
  const caption =
    typeof payload.caption === "string" && payload.caption.trim().length > 0
      ? payload.caption.trim()
      : "";

  if (!imageUrl || !caption) {
    return "[Tool Error]: instagram_publisher requires image_url and caption.";
  }

  const token = process.env.INSTAGRAM_ACCESS_TOKEN?.trim() ?? "";
  const igUserId = process.env.INSTAGRAM_ACCOUNT_ID?.trim() ?? "";
  if (!token || !igUserId) {
    return "[Tool Error]: instagram_publisher is not configured. Publishing requires INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID plus explicit approval.";
  }

  try {
    const containerParams = new URLSearchParams({
      image_url: imageUrl,
      caption,
      access_token: token,
    });
    const containerRes = await fetch(
      `https://graph.facebook.com/v18.0/${igUserId}/media?${containerParams.toString()}`,
      { method: "POST" }
    );
    const containerData = await readJsonObject(containerRes);
    const creationId =
      typeof containerData.id === "string" && containerData.id.trim().length > 0
        ? containerData.id.trim()
        : "";

    if (!containerRes.ok || !creationId) {
      const errorMessage =
        typeof containerData.error === "object" &&
        containerData.error &&
        typeof (containerData.error as Record<string, unknown>).message === "string"
          ? String((containerData.error as Record<string, unknown>).message)
          : JSON.stringify(containerData);
      return `[Tool Error]: Instagram container creation failed: ${errorMessage}`;
    }

    const publishParams = new URLSearchParams({
      creation_id: creationId,
      access_token: token,
    });
    const publishRes = await fetch(
      `https://graph.facebook.com/v18.0/${igUserId}/media_publish?${publishParams.toString()}`,
      { method: "POST" }
    );
    const publishData = await readJsonObject(publishRes);
    const publishedId =
      typeof publishData.id === "string" && publishData.id.trim().length > 0
        ? publishData.id.trim()
        : creationId;

    if (!publishRes.ok) {
      const errorMessage =
        typeof publishData.error === "object" &&
        publishData.error &&
        typeof (publishData.error as Record<string, unknown>).message === "string"
          ? String((publishData.error as Record<string, unknown>).message)
          : JSON.stringify(publishData);
      return `[Tool Error]: Instagram publish failed: ${errorMessage}`;
    }

    return `Пост успешно опубликован в Instagram. Publish ID: ${publishedId}`;
  } catch (error) {
    return `[Tool Error]: Instagram publish request failed: ${
      error instanceof Error ? error.message : "unknown_error"
    }`;
  }
};

const extractVeoOperationName = (payload: Record<string, unknown>): string | null => {
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  return name.length > 0 ? name : null;
};

const extractVeoErrorMessage = (payload: Record<string, unknown>): string | null => {
  const error =
    payload.error && typeof payload.error === "object"
      ? (payload.error as Record<string, unknown>)
      : null;
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  return message.length > 0 ? message : null;
};

const extractVeoVideoUri = (payload: Record<string, unknown>): string | null => {
  const response =
    payload.response && typeof payload.response === "object"
      ? (payload.response as Record<string, unknown>)
      : null;
  const generateVideoResponse =
    response?.generateVideoResponse && typeof response.generateVideoResponse === "object"
      ? (response.generateVideoResponse as Record<string, unknown>)
      : null;
  const generatedSamples = Array.isArray(generateVideoResponse?.generatedSamples)
    ? (generateVideoResponse?.generatedSamples as Array<Record<string, unknown>>)
    : [];
  const firstSample = generatedSamples[0];
  const video =
    firstSample?.video && typeof firstSample.video === "object"
      ? (firstSample.video as Record<string, unknown>)
      : null;
  const uri = typeof video?.uri === "string" ? video.uri.trim() : "";
  return uri.length > 0 ? uri : null;
};

const wait = (durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs));

const requestVeoOperation = async (
  apiKey: string,
  model: string,
  prompt: string,
  config: {
    aspectRatio: "16:9" | "9:16";
    durationSeconds: "4" | "6" | "8";
    resolution: "720p" | "1080p" | "4k";
    personGeneration: "allow_all" | "allow_adult" | "dont_allow";
  }
): Promise<{
  ok: boolean;
  status: number;
  operationName?: string | null;
  errorMessage?: string;
}> => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: config,
      }),
    }
  );

  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      errorMessage: extractVeoErrorMessage(data) ?? JSON.stringify(data),
    };
  }

  const operationName = extractVeoOperationName(data);
  if (!operationName) {
    return {
      ok: false,
      status: response.status,
      errorMessage: "Veo did not return an operation name.",
    };
  }

  return {
    ok: true,
    status: response.status,
    operationName,
  };
};

const pollVeoOperation = async (
  apiKey: string,
  operationName: string,
  timeoutMs = 180_000,
  pollIntervalMs = 10_000
): Promise<{
  ok: boolean;
  status: number;
  videoUri?: string | null;
  errorMessage?: string;
}> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${operationName}`,
      {
        method: "GET",
        headers: {
          "x-goog-api-key": apiKey,
        },
      }
    );

    const data = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        errorMessage: extractVeoErrorMessage(data) ?? JSON.stringify(data),
      };
    }

    if (data.done === true) {
      const operationError = extractVeoErrorMessage(data);
      if (operationError) {
        return {
          ok: false,
          status: 500,
          errorMessage: operationError,
        };
      }

      const videoUri = extractVeoVideoUri(data);
      if (!videoUri) {
        return {
          ok: false,
          status: 500,
          errorMessage: "Veo operation completed without a downloadable video URI.",
        };
      }

      return {
        ok: true,
        status: response.status,
        videoUri,
      };
    }

    await wait(pollIntervalMs);
  }

  return {
    ok: false,
    status: 408,
    errorMessage: "Veo video generation timed out while waiting for the long-running operation.",
  };
};

const downloadVeoVideo = async (
  apiKey: string,
  videoUri: string
): Promise<{
  ok: boolean;
  status: number;
  buffer?: Buffer;
  errorMessage?: string;
}> => {
  const response = await fetch(videoUri, {
    method: "GET",
    headers: {
      "x-goog-api-key": apiKey,
    },
    redirect: "follow",
  });

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = response.statusText;
    }
    return {
      ok: false,
      status: response.status,
      errorMessage: body || response.statusText,
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    ok: true,
    status: response.status,
    buffer: Buffer.from(arrayBuffer),
  };
};

const executeVeoSkill = async (
  payload: Record<string, unknown>,
  executionContext: OfficeSkillExecutionContext = {}
): Promise<string> => {
  const prompt =
    typeof payload.prompt === "string" && payload.prompt.trim().length > 0
      ? payload.prompt.trim()
      : typeof payload.input === "string" && payload.input.trim().length > 0
        ? payload.input.trim()
        : "";

  if (!prompt) {
    return "[Tool Error]: video_generator prompt is required.";
  }

  const config = {
    aspectRatio: resolveVideoAspectRatio(payload.aspect_ratio),
    durationSeconds: resolveVideoDurationSeconds(payload.duration_seconds),
    resolution: resolveVideoResolution(payload.resolution),
    personGeneration: resolveVideoPersonGeneration(payload.person_generation),
  };
  const effectivePrompt = buildAutomaticVideoPrompt(prompt);
  const officeId = normalizeRoleLike(executionContext.officeId);
  const taskId = normalizeRoleLike(executionContext.taskId);
  const threadId = normalizeRoleLike(executionContext.threadId);
  if (!isServerSupabaseConfigured || !officeId || !taskId) {
    return "Задача поставлена в очередь. Продолжай работу, видео появится в артефактах позже.";
  }

  const fileName = `generated-video-${Date.now()}.mp4`;
  const artifactId = await createTaskArtifactRecord({
    officeId,
    taskId,
    role: executionContext.role ?? null,
    skillName: "video_generator",
    title: fileName,
    storagePath: buildQueuedVideoArtifactPath(officeId, taskId, fileName),
    contentType: "video/mp4",
    artifactType: "video",
    status: TASK_ARTIFACT_STATUS_PROCESSING,
    metadata: {
      source: "video_generator",
      queuedAt: new Date().toISOString(),
      threadId,
      prompt: effectivePrompt,
      generationConfig: config,
      requiresBackgroundWorker: true,
      apiKeyConfigured: Boolean(resolveGeminiApiKey()),
    },
  });

  if (!artifactId) {
    return "[Tool Error]: video_generator could not queue the artifact in task_artifacts.";
  }

  return `Генерация видео запущена в фоне. Артефакт ID: ${artifactId} добавлен в БД со статусом processing. Тебе не нужно ждать, переходи к следующей задаче.`;
};

const executeExternalProvider = async (
  skillName: string,
  payload: Record<string, unknown>
): Promise<string | null> => {
  const endpointEnv = SKILL_ENDPOINT_ENV_BY_NAME[skillName];
  if (!endpointEnv) return null;
  const endpoint = process.env[endpointEnv];
  if (!endpoint) {
    return `Skill '${skillName}' is ready, but ${endpointEnv} is not configured.`;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill: skillName, input: payload }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? formatToolPayload(await response.json())
      : await response.text();
    if (!response.ok) {
      return `Skill '${skillName}' provider failed with ${response.status}: ${body}`;
    }
    return body || `Skill '${skillName}' completed.`;
  } catch (error) {
    return `Skill '${skillName}' provider request failed: ${
      error instanceof Error ? error.message : "unknown_error"
    }`;
  }
};

const executeManagedSkill = async (
  definition: OfficeSkillToolDefinition,
  payload: Record<string, unknown>,
  executionContext: OfficeSkillExecutionContext = {}
): Promise<string | null> => {
  const skillName = normalizeSkillName(definition.name);

  if (skillName === "pdf_document_generator" || skillName === "pdf_generator") {
    const title =
      typeof payload.title === "string" && payload.title.trim().length > 0 ? payload.title.trim() : "Document";
    const markdown =
      typeof payload.content_markdown === "string" ? payload.content_markdown : String(payload.input ?? "");
    const template =
      typeof payload.template === "string" && payload.template.trim().length > 0 ? payload.template.trim() : "report";
    const pdfBuffer = createSimplePdfBuffer(title, markdown);
    const uploaded = await uploadArtifactToStorage(
      executionContext,
      skillName,
      `${sanitizeFileName(title, "document")}.pdf`,
      "application/pdf",
      pdfBuffer
    );

    return [
      `PDF generated using template '${template}'.`,
      `Title: ${title}`,
      uploaded.artifactId ? `[рџ“Ґ Download PDF](${uploaded.url})` : `URL: ${uploaded.url}`,
      uploaded.storagePath ? `Storage path: ${uploaded.storagePath}` : null,
    ]
      .filter(Boolean)
      .join("\\n");
  }

  if (skillName === "excel_report_builder" || skillName === "excel_builder") {
    const filename =
      typeof payload.filename === "string" && payload.filename.trim().length > 0
        ? payload.filename.trim()
        : "report";
    const rawSheets = Array.isArray(payload.sheets) ? (payload.sheets as ExcelSheetPayload[]) : [];
    const sheets = rawSheets
      .map((sheet, index) => {
        const nameSource =
          typeof sheet.sheet_name === "string" && sheet.sheet_name.trim().length > 0
            ? sheet.sheet_name.trim()
            : `Sheet${index + 1}`;
        const safeSheetName = nameSource.replace(/[\\/*?:[\]]/g, " ").slice(0, 31).trim() || `Sheet${index + 1}`;
        const rows = parseExcelRows(sheet.data_json);
        return { name: safeSheetName, rows };
      })
      .slice(0, 10);

    const workbook = buildWorkbookBuffer(sheets);
    const uploaded = await uploadArtifactToStorage(
      executionContext,
      skillName,
      `${sanitizeFileName(filename, "report")}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      workbook
    );

    return [
      `Excel report generated with ${Math.max(1, sheets.length)} sheet(s).`,
      uploaded.artifactId ? `[рџ“Ґ Download XLSX](${uploaded.url})` : `URL: ${uploaded.url}`,
      uploaded.storagePath ? `Storage path: ${uploaded.storagePath}` : null,
    ]
      .filter(Boolean)
      .join("\\n");
  }

  if (skillName === "image_generator") {
    return executeImagenSkill(payload, executionContext);
  }

  if (skillName === "video_generator") {
    return executeVeoSkill(payload, executionContext);
  }

  if (skillName === INSTAGRAM_PUBLISHER_TOOL_NAME) {
    return executeInstagramPublisherSkill(payload);
  }

  if (skillName === "vercel_project_deployer") {
    return executeExternalProvider(skillName, payload);
  }

  return null;
};

const executeHttpSkill = async (
  definition: OfficeSkillToolDefinition,
  input: Record<string, unknown>,
  executionContext: OfficeSkillExecutionContext = {}
): Promise<string> => {
  const payload = toStructuredPayload(input);
  const managedResult = await executeManagedSkill(definition, payload, executionContext);
  if (managedResult) {
    return managedResult;
  }

  if (!definition.endpoint) {
    return `Skill '${definition.name}' has no endpoint configured.`;
  }
  if (!isAllowedSkillEndpoint(definition.endpoint)) {
    return `tool_denied: HTTP endpoint for skill '${definition.name}' is not allowlisted.`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(definition.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Digital-Pixel-Skill": definition.name,
      },
      body: JSON.stringify({
        skill: definition.name,
        input: payload,
        schema: definition.parameterSchema ?? null,
      }),
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? formatToolPayload(await response.json())
      : await response.text();

    if (!response.ok) {
      return `Skill '${definition.name}' failed with ${response.status}: ${body}`;
    }

    return body || `Skill '${definition.name}' completed with empty response.`;
  } catch (error) {
    return `Skill '${definition.name}' request failed: ${
      error instanceof Error ? error.message : "unknown_error"
    }`;
  } finally {
    clearTimeout(timer);
  }
};

const executeInternalSkill = async (
  definition: OfficeSkillToolDefinition,
  input: Record<string, unknown>,
  executionContext: OfficeSkillExecutionContext = {}
): Promise<string> => {
  const payload = toStructuredPayload(input);
  const normalizedName = definition.name.toLowerCase();

  const managedResult = await executeManagedSkill(definition, payload, executionContext);
  if (managedResult) {
    return managedResult;
  }

  if (normalizedName === "document-draft" || normalizedName === "document_draft") {
    const title =
      typeof payload.title === "string" && payload.title.trim().length > 0
        ? payload.title.trim()
        : "Draft";
    const brief =
      typeof payload.brief === "string"
        ? payload.brief
        : typeof payload.input === "string"
          ? payload.input
          : "";
    return `# ${title}\n\n## Goal\n${brief || "Prepare a structured draft."}\n\n## Outline\n- Context\n- Proposed solution\n- Risks\n- Next actions\n`;
  }

  if (normalizedName === "terminal_bash_executor") {
    const command =
      typeof payload.command === "string"
        ? payload.command.trim()
        : typeof payload.input === "string"
          ? payload.input.trim()
          : "";

    if (!command) {
      return "terminal_bash_executor: command is required.";
    }

    if (/(^|\s)(nano|vim|vi|top|htop)\b/i.test(command)) {
      return "terminal_bash_executor: interactive commands are blocked. Use non-interactive commands only.";
    }

    return [
      "terminal_bash_executor received the command.",
      `Command: ${command}`,
      "Execution is restricted in this deployment profile. Run via secure sandbox/CI executor.",
    ].join("\\n");
  }

  return [
    `Internal skill '${definition.name}' executed.`,
    definition.implementationRef ? `Implementation ref: ${definition.implementationRef}` : null,
    `Payload: ${formatToolPayload(payload)}`,
  ]
    .filter(Boolean)
    .join("\\n");
};

const buildZodFieldSchema = (
  fieldName: string,
  schema: Record<string, unknown>,
  requiredFields: Set<string>
): ZodTypeAny => {
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  if (enumValues.length > 0) {
    let enumSchema: ZodTypeAny = z.enum(enumValues as [string, ...string[]]);
    if (!requiredFields.has(fieldName)) {
      enumSchema = enumSchema.optional();
    }
    return enumSchema;
  }

  const fieldType = typeof schema.type === "string" ? schema.type : "string";
  let nextSchema: ZodTypeAny;
  if (fieldType === "number") {
    nextSchema = z.coerce.number();
  } else if (fieldType === "integer") {
    nextSchema = z.coerce.number().int();
  } else if (fieldType === "boolean") {
    nextSchema = z.coerce.boolean();
  } else if (fieldType === "array") {
    const items = schema.items && typeof schema.items === "object" ? (schema.items as Record<string, unknown>) : {};
    nextSchema =
      items.type === "string"
        ? z.array(z.string())
        : z.array(z.any());
  } else if (fieldType === "string") {
    nextSchema = z.string();
  } else {
    console.warn(`[tools] Unsupported JSON schema type '${fieldType}' for '${fieldName}', fallback to string.`);
    nextSchema = z.string();
  }

  if (!requiredFields.has(fieldName)) {
    nextSchema = nextSchema.optional();
  }

  return nextSchema;
};

const buildOfficeToolSchema = (parameterSchema?: Record<string, unknown> | null) => {
  const properties =
    parameterSchema?.properties && typeof parameterSchema.properties === "object"
      ? (parameterSchema.properties as Record<string, unknown>)
      : {};
  const requiredFields = new Set(
    Array.isArray(parameterSchema?.required)
      ? parameterSchema.required.filter((value): value is string => typeof value === "string" && value.length > 0)
      : []
  );

  const shape: Record<string, ZodTypeAny> = {};
  for (const [fieldName, value] of Object.entries(properties)) {
    const fieldSchema =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    shape[fieldName] = buildZodFieldSchema(fieldName, fieldSchema, requiredFields);
  }

  if (!shape.input) {
    shape.input = z.string().optional();
  }

  return z.object(shape);
};

const planGsdProjectSchema = z.object({
  project_goal: z.string().min(1, "project_goal is required."),
  actionable_steps: z
    .array(
      z.object({
        assignee_role: z.string().min(1, "assignee_role is required."),
        step_description: z.string().min(1, "step_description is required."),
      })
    )
    .min(1, "At least one actionable step is required."),
});

const buildPlanGsdProjectTool = async (
  definition: OfficeSkillToolDefinition,
  executionContext: OfficeSkillExecutionContext = {}
) => {
  const roleCatalog = await loadOfficeRoleCatalog(executionContext.officeId);
  const availableRolesText = roleCatalog.roles.length > 0 ? roleCatalog.roles.join(", ") : "none";

  return new DynamicStructuredTool({
    name: definition.name,
    description: [
      definition.description,
      "Use this tool to break a complex request into a GSD roadmap before delegating the first step.",
      `Available office roles: ${availableRolesText}.`,
      definition.instructionMarkdown
        ? `Instruction summary: ${definition.instructionMarkdown.slice(0, 320)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    schema: planGsdProjectSchema,
    func: async (input) => {
      const typedInput = planGsdProjectSchema.parse(input);
      const officeId = normalizeRoleLike(executionContext.officeId);
      const taskId = normalizeRoleLike(executionContext.taskId);
      const plannerRole = normalizeRoleLike(executionContext.role);

      if (!isServerSupabaseConfigured || !officeId || !taskId) {
        return "[Tool Error]: plan_gsd_project requires officeId and active taskId in tool context.";
      }

      if (roleCatalog.roles.length === 0) {
        return "[Tool Error]: plan_gsd_project cannot run because this office has no active agent roles.";
      }

      const roleValidationIssues = typedInput.actionable_steps.flatMap((step, index) => {
        const normalizedRole = compactLookupToken(step.assignee_role);
        if (roleCatalog.byNormalizedRole.has(normalizedRole)) {
          return [];
        }

        return [
          {
            code: z.ZodIssueCode.custom,
            path: ["actionable_steps", index, "assignee_role"],
            message:
              roleCatalog.roles.length > 0
                ? `Role '${step.assignee_role}' is not available in this office. Available roles: ${roleCatalog.roles.join(", ")}.`
                : `Role '${step.assignee_role}' is not available because this office has no active room roles.`,
          } satisfies z.ZodIssue,
        ];
      });
      if (roleValidationIssues.length > 0) {
        throw new z.ZodError(roleValidationIssues);
      }

      const linkedThreadId = await resolveExistingThreadId(officeId, executionContext.threadId ?? null);

      const rows = typedInput.actionable_steps.map((step, index) => {
        const canonicalRole =
          roleCatalog.byNormalizedRole.get(compactLookupToken(step.assignee_role)) ?? step.assignee_role.trim();
        return {
          task_id: taskId,
          office_id: officeId,
          thread_id: linkedThreadId,
          assignee_role: canonicalRole,
          assignee_agent_id: null,
          instruction: step.step_description.trim(),
          delegated_by_role: plannerRole,
          status: "pending",
          rework_count: 0,
          metadata: {
            source: PLAN_GSD_TOOL_NAME,
            projectGoal: typedInput.project_goal.trim(),
            sequence: index + 1,
            gsdPhase: resolveGsdPhase(index),
            plannedByRole: plannerRole,
          },
        };
      });

      const { error } = await supabase.from("sub_tasks").insert(rows);
      if (error) {
        return `[Tool Error]: plan_gsd_project failed to persist roadmap steps: ${error.message}`;
      }

      const firstRole = rows[0]?.assignee_role;
      return firstRole
        ? `План создан. Теперь вызови delegate_task для первого исполнителя: ${firstRole}.`
        : "План создан. Теперь вызови delegate_task для первого исполнителя.";
    },
  });
};

const buildOfficeSkillTool = (
  definition: OfficeSkillToolDefinition,
  executionContext: OfficeSkillExecutionContext = {}
) =>
  new DynamicStructuredTool({
    name: definition.name,
    description: [
      definition.description,
      definition.instructionMarkdown
        ? `Instruction summary: ${definition.instructionMarkdown.slice(0, 320)}`
        : null,
    ]
      .filter(Boolean)
      .join("\\n"),
    schema: buildOfficeToolSchema(definition.parameterSchema),
    func: async (input) => {
      const runtime = definition.runtime ?? "internal";
      if (runtime === "http") {
        return executeHttpSkill(definition, input as Record<string, unknown>, executionContext);
      }
      if (runtime === "internal") {
        return executeInternalSkill(definition, input as Record<string, unknown>, executionContext);
      }
      if (runtime === "mcp") {
        const payload = toStructuredPayload(input);
        const requestedTool = normalizeRoleLike(payload.tool) ?? definition.name;
        const toolInput = toPlainObject(payload.input ?? payload.args ?? payload);
        const result = await callPreferredMcpTool(
          [requestedTool, definition.name],
          toolInput,
          { officeId: executionContext.officeId }
        );

        if (!result) {
          return `[Tool Error]: MCP runtime for skill '${definition.name}' has no active tool matching '${requestedTool}'.`;
        }

        return result.output;
      }

      return [
        `Skill '${definition.name}' uses runtime '${runtime}'.`,
        definition.endpoint ? `Endpoint: ${definition.endpoint}` : null,
        "Runtime adapter is not available in this service build.",
      ]
        .filter(Boolean)
        .join("\\n");
    },
  });

const resolveDelegateTarget = async (
  officeId: string,
  targetAgent: string
): Promise<{ role: string; agentId: string | null; agentName: string | null } | null> => {
  const normalizedTarget = normalizeRoleLike(targetAgent);
  if (!normalizedTarget) return null;

  const { data, error } = await supabase
    .from("agents")
    .select("id, role, name")
    .eq("office_id", officeId);

  if (error || !Array.isArray(data)) {
    return null;
  }

  const normalizedLookup = compactLookupToken(normalizedTarget);
  for (const row of data as Array<Record<string, unknown>>) {
    const role = normalizeRoleLike(row.role);
    if (!role) continue;
    const agentName = normalizeRoleLike(row.name);
    const candidates = [
      role,
      agentName,
      agentName ? extractFirstToken(agentName) : null,
      compactLookupToken(role),
      agentName ? compactLookupToken(agentName) : null,
      agentName ? compactLookupToken(extractFirstToken(agentName)) : null,
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());

    if (candidates.includes(normalizedTarget.toLowerCase()) || candidates.includes(normalizedLookup)) {
      return {
        role,
        agentId: normalizeRoleLike(row.id),
        agentName,
      };
    }
  }

  return null;
};

const resolveExistingThreadId = async (
  officeId: string,
  threadId?: string | null
): Promise<string | null> => {
  const normalizedThreadId = normalizeRoleLike(threadId);
  if (!normalizedThreadId) return null;

  const { data, error } = await supabase
    .from("chat_threads")
    .select("id")
    .eq("id", normalizedThreadId)
    .eq("office_id", officeId)
    .maybeSingle();

  if (error || typeof data?.id !== "string") {
    return null;
  }

  return data.id;
};

const buildDelegateToolResult = (payload: Record<string, unknown>) => JSON.stringify(payload);

const createDelegateTaskTool = (
  executionContext: OfficeSkillExecutionContext = {}
): DynamicStructuredTool<any> =>
  new DynamicStructuredTool({
    name: DELEGATE_TOOL_NAME,
    description:
      "Transfer active task ownership to another office agent. Use this when you finish your part and hand the task to the next role.",
    schema: z.object({
      target_agent: z.string(),
      instruction: z.string().min(1),
    }),
    func: async (input) => {
      const officeId = normalizeRoleLike(executionContext.officeId);
      const taskId = normalizeRoleLike(executionContext.taskId);
      const currentRole = normalizeRoleLike(executionContext.role);
      const threadId = normalizeRoleLike(executionContext.threadId);
      const roomKey =
        normalizeRoleLike(executionContext.roomKey) ??
        buildOfficeRoomKey(officeId) ??
        undefined;
      const targetAgent = normalizeRoleLike(input.target_agent);
      const instruction = normalizeRoleLike(input.instruction);

      if (!isServerSupabaseConfigured || !officeId || !taskId || !currentRole || !targetAgent || !instruction) {
        return buildDelegateToolResult({
          ok: false,
          error: "delegate_task_missing_context",
          message: "delegate_task requires officeId, taskId, current role, target_agent, and instruction.",
        });
      }

      const target = await resolveDelegateTarget(officeId, targetAgent);
      const linkedThreadId = await resolveExistingThreadId(officeId, threadId);
      if (!target) {
        return buildDelegateToolResult({
          ok: false,
          error: "delegate_task_target_not_found",
          message: `Target agent '${targetAgent}' was not found in this office.`,
        });
      }

      if (target.role === currentRole) {
        return buildDelegateToolResult({
          ok: false,
          error: "delegate_task_same_role",
          message: "delegate_task requires a different target agent.",
        });
      }

      const { data: taskRow, error: taskError } = await supabase
        .from("tasks")
        .select("metadata, current_assignee, assigned_agent_id, status")
        .eq("id", taskId)
        .eq("office_id", officeId)
        .maybeSingle();

      if (taskError || !taskRow) {
        return buildDelegateToolResult({
          ok: false,
          error: "delegate_task_task_not_found",
          message: "Active task was not found for delegation.",
        });
      }

      const metadata = toPlainObject(taskRow.metadata);
      const workflowMetadata = toPlainObject(metadata.workflow);
      const routingHistory = toStringArray(workflowMetadata.routingHistory);
      const nextRoutingHistory = [...routingHistory, target.role];
      const targetVisits = nextRoutingHistory.filter((entry) => entry === target.role).length;
      const reworkCount = Math.max(0, targetVisits - 1);
      const forceWaitHuman = reworkCount > DELEGATION_REWORK_LIMIT;

      await supabase
        .from("sub_tasks")
        .update({
          status: "done",
          updated_at: new Date().toISOString(),
        })
        .eq("task_id", taskId)
        .eq("office_id", officeId)
        .eq("assignee_role", currentRole)
        .eq("status", "in_progress");

      if (forceWaitHuman) {
        await supabase
          .from("tasks")
          .update({
            status: "review",
            current_assignee: null,
            assigned_agent_id: null,
            metadata: {
              ...metadata,
              workflow: {
                ...workflowMetadata,
                currentAssignee: null,
                lastActor: currentRole,
                routeStatus: "handoff_limit_exceeded",
                workflowStatus: "waiting_human",
                waitingForHuman: true,
                routingHistory: nextRoutingHistory,
              },
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", taskId)
          .eq("office_id", officeId);

        await patchRoomState({
          roomKey,
          mode: "approval",
          taskStatus: "review",
          activeRole: null,
          pendingTaskId: taskId,
          metadata: {
            officeId,
            threadId,
            currentAssignee: null,
            waitingForHuman: true,
            routingHistory: nextRoutingHistory,
          },
        });

        await patchAgentRuntimeByRole(currentRole, {
          officeId,
          status: "idle",
          currentAction: "Waiting for human review after repeated handoffs.",
          currentSkill: null,
          metadata: {
            source: DELEGATE_TOOL_NAME,
            taskId,
            threadId,
          },
        });
        await patchPlayerStateByRole(currentRole, {
          roomKey,
          officeId,
          status: "waiting",
          metadata: {
            source: DELEGATE_TOOL_NAME,
            taskId,
            threadId,
          },
        });

        await publishTeamEvent({
          roomKey,
          eventName: "workflow.system_error",
          scope: "broadcast",
          senderRole: currentRole,
          senderName: currentRole,
          targetRole: "All",
          payload: {
            taskId,
            threadId,
            role: currentRole,
            targetRole: target.role,
            officeId,
            message: "Delegation limit exceeded. Task moved to wait_human.",
            reworkCount,
          },
        });

        return buildDelegateToolResult({
          ok: true,
          targetRole: target.role,
          waitHuman: true,
          routingHistory: nextRoutingHistory,
          reworkCount,
          message: "Delegation limit exceeded. Task moved to wait_human.",
        });
      }

      const { data: pendingPlannedRows } = await supabase
        .from("sub_tasks")
        .select("id, instruction, metadata")
        .eq("task_id", taskId)
        .eq("office_id", officeId)
        .eq("assignee_role", target.role)
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(1);

      const plannedSubTask =
        Array.isArray(pendingPlannedRows) && pendingPlannedRows.length > 0
          ? (pendingPlannedRows[0] as Record<string, unknown>)
          : null;
      const plannedInstruction = normalizeRoleLike(plannedSubTask?.instruction);
      const plannedMetadata = toPlainObject(plannedSubTask?.metadata);

      if (typeof plannedSubTask?.id === "string" && plannedSubTask.id.trim().length > 0) {
        await supabase
          .from("sub_tasks")
          .update({
            thread_id: linkedThreadId,
            assignee_agent_id: target.agentId,
            delegated_by_role: currentRole,
            status: "in_progress",
            rework_count: reworkCount,
            instruction: plannedInstruction ?? instruction,
            metadata: {
              ...plannedMetadata,
              source: plannedMetadata.source ?? PLAN_GSD_TOOL_NAME,
              previousAssignee: currentRole,
              delegateInstruction: instruction,
            },
            updated_at: new Date().toISOString(),
          })
          .eq("id", plannedSubTask.id)
          .eq("office_id", officeId);
      } else {
        await supabase
          .from("sub_tasks")
          .insert({
            task_id: taskId,
            office_id: officeId,
            thread_id: linkedThreadId,
            assignee_role: target.role,
            assignee_agent_id: target.agentId,
            instruction,
            delegated_by_role: currentRole,
            status: "in_progress",
            rework_count: reworkCount,
            metadata: {
              source: DELEGATE_TOOL_NAME,
              previousAssignee: currentRole,
            },
          });
      }

      await supabase
        .from("tasks")
        .update({
          status: "in_progress",
          current_assignee: target.role,
          assigned_agent_id: target.agentId,
          metadata: {
            ...metadata,
            workflow: {
              ...workflowMetadata,
              currentAssignee: target.role,
              lastActor: currentRole,
              routeStatus: "delegated",
              workflowStatus: "running",
              waitingForHuman: false,
              routingHistory: nextRoutingHistory,
            },
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", taskId)
        .eq("office_id", officeId);

      await patchRoomState({
        roomKey,
        mode: "execution",
        taskStatus: "in_progress",
        activeRole: target.role,
        pendingTaskId: taskId,
        metadata: {
          officeId,
          threadId,
          currentAssignee: target.role,
          waitingForHuman: false,
          routingHistory: nextRoutingHistory,
        },
      });

      await patchAgentRuntimeByRole(currentRole, {
        officeId,
        status: "idle",
        currentAction: `Delegated task to ${target.role}`,
        currentSkill: null,
        metadata: {
          source: DELEGATE_TOOL_NAME,
          taskId,
          threadId,
        },
      });
      await patchAgentRuntimeByRole(target.role, {
        officeId,
        status: "working",
        currentAction: instruction,
        currentSkill: DELEGATE_TOOL_NAME,
        metadata: {
          source: DELEGATE_TOOL_NAME,
          taskId,
          threadId,
          delegatedBy: currentRole,
        },
      });
      await patchPlayerStateByRole(currentRole, {
        roomKey,
        officeId,
        status: "waiting",
        metadata: {
          source: DELEGATE_TOOL_NAME,
          taskId,
          threadId,
        },
      });
      await patchPlayerStateByRole(target.role, {
        roomKey,
        officeId,
        status: "working",
        metadata: {
          source: DELEGATE_TOOL_NAME,
          taskId,
          threadId,
          delegatedBy: currentRole,
        },
      });

      await publishTeamEvent({
        roomKey,
        eventName: "workflow.delegate_task",
        scope: "broadcast",
        senderRole: currentRole,
        senderName: currentRole,
        targetRole: target.role,
        payload: {
          taskId,
          threadId,
          role: currentRole,
          agentName: currentRole,
          targetRole: target.role,
          targetAgentName: target.agentName,
          officeId,
          message: instruction,
          argsPreview: instruction,
          reworkCount,
        },
      });

      return buildDelegateToolResult({
        ok: true,
        targetRole: target.role,
        waitHuman: false,
        routingHistory: nextRoutingHistory,
        reworkCount,
        message: `Task delegated to ${target.role}.`,
      });
    },
  });

const createRequestCapabilityTool = (
  executionContext: OfficeSkillExecutionContext = {}
): DynamicStructuredTool<any> =>
  new DynamicStructuredTool({
    name: REQUEST_CAPABILITY_TOOL_NAME,
    description:
      "Request approval to add or use a missing MCP/API/secret/tool capability. Use before installing MCP servers, asking for secrets, external writes, deploys, or API mutations.",
    schema: z.object({
      kind: z.enum(["mcp", "api", "secret", "tool", "search"]),
      query: z.string().min(1),
      reason: z.string().optional(),
      target_role: z.string().optional(),
    }),
    func: async (input) => {
      const officeId = normalizeRoleLike(executionContext.officeId);
      const taskId = normalizeRoleLike(executionContext.taskId);
      const currentRole = normalizeRoleLike(executionContext.role);
      const roomKey =
        normalizeRoleLike(executionContext.roomKey) ??
        buildOfficeRoomKey(officeId) ??
        undefined;

      if (!isServerSupabaseConfigured || !officeId || !input.query) {
        return JSON.stringify({
          ok: false,
          error: "request_capability_missing_context",
          message: "request_capability requires officeId and query.",
        });
      }

      // For MCP requests: check if the query matches a whitelisted template
      const mcpTemplateMatch =
        input.kind === "mcp"
          ? MCP_TEMPLATE_POLICIES[input.query.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-")] ?? null
          : null;

      const capabilityMetadata: Record<string, unknown> = {
        source: REQUEST_CAPABILITY_TOOL_NAME,
        threadId: executionContext.threadId ?? null,
      };

      if (mcpTemplateMatch) {
        capabilityMetadata.provision = {
          name: mcpTemplateMatch.name,
          type: mcpTemplateMatch.type,
          command: mcpTemplateMatch.command ?? null,
          allowedEnv: mcpTemplateMatch.allowedEnv,
        };
        capabilityMetadata.autoResolvable = true;
      } else if (input.kind === "mcp") {
        capabilityMetadata.autoResolvable = false;
      }

      const request = await createCapabilityRequest({
        officeId,
        taskId,
        requestedByRole: currentRole,
        targetRole: normalizeRoleLike(input.target_role) ?? currentRole,
        kind: input.kind,
        query: input.query,
        reason: input.reason,
        roomKey,
        metadata: capabilityMetadata,
      });

      const message = mcpTemplateMatch
        ? `MCP capability '${mcpTemplateMatch.name}' request created. Admin approval is needed. Request ID: ${request.id}`
        : "Capability request created and is waiting for approval.";

      return JSON.stringify({
        ok: true,
        requestId: request.id,
        status: request.status,
        autoResolvable: Boolean(mcpTemplateMatch),
        message,
      });
    },
  });

const createSitePreviewTool = (
  executionContext: OfficeSkillExecutionContext = {}
): DynamicStructuredTool<any> =>
  new DynamicStructuredTool({
    name: CREATE_SITE_PREVIEW_TOOL_NAME,
    description:
      "Create a safe standalone HTML website preview artifact. Use this for website/landing page tasks before any repo write or deploy. Pass clean, unescaped full HTML with topic-specific content. Always include real sections about the topic (products, benefits, contacts). Do not pass JSON-wrapped HTML, literal backslash escapes, placeholder image URLs, lorem ipsum, or stale copyright years.",
    schema: z.object({
      title: z.string().optional(),
      brief: z.string().optional(),
      primary_color: z.string().optional(),
      html: z
        .string()
        .describe(
          "The complete standalone HTML source code. MUST contain full tags and must not be JSON-escaped or wrapped in markdown/tool_code."
        ),
    }),
    func: async (input) => {
      const title = normalizeRoleLike(input.title) ?? "AI Agency";
      const brief =
        typeof input.brief === "string" && input.brief.trim().length > 0
          ? input.brief.trim()
          : "Create a polished one-page site for an AI agency.";
      const html = buildSitePreviewHtml({
        title,
        brief,
        primaryColor: normalizeRoleLike(input.primary_color),
        html: typeof input.html === "string" ? input.html : null,
      });
      const validation = validateSitePreviewHtml(html);
      if (!validation.passed) {
        return JSON.stringify({
          ok: false,
          error: "site_preview_validation_failed",
          issues: validation.issues,
        });
      }

      const uploaded = await uploadArtifactToStorage(
        executionContext,
        CREATE_SITE_PREVIEW_TOOL_NAME,
        "site-preview.html",
        "text/html; charset=utf-8",
        Buffer.from(html, "utf8")
      );

      return JSON.stringify({
        ok: true,
        artifact: {
          title: "site-preview.html",
          url: uploaded.url,
          artifactId: uploaded.artifactId,
          storagePath: uploaded.storagePath,
          transport: uploaded.transport,
        },
        validation: {
          status: "passed",
          checks: ["html_root", "title", "sections", "no_inline_script"],
        },
      });
    },
  });

const createMemorySearchTool = (
  executionContext: OfficeSkillExecutionContext = {}
): DynamicStructuredTool<any> =>
  new DynamicStructuredTool({
    name: MEMORY_SEARCH_TOOL_NAME,
    description:
      "Search office-scoped pattern memory for prior successful workflows, decisions, and implementation notes.",
    schema: z.object({
      query: z.string().min(1),
      namespace: z.string().optional(),
      limit: z.number().int().positive().max(10).optional(),
      min_confidence: z.number().min(0).max(1).optional(),
    }),
    func: async (input) => {
      const hits = await searchAgentMemoryPatterns({
        officeId: executionContext.officeId ?? null,
        namespace: input.namespace ?? DEFAULT_MEMORY_NAMESPACE,
        query: input.query,
        limit: input.limit ?? 10,
        minConfidence: input.min_confidence ?? DEFAULT_MEMORY_MIN_CONFIDENCE,
      });
      return JSON.stringify({
        ok: true,
        namespace: input.namespace ?? DEFAULT_MEMORY_NAMESPACE,
        hits,
      });
    },
  });

const createMemoryStoreTool = (
  executionContext: OfficeSkillExecutionContext = {}
): DynamicStructuredTool<any> =>
  new DynamicStructuredTool({
    name: MEMORY_STORE_TOOL_NAME,
    description:
      "Store a compact office-scoped pattern memory entry that can help future runs. Keep values concise and non-secret.",
    schema: z.object({
      key: z.string().min(1),
      value: z.string().min(1),
      summary: z.string().optional(),
      namespace: z.string().optional(),
      tags: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
    func: async (input) => {
      const hit = await storeAgentMemoryPattern({
        officeId: executionContext.officeId ?? null,
        namespace: input.namespace ?? DEFAULT_MEMORY_NAMESPACE,
        key: input.key,
        value: input.value,
        summary: input.summary,
        tags: input.tags,
        confidence: input.confidence ?? 0.8,
        sourceRunId: executionContext.runId ?? null,
        sourceTaskId: executionContext.taskId ?? null,
        metadata: {
          source: MEMORY_STORE_TOOL_NAME,
          role: executionContext.role ?? null,
          threadId: executionContext.threadId ?? null,
        },
      });
      return JSON.stringify({ ok: Boolean(hit), memory: hit });
    },
  });

const createMemoryRetrieveTool = (
  executionContext: OfficeSkillExecutionContext = {}
): DynamicStructuredTool<any> =>
  new DynamicStructuredTool({
    name: MEMORY_RETRIEVE_TOOL_NAME,
    description: "Retrieve one office-scoped pattern memory entry by namespace and key.",
    schema: z.object({
      key: z.string().min(1),
      namespace: z.string().optional(),
    }),
    func: async (input) => {
      const memory = await retrieveAgentMemoryPattern({
        officeId: executionContext.officeId ?? null,
        namespace: input.namespace ?? DEFAULT_MEMORY_NAMESPACE,
        key: input.key,
      });
      return JSON.stringify({ ok: Boolean(memory), memory });
    },
  });

const createSwarmStatusTool = (
  executionContext: OfficeSkillExecutionContext = {}
): DynamicStructuredTool<any> =>
  new DynamicStructuredTool({
    name: SWARM_STATUS_TOOL_NAME,
    description: "Return the active run's native swarm topology, strategy, consensus mode, and anti-drift guardrails.",
    schema: z.object({}),
    func: async () => {
      const swarm = await getRunSwarmSummary({
        officeId: executionContext.officeId ?? null,
        runId: executionContext.runId ?? null,
      });
      return JSON.stringify({
        ok: true,
        runId: executionContext.runId ?? null,
        taskId: executionContext.taskId ?? null,
        swarm,
      });
    },
  });

const createAgentStatusTool = (
  executionContext: OfficeSkillExecutionContext = {}
): DynamicStructuredTool<any> =>
  new DynamicStructuredTool({
    name: AGENT_STATUS_TOOL_NAME,
    description: "Return low-risk status for office agents and current runtime state in the active office.",
    schema: z.object({
      role: z.string().optional(),
      limit: z.number().int().positive().max(25).optional(),
    }),
    func: async (input) => {
      const officeId = normalizeRoleLike(executionContext.officeId);
      if (!isServerSupabaseConfigured || !officeId) {
        return JSON.stringify({ ok: false, error: "agent_status_missing_context", agents: [] });
      }

      const limit = Math.min(Math.max(Number(input.limit ?? 12), 1), 25);
      let agentsQuery = supabase
        .from("agents")
        .select("id, name, role, metadata")
        .eq("office_id", officeId)
        .order("role", { ascending: true })
        .limit(limit);
      const role = normalizeRoleLike(input.role);
      if (role) agentsQuery = agentsQuery.eq("role", role);

      const { data: agentRows, error: agentsError } = await agentsQuery;
      if (agentsError || !Array.isArray(agentRows)) {
        return JSON.stringify({ ok: false, error: "agent_status_query_failed", agents: [] });
      }

      const agentIds = (agentRows as Array<Record<string, unknown>>)
        .map((row) => normalizeRoleLike(row.id))
        .filter((id): id is string => Boolean(id));
      const { data: stateRows } =
        agentIds.length > 0
          ? await supabase
              .from("agent_states")
              .select("agent_id, status, current_action, current_skill, updated_at")
              .eq("office_id", officeId)
              .in("agent_id", agentIds)
          : { data: [] };
      const stateByAgentId = new Map(
        ((stateRows ?? []) as Array<Record<string, unknown>>).map((row) => [normalizeRoleLike(row.agent_id), row])
      );

      return JSON.stringify({
        ok: true,
        agents: (agentRows as Array<Record<string, unknown>>).map((row) => {
          const state = stateByAgentId.get(normalizeRoleLike(row.id)) ?? {};
          return {
            id: normalizeRoleLike(row.id),
            name: normalizeRoleLike(row.name),
            role: normalizeRoleLike(row.role),
            status: normalizeRoleLike(state.status) ?? "idle",
            currentAction: normalizeRoleLike(state.current_action),
            currentSkill: normalizeRoleLike(state.current_skill),
            updatedAt: normalizeRoleLike(state.updated_at),
          };
        }),
      });
    },
  });

const loadSystemTools = (
  executionContext: OfficeSkillExecutionContext = {}
): AgentTool[] => [
  createDelegateTaskTool(executionContext),
  createRequestCapabilityTool(executionContext),
  createSitePreviewTool(executionContext),
  createMemorySearchTool(executionContext),
  createMemoryStoreTool(executionContext),
  createMemoryRetrieveTool(executionContext),
  createSwarmStatusTool(executionContext),
  createAgentStatusTool(executionContext),
];

export const roleHasBoundTool = (
  toolMap: Record<string, string[]>,
  role: string,
  toolName: string
): boolean =>
  (toolMap[role] ?? []).some(
    (candidate) => normalizeSkillName(candidate) === normalizeSkillName(toolName)
  );

export const findFirstRoleWithBoundTool = (
  orderedRoles: string[],
  toolMap: Record<string, string[]>,
  toolName: string,
  excludeRole?: string | null
): string | null => {
  const normalizedExcludeRole = normalizeRoleLike(excludeRole)?.toLowerCase() ?? null;

  for (const role of orderedRoles) {
    const normalizedRole = normalizeRoleLike(role);
    if (!normalizedRole) continue;
    if (normalizedExcludeRole && normalizedRole.toLowerCase() === normalizedExcludeRole) {
      continue;
    }
    if (roleHasBoundTool(toolMap, normalizedRole, toolName)) {
      return normalizedRole;
    }
  }

  return null;
};

export const loadInstalledToolNamesByRole = async (
  officeId?: string | null,
  roles?: string[] | null
): Promise<Record<string, string[]>> => {
  const normalizedOfficeId = normalizeRoleLike(officeId);
  if (!isServerSupabaseConfigured || !normalizedOfficeId) {
    return {};
  }

  const normalizedRoles = Array.from(
    new Set(
      (roles ?? [])
        .map((role) => normalizeRoleLike(role))
        .filter((role): role is string => Boolean(role))
    )
  );

  const toolMap = Object.fromEntries(normalizedRoles.map((role) => [role, [] as string[]])) as Record<string, string[]>;

  try {
    let agentQuery = supabase
      .from("agents")
      .select("id, role")
      .eq("office_id", normalizedOfficeId);
    if (normalizedRoles.length > 0) {
      agentQuery = agentQuery.in("role", normalizedRoles);
    }

    const { data: agentRows, error: agentError } = await agentQuery;
    if (agentError || !Array.isArray(agentRows) || agentRows.length === 0) {
      return toolMap;
    }

    const roleByAgentId = new Map<string, string>();
    const agentIds: string[] = [];
    for (const row of agentRows as Array<Record<string, unknown>>) {
      const agentId = normalizeRoleLike(row.id);
      const role = normalizeRoleLike(row.role);
      if (!agentId || !role) continue;
      roleByAgentId.set(agentId, role);
      toolMap[role] = toolMap[role] ?? [];
      agentIds.push(agentId);
    }

    if (agentIds.length === 0) {
      return toolMap;
    }

    const { data: installedSkillRows, error: installedSkillsError } = await supabase
      .from("agent_skills")
      .select("agent_id, skill_id")
      .in("agent_id", agentIds)
      .eq("is_enabled", true);

    if (installedSkillsError || !Array.isArray(installedSkillRows) || installedSkillRows.length === 0) {
      return toolMap;
    }

    const skillIds = Array.from(
      new Set(
        installedSkillRows
          .map((row) => normalizeRoleLike((row as Record<string, unknown>).skill_id))
          .filter((skillId): skillId is string => Boolean(skillId))
      )
    );

    if (skillIds.length === 0) {
      return toolMap;
    }

    const { data: definitionRows, error: definitionError } = await supabase
      .from("skills_catalog")
      .select("id, name")
      .in("id", skillIds)
      .eq("is_active", true);

    if (definitionError || !Array.isArray(definitionRows) || definitionRows.length === 0) {
      return toolMap;
    }

    const toolNameBySkillId = new Map<string, string>();
    for (const row of definitionRows as Array<Record<string, unknown>>) {
      const skillId = normalizeRoleLike(row.id);
      const toolName = normalizeRoleLike(row.name);
      if (!skillId || !toolName) continue;
      toolNameBySkillId.set(skillId, toolName);
    }

    for (const row of installedSkillRows as Array<Record<string, unknown>>) {
      const agentId = normalizeRoleLike(row.agent_id);
      const skillId = normalizeRoleLike(row.skill_id);
      if (!agentId || !skillId) continue;
      const role = roleByAgentId.get(agentId);
      const toolName = toolNameBySkillId.get(skillId);
      if (!role || !toolName) continue;
      toolMap[role] = mergeToolNames(toolMap[role] ?? [], [toolName]);
    }

    return toolMap;
  } catch (error) {
    console.error("[tools] failed to resolve installed tool names by role:", error);
    return toolMap;
  }
};

export const loadInstalledSkillTools = async (
  officeId?: string | null,
  role?: string | null,
  taskId?: string | null,
  threadId?: string | null,
  roomKey?: string | null
): Promise<AgentTool[]> => {
  if (!isServerSupabaseConfigured || !officeId) {
    return [];
  }

  try {
    let agentQuery = supabase.from("agents").select("id").eq("office_id", officeId);
    if (role) {
      agentQuery = agentQuery.eq("role", role);
    }

    const { data: agents } = await agentQuery;
    const agentIds = (agents ?? [])
      .map((agent) => (typeof agent.id === "string" ? agent.id : ""))
      .filter((value) => value.length > 0);

    if (agentIds.length === 0) {
      return [];
    }

    const { data: installedSkills } = await supabase
      .from("agent_skills")
      .select("skill_id")
      .in("agent_id", agentIds)
      .eq("is_enabled", true);

    const skillIds = Array.from(
      new Set(
        (installedSkills ?? [])
          .map((row) => (typeof row.skill_id === "string" ? row.skill_id : ""))
          .filter((value) => value.length > 0)
      )
    );

    if (skillIds.length === 0) {
      return [];
    }

    const { data: definitions } = await supabase
      .from("skills_catalog")
      .select(
        "id, name, description, runtime, endpoint, parameter_schema, is_verified, implementation_ref, instruction_md"
      )
      .in("id", skillIds)
      .eq("is_active", true);

    const builtTools = await Promise.all(
      (definitions ?? []).map(async (row) => {
        if (typeof row.id !== "string" || typeof row.name !== "string") {
          return null;
        }

        const definition: OfficeSkillToolDefinition = {
          id: row.id,
          name: row.name,
          description: String(row.description ?? row.name),
          instructionMarkdown:
            typeof row.instruction_md === "string" ? row.instruction_md : null,
          runtime: typeof row.runtime === "string" ? row.runtime : null,
          endpoint: typeof row.endpoint === "string" ? row.endpoint : null,
          parameterSchema:
            row.parameter_schema && typeof row.parameter_schema === "object"
              ? (row.parameter_schema as Record<string, unknown>)
              : null,
          isVerified: typeof row.is_verified === "boolean" ? row.is_verified : false,
          implementationRef:
            typeof row.implementation_ref === "string" ? row.implementation_ref : null,
        };
        const toolContext = {
          officeId,
          role,
          taskId,
          threadId,
          roomKey,
        };

        if (normalizeSkillName(definition.name) === PLAN_GSD_TOOL_NAME) {
          return buildPlanGsdProjectTool(definition, toolContext);
        }

        return buildOfficeSkillTool(definition, toolContext);
      })
    );

    return builtTools.filter((tool): tool is AgentTool => Boolean(tool));
  } catch (error) {
    console.error("[tools] failed to load installed skill tools:", error);
    return [];
  }
};

export const invokeInstalledSkillByName = async (
  skillName: string,
  payload: Record<string, unknown>,
  executionContext: OfficeSkillExecutionContext = {}
): Promise<string> => {
  const officeTools = await loadInstalledSkillTools(
    executionContext.officeId ?? null,
    executionContext.role ?? null,
    executionContext.taskId ?? null,
    executionContext.threadId ?? null,
    executionContext.roomKey ?? null
  );
  const systemTools = loadSystemTools(executionContext);
  const activeTools = [...systemTools, ...officeTools];
  const tool = activeTools.find((candidate) => candidate.name === skillName);

  if (!tool) {
    return `[Tool Error]: Tool '${skillName}' is not installed for role '${executionContext.role ?? "unknown"}'.`;
  }

  try {
    if (tool instanceof DynamicStructuredTool) {
      const result = await tool.invoke(payload);
      return typeof result === "string" ? result : formatToolPayload(result);
    }

    const result = await tool.invoke(JSON.stringify(payload));
    return typeof result === "string" ? result : formatToolPayload(result);
  } catch (error) {
    return `[Tool Error]: Tool '${skillName}' execution failed: ${
      error instanceof Error ? error.message : "unknown_error"
    }`;
  }
};

export interface SandboxValidationResult {
  passed: boolean;
  status: "passed" | "failed" | "skipped";
  toolName: string | null;
  output: string;
}

const sandboxFailurePattern =
  /\b(fail(?:ed|ure)?|error|exception|traceback|npm\s+err|not\s+ok|lint[\w\s-]*failed)\b/i;

export const runSandboxValidationWithMcp = async (
  command: string,
  officeId?: string | null
): Promise<SandboxValidationResult> => {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return {
      passed: false,
      status: "skipped",
      toolName: null,
      output: "Validation command is empty, sandbox validation skipped.",
    };
  }

  const result = await callPreferredMcpTool(
    ["sandbox_execution", "sandbox__execution", "sandbox.execution"],
    { command: normalizedCommand },
    { officeId }
  );

  if (!result) {
    return {
      passed: false,
      status: "skipped",
      toolName: null,
      output: "No active sandbox_execution MCP tool found; automatic validator was skipped.",
    };
  }

  const output = String(result.output ?? "").trim() || "sandbox_execution returned empty output.";
  const failed = result.isError || sandboxFailurePattern.test(output);
  return {
    passed: !failed,
    status: failed ? "failed" : "passed",
    toolName: result.toolName,
    output,
  };
};
const geminiApiKey =
  process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const DEFAULT_GEMINI_MODEL = FALLBACK_MODEL;
const enableToolCallDebugLogging = process.env.DEBUG_LLM_TOOL_CALLS === "true";
export const isLlmConfigured = Boolean(geminiApiKey);
// Model instances are cached per resolved model id so tier-based routing reuses
// connections instead of rebuilding a client on every turn.
const llmInstances = new Map<string, ChatGoogleGenerativeAI>();
const tokenCounters = new Map<string, ReturnType<GoogleGenerativeAI["getGenerativeModel"]>>();

const toNumber = (value: unknown): number => {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
};

const getPositiveNumber = (...candidates: unknown[]): number => {
  for (const candidate of candidates) {
    const numeric = toNumber(candidate);
    if (numeric > 0) {
      return numeric;
    }
  }
  return 0;
};

const getLlm = (modelName: string) => {
  if (!isLlmConfigured) {
    return null;
  }

  const cached = llmInstances.get(modelName);
  if (cached) {
    return cached;
  }

  const model = new ChatGoogleGenerativeAI({
    modelName,
    maxOutputTokens: 2048,
    apiKey: geminiApiKey,
  });

  llmInstances.set(modelName, model);
  return model;
};

const getInvokableLlm = async (
  modelName: string,
  officeId?: string | null,
  role?: string | null,
  taskId?: string | null,
  threadId?: string | null,
  roomKey?: string | null,
  runId?: string | null
): Promise<{
  llm: ReturnType<ChatGoogleGenerativeAI["bindTools"]> | ChatGoogleGenerativeAI | null;
  activeTools: AgentTool[];
  approveModeEnabled: boolean;
  approveModeMinRisk: import("@/lib/agents/toolPolicy").ToolRiskLevel;
}> => {
  const model = getLlm(modelName);
  if (!model) {
    return { llm: null, activeTools: [], approveModeEnabled: false, approveModeMinRisk: "high" as const };
  }

  // Load office-level approve mode settings for tool authorization
  const { loadOfficeSettings } = await import("@/lib/offices/settings");
  const officeSettings = await loadOfficeSettings(officeId).catch(() => ({
    approveMode: false as boolean,
    approveModeMinRisk: "high" as const,
    autoApprovedMcps: [] as string[],
  }));

  const executionCtx: OfficeSkillExecutionContext = {
    officeId,
    runId,
    role,
    taskId,
    threadId,
    roomKey,
    approveModeEnabled: officeSettings.approveMode,
    approveModeMinRisk: officeSettings.approveModeMinRisk,
  };

  const mcpTools = enableMockMcpTools ? tools : await loadDynamicMcpTools(officeId, role);
  const officeTools = await loadInstalledSkillTools(officeId, role, taskId, threadId, roomKey);
  const systemTools = loadSystemTools(executionCtx);
  const activeTools = [...mcpTools, ...systemTools, ...officeTools];

  if (activeTools.length > 0 && typeof model.bindTools === "function") {
    return {
      llm: model.bindTools(activeTools),
      activeTools,
      approveModeEnabled: officeSettings.approveMode,
      approveModeMinRisk: officeSettings.approveModeMinRisk,
    };
  }

  return {
    llm: model,
    activeTools,
    approveModeEnabled: officeSettings.approveMode,
    approveModeMinRisk: officeSettings.approveModeMinRisk,
  };
};

interface NormalizedToolCall {
  id: string;
  name: string;
  args: unknown;
}

const normalizeToolCalls = (response: unknown): NormalizedToolCall[] => {
  const envelope = response as {
    tool_calls?: Array<Record<string, unknown>>;
    toolCalls?: Array<Record<string, unknown>>;
  };
  const toolCalls = envelope.tool_calls ?? envelope.toolCalls ?? [];

  return toolCalls
    .map((toolCall, index) => {
      const name = String(toolCall.name ?? "");
      if (!name) return null;
      return {
        id: String(toolCall.id ?? `${name}-${index + 1}`),
        name,
        args: toolCall.args ?? toolCall.arguments ?? {},
      } satisfies NormalizedToolCall;
    })
    .filter((toolCall): toolCall is NormalizedToolCall => Boolean(toolCall));
};

const logToolCallDiagnostics = (
  stage: "before_invoke" | "after_invoke",
  payload: Record<string, unknown>
) => {
  if (!enableToolCallDebugLogging) return;
  console.info(`[tools.debug] ${stage}`, payload);
};

const runModelWithTools = async (
  llm: ReturnType<ChatGoogleGenerativeAI["bindTools"]> | ChatGoogleGenerativeAI,
  messages: BaseMessage[],
  activeTools: AgentTool[],
  runtimeContext: {
    officeId?: string | null;
    role?: string | null;
    taskId?: string | null;
    threadId?: string | null;
    roomKey?: string | null;
    runId?: string | null;
    modelName?: string | null;
    approveModeEnabled?: boolean;
    approveModeMinRisk?: import("@/lib/agents/toolPolicy").ToolRiskLevel;
  } = {}
) => {
  const toolRegistry = new Map(activeTools.map((tool) => [tool.name, tool]));
  const conversation: BaseMessage[] = [...messages];
  const activeModelName = runtimeContext.modelName ?? DEFAULT_GEMINI_MODEL;
  logToolCallDiagnostics("before_invoke", {
    model: activeModelName,
    role: runtimeContext.role ?? null,
    officeId: runtimeContext.officeId ?? null,
    threadId: runtimeContext.threadId ?? null,
    taskId: runtimeContext.taskId ?? null,
    activeTools: activeTools.map((tool) => tool.name),
    messageTypes: messages.map((message) => message._getType()),
  });
  let response = await llm.invoke(conversation);
  const runtimeRole =
    typeof runtimeContext.role === "string" && runtimeContext.role.trim().length > 0
      ? runtimeContext.role.trim()
      : null;
  const runtimeOfficeId = runtimeContext.officeId ?? null;
  const roomKey = runtimeContext.roomKey ?? buildOfficeRoomKey(runtimeOfficeId);
  const executedTools = new Set<string>();
  const toolEvents: AgentToolEvent[] = [];

  for (let round = 0; round < 4; round += 1) {
    logToolCallDiagnostics("after_invoke", {
      round,
      model: activeModelName,
      role: runtimeRole,
      responseType:
        response && typeof response === "object" && "constructor" in response
          ? String((response as { constructor?: { name?: string } }).constructor?.name ?? "unknown")
          : typeof response,
      content:
        response && typeof response === "object" && "content" in response
          ? (response as { content?: unknown }).content
          : null,
      tool_calls:
        response && typeof response === "object" && "tool_calls" in response
          ? (response as { tool_calls?: unknown }).tool_calls
          : null,
      invalid_tool_calls:
        response && typeof response === "object" && "invalid_tool_calls" in response
          ? (response as { invalid_tool_calls?: unknown }).invalid_tool_calls
          : null,
      additional_kwargs:
        response && typeof response === "object" && "additional_kwargs" in response
          ? (response as { additional_kwargs?: unknown }).additional_kwargs
          : null,
      response_metadata:
        response && typeof response === "object" && "response_metadata" in response
          ? (response as { response_metadata?: unknown }).response_metadata
          : null,
    });
    const toolCalls = normalizeToolCalls(response);
    if (toolCalls.length === 0) {
      return { response, executedTools: Array.from(executedTools), toolEvents };
    }

    conversation.push(response as AIMessage);

    const parallelism = Math.min(Math.max(Number(process.env.AGENT_TOOL_PARALLELISM ?? 4), 1), 8);
    for (let batchStart = 0; batchStart < toolCalls.length; batchStart += parallelism) {
      const batch = toolCalls.slice(batchStart, batchStart + parallelism);
      const groupStep = round + 1;
      const toolGroupId = `${runtimeContext.runId ?? runtimeContext.taskId ?? "run"}-${groupStep}-${Math.floor(batchStart / parallelism) + 1}`;
      const groupStartedAt = Date.now();

      if (runtimeRole) {
        await publishTeamEvent({
          roomKey: roomKey || undefined,
          eventName: "workflow.task_group_start",
          scope: "system",
          senderRole: runtimeRole,
          senderName: runtimeRole,
          targetRole: runtimeRole,
          payload: {
            taskId: runtimeContext.taskId ?? null,
            threadId: runtimeContext.threadId ?? null,
            runId: runtimeContext.runId ?? null,
            role: runtimeRole,
            toolGroupId,
            toolGroupStep: groupStep,
            tools: batch.map((toolCall) => toolCall.name),
            officeId: runtimeOfficeId,
          },
        });
      }

      const settledToolResults = await Promise.allSettled(
        batch.map(async (toolCall) => {
          const tool = toolRegistry.get(toolCall.name);
          const args = toStructuredPayload(toolCall.args);
          const argsPreview = formatToolPayload(redactSensitiveValue(args)).slice(0, 1500);
          const startedAt = Date.now();
          const events: AgentToolEvent[] = [];
          let toolOutput: unknown;
          let toolFailed = false;
          let authorizationRisk: ToolRiskLevel = "high";
          let authorizationDecision: "allowed" | "denied" | "approval_required" = "denied";

          if (runtimeRole) {
            events.push({
              name: toolCall.name,
              status: "started",
              argsPreview,
              message: `Using tool ${toolCall.name}`,
            });
            await patchAgentRuntimeByRole(runtimeRole, {
              officeId: runtimeOfficeId,
              status: "working",
              currentAction: `Executing tool ${toolCall.name}`,
              currentSkill: toolCall.name,
              metadata: {
                source: "llm_tool_call",
                toolName: toolCall.name,
                toolGroupId,
                startedAt: new Date(startedAt).toISOString(),
                officeId: runtimeOfficeId,
              },
            });
            await publishTeamEvent({
              roomKey: roomKey || undefined,
              eventName: "workflow.tool_started",
              scope: "system",
              senderRole: runtimeRole,
              senderName: runtimeRole,
              targetRole: runtimeRole,
              payload: {
                taskId: runtimeContext.taskId ?? null,
                threadId: runtimeContext.threadId ?? null,
                runId: runtimeContext.runId ?? null,
                role: runtimeRole,
                agentName: runtimeRole,
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                toolGroupId,
                argsPreview,
                message: `Using tool ${toolCall.name}`,
                officeId: runtimeOfficeId,
              },
            });
          }

          try {
            executedTools.add(toolCall.name);
            if (!tool) {
              toolFailed = true;
              toolOutput = `Tool '${toolCall.name}' is not registered for this office.`;
            } else {
              const authorization = await authorizeToolInvocation({
                officeId: runtimeOfficeId,
                runId: runtimeContext.runId ?? null,
                taskId: runtimeContext.taskId ?? null,
                role: runtimeRole,
                toolId: toolCall.name,
                arguments: args,
                actionSummary: `Agent tool call ${toolCall.name}`,
                approveModeEnabled: runtimeContext.approveModeEnabled,
                approveModeMinRisk: runtimeContext.approveModeMinRisk,
                metadata: {
                  source: "llm_tool_call",
                  threadId: runtimeContext.threadId ?? null,
                  toolCallId: toolCall.id,
                  toolGroupId,
                  toolGroupStep: groupStep,
                },
              });
              authorizationRisk = authorization.riskLevel;
              authorizationDecision = authorization.decision;

              if (authorization.decision === "denied") {
                toolFailed = true;
                toolOutput = `tool_denied: ${authorization.reason}`;
              } else if (authorization.decision === "approval_required") {
                toolFailed = true;
                toolOutput = JSON.stringify({
                  ok: false,
                  error: "approval_required",
                  approvalRequestId: authorization.approvalRequest?.id ?? null,
                  message: `Tool '${toolCall.name}' requires approval before execution.`,
                });
              } else if (tool instanceof DynamicStructuredTool) {
                toolOutput = await tool.invoke(args);
              } else {
                const toolInput = typeof toolCall.args === "string" ? toolCall.args : JSON.stringify(toolCall.args ?? {});
                toolOutput = await tool.invoke(toolInput);
              }
            }
          } catch (error) {
            toolFailed = true;
            toolOutput = `Tool '${toolCall.name}' execution failed: ${
              error instanceof Error ? error.message : "unknown_error"
            }`;
          }

          const outputText = typeof toolOutput === "string" ? toolOutput : formatToolPayload(toolOutput);
          const durationMs = Date.now() - startedAt;
          const summary = outputText.replace(/\s+/g, " ").trim().slice(0, 300);
          const detailToken =
            outputText.length >= TOOL_DETAIL_PERSIST_THRESHOLD
              ? await persistAgentRunToolDetail({
                  officeId: runtimeOfficeId,
                  runId: runtimeContext.runId ?? null,
                  taskId: runtimeContext.taskId ?? null,
                  toolName: toolCall.name,
                  toolCallId: toolCall.id,
                  detail: outputText,
                  preview: outputText.slice(0, 1200),
                  metadata: {
                    source: "llm_tool_call_result",
                    threadId: runtimeContext.threadId ?? null,
                    toolGroupId,
                    toolGroupStep: groupStep,
                  },
                })
              : null;

          await recordToolInvocation({
            officeId: runtimeOfficeId,
            runId: runtimeContext.runId ?? null,
            taskId: runtimeContext.taskId ?? null,
            toolId: toolCall.name,
            role: runtimeRole,
            arguments: args,
            riskLevel: authorizationRisk,
            decision: authorizationDecision,
            status: toolFailed ? "failed" : "completed",
            output: { text: outputText.slice(0, 4000), detailToken },
            error: toolFailed ? outputText.slice(0, 1000) : null,
            metadata: {
              source: "llm_tool_call_result",
              threadId: runtimeContext.threadId ?? null,
              toolCallId: toolCall.id,
              toolGroupId,
              toolGroupStep: groupStep,
              argsPreview,
              summary,
              detailToken,
              durationMs,
            },
          });

          if (runtimeRole) {
            events.push({
              name: toolCall.name,
              status: toolFailed ? "failed" : "completed",
              argsPreview,
              message: toolFailed ? `Tool ${toolCall.name} failed` : `Tool ${toolCall.name} completed`,
              output: outputText,
            });
            await patchAgentRuntimeByRole(runtimeRole, {
              officeId: runtimeOfficeId,
              status: toolFailed ? "error" : "working",
              currentAction: toolFailed ? `Tool ${toolCall.name} failed` : `Tool ${toolCall.name} completed`,
              currentSkill: null,
              metadata: {
                source: "llm_tool_call",
                toolName: toolCall.name,
                toolGroupId,
                finishedAt: new Date().toISOString(),
                elapsedMs: durationMs,
                failed: toolFailed,
                officeId: runtimeOfficeId,
              },
            });
            await publishTeamEvent({
              roomKey: roomKey || undefined,
              eventName: toolFailed ? "workflow.tool_failed" : "workflow.tool_completed",
              scope: "system",
              senderRole: runtimeRole,
              senderName: runtimeRole,
              targetRole: runtimeRole,
              payload: {
                taskId: runtimeContext.taskId ?? null,
                threadId: runtimeContext.threadId ?? null,
                runId: runtimeContext.runId ?? null,
                role: runtimeRole,
                agentName: runtimeRole,
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                toolGroupId,
                argsPreview,
                message: toolFailed ? `Tool ${toolCall.name} failed` : `Tool ${toolCall.name} completed`,
                output: outputText.slice(0, 1500),
                detailToken,
                durationMs,
                failed: toolFailed,
                officeId: runtimeOfficeId,
              },
            });
            await publishTeamEvent({
              roomKey: roomKey || undefined,
              eventName: "workflow.task_update",
              scope: "system",
              senderRole: runtimeRole,
              senderName: runtimeRole,
              targetRole: runtimeRole,
              payload: {
                taskId: runtimeContext.taskId ?? null,
                threadId: runtimeContext.threadId ?? null,
                runId: runtimeContext.runId ?? null,
                role: runtimeRole,
                toolGroupId,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                status: toolFailed ? "failed" : "completed",
                summary,
                detailToken,
                durationMs,
                officeId: runtimeOfficeId,
              },
            });
          }

          return {
            toolCall,
            outputText,
            toolFailed,
            durationMs,
            events,
          };
        })
      );

      const normalizedResults = settledToolResults.map((result, index) => {
        if (result.status === "fulfilled") return result.value;
        const toolCall = batch[index];
        return {
          toolCall,
          outputText: `Tool '${toolCall.name}' execution failed: ${
            result.reason instanceof Error ? result.reason.message : "unknown_error"
          }`,
          toolFailed: true,
          durationMs: 0,
          events: [] as AgentToolEvent[],
        };
      });

      for (const result of normalizedResults) {
        toolEvents.push(...result.events);
        conversation.push(
          new ToolMessage({
            tool_call_id: result.toolCall.id,
            content: result.outputText,
          })
        );
      }

      if (runtimeRole) {
        await publishTeamEvent({
          roomKey: roomKey || undefined,
          eventName: "workflow.task_group_end",
          scope: "system",
          senderRole: runtimeRole,
          senderName: runtimeRole,
          targetRole: runtimeRole,
          payload: {
            taskId: runtimeContext.taskId ?? null,
            threadId: runtimeContext.threadId ?? null,
            runId: runtimeContext.runId ?? null,
            role: runtimeRole,
            toolGroupId,
            toolGroupStep: groupStep,
            status: normalizedResults.some((result) => result.toolFailed) ? "failed" : "completed",
            durationMs: Date.now() - groupStartedAt,
            officeId: runtimeOfficeId,
          },
        });
      }
    }

    response = await llm.invoke(conversation);
  }

  return { response, executedTools: Array.from(executedTools), toolEvents };
};

const getTokenCounter = (modelName: string) => {
  if (!geminiApiKey) {
    return null;
  }

  const cached = tokenCounters.get(modelName);
  if (cached) {
    return cached;
  }

  const client = new GoogleGenerativeAI(geminiApiKey);
  const counter = client.getGenerativeModel({ model: modelName });
  tokenCounters.set(modelName, counter);
  return counter;
};

const isModelUnavailableError = (error: unknown): boolean => {
  const message = String(error instanceof Error ? error.message : error ?? "").toLowerCase();
  return (
    message.includes("not found") &&
    message.includes("models/") &&
    (message.includes("generatecontent") || message.includes("api version"))
  );
};

export interface AgentInvocationResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  availableTools: string[];
  executedTools: string[];
  toolEvents: AgentToolEvent[];
}

interface AgentInvocationOptions {
  officeId?: string | null;
  role?: string | null;
  taskId?: string | null;
  threadId?: string | null;
  roomKey?: string | null;
  runId?: string | null;
  modelTier?: ModelTier | null;
  // Internal: set on the single retry after an unavailable-model error to
  // guarantee the recursion terminates.
  _modelFallbackAttempted?: boolean;
}

const fallbackByRole: Record<string, string> = {
  PM: "Принято. Декомпозирую задачу и распределяю работу между ролями.",
  Developer: "Готов к реализации. Подготовлю модульный и типобезопасный план.",
  QA: "Готов к проверке. Сформирую чеклист регресса и edge-case сценариев.",
  DevOps: "Готов к релизу. Проверю окружение, логи и безопасный деплой.",
};

const resolveFallbackByRole = (role: string): string => {
  const direct = fallbackByRole[role];
  if (direct) return direct;

  const normalized = role.trim().toLowerCase();
  if (normalized.includes("ceo") || normalized.includes("manager")) {
    return "Accepted. I will structure the task, break it down, and route it across the office.";
  }
  if (normalized.includes("qa") || normalized.includes("test") || normalized.includes("review")) {
    return "Ready to validate the result, record issues, and decide whether to approve or reject.";
  }
  if (normalized.includes("devops") || normalized.includes("sre") || normalized.includes("infra")) {
    return "Ready to inspect infrastructure, logs, release readiness, and environment blockers.";
  }
  if (normalized.includes("dev") || normalized.includes("engineer")) {
    return "Ready to produce the implementation artifact and document blockers or assumptions.";
  }
  return `${role} is ready to process the assigned office task and produce the next artifact.`;
};

const normalizeContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\\n");
  }

  return "";
};

const normalizeMessageContent = (message: BaseMessage): string => {
  return normalizeContent((message as unknown as { content?: unknown }).content);
};

const buildPromptTextForCounting = (messages: BaseMessage[]): string => {
  return messages
    .map((message) => {
      const messageType =
        typeof (message as { _getType?: unknown })._getType === "function"
          ? String((message as { _getType: () => unknown })._getType())
          : "message";
      const content = normalizeMessageContent(message);
      return `[${messageType}] ${content}`;
    })
    .join("\\n")
    .trim();
};

const estimateTokensByText = (text: string): number => {
  const normalized = text.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.round(normalized.length / 4));
};

const countTokensByApi = async (text: string, modelName: string): Promise<number | null> => {
  const normalized = text.trim();
  if (!normalized) return 0;

  const counter = getTokenCounter(modelName);
  if (!counter) return null;

  try {
    const result = await counter.countTokens(normalized);
    const total = getPositiveNumber(
      (result as { totalTokens?: unknown }).totalTokens,
      (result as { total_tokens?: unknown }).total_tokens
    );
    return total > 0 ? Math.round(total) : 0;
  } catch (error) {
    console.warn("[LLM] countTokens fallback failed:", error);
    return null;
  }
};

const extractUsageTokens = (
  response: unknown
): {
  promptTokens: number;
  completionTokens: number;
} => {
  const envelope = response as {
    usage_metadata?: Record<string, unknown>;
    usageMetadata?: Record<string, unknown>;
    response_metadata?: Record<string, unknown>;
    responseMetadata?: Record<string, unknown>;
    additional_kwargs?: Record<string, unknown>;
    additionalKwargs?: Record<string, unknown>;
  };

  const responseMetadata =
    envelope.response_metadata ??
    envelope.responseMetadata ??
    ({} as Record<string, unknown>);

  const additionalKwargs =
    envelope.additional_kwargs ??
    envelope.additionalKwargs ??
    ({} as Record<string, unknown>);

  const usageMetadata =
    envelope.usage_metadata ??
    envelope.usageMetadata ??
    (responseMetadata.usage_metadata as Record<string, unknown> | undefined) ??
    (responseMetadata.usageMetadata as Record<string, unknown> | undefined) ??
    (additionalKwargs.usage_metadata as Record<string, unknown> | undefined) ??
    (additionalKwargs.usageMetadata as Record<string, unknown> | undefined) ??
    ({} as Record<string, unknown>);

  const tokenUsage =
    (responseMetadata.tokenUsage as Record<string, unknown> | undefined) ??
    (responseMetadata.token_usage as Record<string, unknown> | undefined) ??
    ({} as Record<string, unknown>);

  const promptTokens = Math.round(
    getPositiveNumber(
      usageMetadata.input_tokens,
      usageMetadata.inputTokens,
      usageMetadata.prompt_tokens,
      usageMetadata.promptTokens,
      tokenUsage.promptTokenCount,
      tokenUsage.inputTokenCount
    )
  );
  const completionTokens = Math.round(
    getPositiveNumber(
      usageMetadata.output_tokens,
      usageMetadata.outputTokens,
      usageMetadata.completion_tokens,
      usageMetadata.completionTokens,
      tokenUsage.candidatesTokenCount,
      tokenUsage.outputTokenCount,
      tokenUsage.completionTokenCount
    )
  );

  return {
    promptTokens: Math.max(0, promptTokens),
    completionTokens: Math.max(0, completionTokens),
  };
};

export const invokeAgentModel = async (
  role: string,
  messages: BaseMessage[],
  options: AgentInvocationOptions = {}
): Promise<AgentInvocationResult> => {
  let resolvedTier = resolveTierForInvocation({
    requestedTier: options.modelTier ?? null,
    promptText: messages.map((message) => normalizeMessageContent(message)).join("\n"),
  });
  // Budget warn → downgrade to the configured force tier (default `fast`) so
  // an office approaching its cap automatically switches to its cheapest
  // model. Only applied when the caller did not request an explicit tier.
  if (!options.modelTier && options.officeId) {
    try {
      const budget = await evaluateBudget(options.officeId);
      if (
        budget.state === "warn" &&
        (MODEL_TIER_ORDER as readonly string[]).includes(budget.forceTier) &&
        budget.forceTier !== resolvedTier
      ) {
        resolvedTier = budget.forceTier as ModelTier;
      }
    } catch (error) {
      console.warn("[LLM] budget evaluation skipped:", error);
    }
  }
  const modelName = resolveModelName(resolvedTier);
  const { llm, activeTools, approveModeEnabled, approveModeMinRisk } = await getInvokableLlm(
    modelName,
    options.officeId ?? null,
    options.role ?? role,
    options.taskId ?? null,
    options.threadId ?? null,
    options.roomKey ?? null,
    options.runId ?? null
  );
  const availableTools = Array.from(new Set(activeTools.map((tool) => tool.name)));
  if (!llm) {
    return {
      content: resolveFallbackByRole(role),
      model: "fallback",
      promptTokens: 0,
      completionTokens: 0,
      availableTools,
      executedTools: [],
      toolEvents: [],
    };
  }

  try {
    const result =
      activeTools.length > 0
        ? await runModelWithTools(llm, messages, activeTools, {
            officeId: options.officeId ?? null,
            role: options.role ?? role,
            taskId: options.taskId ?? null,
            threadId: options.threadId ?? null,
            roomKey: options.roomKey ?? null,
            runId: options.runId ?? null,
            modelName,
            approveModeEnabled,
            approveModeMinRisk,
          })
        : {
            response: await llm.invoke(messages),
            executedTools: [] as string[],
            toolEvents: [] as AgentToolEvent[],
          };
    const response = result.response;
    const content = normalizeContent((response as any).content) || resolveFallbackByRole(role);
    let { promptTokens, completionTokens } = extractUsageTokens(response);

    if (promptTokens <= 0 || completionTokens <= 0) {
      const promptText = buildPromptTextForCounting(messages);
      const needsPrompt = promptTokens <= 0;
      const needsCompletion = completionTokens <= 0;

      const [promptCount, completionCount] = await Promise.all([
        needsPrompt ? countTokensByApi(promptText, modelName) : Promise.resolve<number | null>(null),
        needsCompletion ? countTokensByApi(content, modelName) : Promise.resolve<number | null>(null),
      ]);

      if (needsPrompt) {
        promptTokens = promptCount ?? estimateTokensByText(promptText);
      }
      if (needsCompletion) {
        completionTokens = completionCount ?? estimateTokensByText(content);
      }
    }

    return {
      content,
      model: (response as any).response_metadata?.model_name ?? modelName,
      promptTokens: Math.max(0, Math.round(promptTokens)),
      completionTokens: Math.max(0, Math.round(completionTokens)),
      availableTools,
      executedTools: result.executedTools,
      toolEvents: result.toolEvents,
    };
  } catch (error) {
    if (
      isModelUnavailableError(error) &&
      modelName !== DEFAULT_GEMINI_MODEL &&
      !options._modelFallbackAttempted
    ) {
      console.warn(
        `[LLM] ${role} model '${modelName}' unavailable. Retrying with '${DEFAULT_GEMINI_MODEL}'.`
      );
      llmInstances.delete(modelName);
      tokenCounters.delete(modelName);
      return invokeAgentModel(role, messages, {
        ...options,
        modelTier: "standard",
        _modelFallbackAttempted: true,
      });
    }

    console.error(`[LLM] ${role} fallback triggered:`, error);
    return {
      content: resolveFallbackByRole(role),
      model: "fallback",
      promptTokens: 0,
      completionTokens: 0,
      availableTools,
      executedTools: [],
      toolEvents: [],
    };
  }
};

