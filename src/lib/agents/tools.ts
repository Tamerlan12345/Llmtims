import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { DynamicStructuredTool, DynamicTool } from "@langchain/core/tools";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { randomUUID } from "node:crypto";
import { z, type ZodTypeAny } from "zod";
import { loadServerEnv } from "@/lib/config/serverEnv";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";
import { callPreferredMcpTool, loadDynamicMcpTools } from "@/lib/mcp/client";
import {
  patchAgentRuntimeByRole,
  patchPlayerStateByRole,
  patchRoomState,
  publishTeamEvent,
} from "./realtime";
import { buildOfficeRoomKey } from "@/lib/offices/utils";

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
  role?: string | null;
  taskId?: string | null;
  threadId?: string | null;
  roomKey?: string | null;
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
const DELEGATION_REWORK_LIMIT = 2;
const SKILL_ARTIFACTS_BUCKET = process.env.SKILL_ARTIFACTS_BUCKET ?? "office-artifacts";

const SKILL_ENDPOINT_ENV_BY_NAME: Record<string, string> = {
  vercel_project_deployer: "VERCEL_DEPLOYER_ENDPOINT",
};

const normalizeSkillName = (value: string): string => value.trim().toLowerCase();

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
}): Promise<string | null> => {
  if (!isServerSupabaseConfigured || !officeId || !taskId || !storagePath) {
    return null;
  }

  try {
    const payload = {
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
    const { data, error } = await supabase
      .from("task_artifacts")
      .insert(payload)
      .select("id")
      .single();

    if (error) {
      console.error("[tools] failed to persist task artifact:", error.message, payload);
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
  const attemptErrors: string[] = [];

  try {
    for (const candidate of IMAGE_MODEL_FALLBACK_CHAIN) {
      console.info("[image_generator] attempting model", {
        model: candidate.model,
        label: candidate.label,
        transport: candidate.transport,
        role: executionContext.role ?? null,
        officeId: executionContext.officeId ?? null,
      });

      const result =
        candidate.transport === "gemini_generate_content"
          ? await requestGeminiNativeImage(apiKey, candidate.model, prompt)
          : await requestImagenPredictImage(apiKey, candidate.model, prompt, aspectRatio);

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

const executeVeoSkill = async (payload: Record<string, unknown>): Promise<string> => {
  const prompt =
    typeof payload.prompt === "string" && payload.prompt.trim().length > 0
      ? payload.prompt.trim()
      : typeof payload.input === "string" && payload.input.trim().length > 0
        ? payload.input.trim()
        : "";
  const duration =
    typeof payload.duration_seconds === "number" && Number.isFinite(payload.duration_seconds)
      ? payload.duration_seconds
      : 5;

  if (!prompt) {
    return "video_generator: prompt is required.";
  }

  return [
    `[Системное уведомление]: Запрос на генерацию видео по промпту "${prompt}" отправлен в движок Google Veo.`,
    `Ожидаемая длительность: ${duration} сек.`,
    "Ожидайте готовности видеофайла в Артефактах через несколько минут.",
  ].join("\\n");
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
    return executeVeoSkill(payload);
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

const loadSystemTools = (
  executionContext: OfficeSkillExecutionContext = {}
): AgentTool[] => [createDelegateTaskTool(executionContext)];

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

    return (definitions ?? [])
      .map((row) => {
        if (typeof row.id !== "string" || typeof row.name !== "string") {
          return null;
        }

        return buildOfficeSkillTool({
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
        }, {
          officeId,
          role,
          taskId,
          threadId,
          roomKey,
        });
      })
      .filter((tool): tool is AgentTool => Boolean(tool));
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
  command: string
): Promise<SandboxValidationResult> => {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return {
      passed: true,
      status: "skipped",
      toolName: null,
      output: "Validation command is empty, sandbox validation skipped.",
    };
  }

  const result = await callPreferredMcpTool(
    ["sandbox_execution", "sandbox__execution", "sandbox.execution"],
    { command: normalizedCommand }
  );

  if (!result) {
    return {
      passed: true,
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
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const enableToolCallDebugLogging = process.env.DEBUG_LLM_TOOL_CALLS === "true";
const normalizeGeminiModel = (value: string | undefined): string => {
  const normalized = String(value ?? "").trim();
  if (!normalized) return DEFAULT_GEMINI_MODEL;
  // Guard against unsupported placeholder model names frequently copied into envs.
  if (normalized === "gemini-3.0-flash") {
    console.warn(
      `[LLM] Model '${normalized}' is unsupported in this runtime. Falling back to '${DEFAULT_GEMINI_MODEL}'.`
    );
    return DEFAULT_GEMINI_MODEL;
  }
  return normalized;
};
let activeGeminiModel = normalizeGeminiModel(process.env.GEMINI_MODEL);
export const isLlmConfigured = Boolean(geminiApiKey);
let llmInstance: ChatGoogleGenerativeAI | null = null;
let geminiTokenCounter: ReturnType<GoogleGenerativeAI["getGenerativeModel"]> | null = null;

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

const getLlm = () => {
  if (!isLlmConfigured) {
    return null;
  }

  if (llmInstance) {
    return llmInstance;
  }

  const model = new ChatGoogleGenerativeAI({
    modelName: activeGeminiModel,
    maxOutputTokens: 2048,
    apiKey: geminiApiKey,
  });

  llmInstance = model;
  return llmInstance;
};

const getInvokableLlm = async (
  officeId?: string | null,
  role?: string | null,
  taskId?: string | null,
  threadId?: string | null,
  roomKey?: string | null
): Promise<{
  llm: ReturnType<ChatGoogleGenerativeAI["bindTools"]> | ChatGoogleGenerativeAI | null;
  activeTools: AgentTool[];
}> => {
  const model = getLlm();
  if (!model) {
    return { llm: null, activeTools: [] };
  }

  const mcpTools = enableMockMcpTools ? tools : await loadDynamicMcpTools();
  const officeTools = await loadInstalledSkillTools(officeId, role, taskId, threadId, roomKey);
  const systemTools = loadSystemTools({ officeId, role, taskId, threadId, roomKey });
  const activeTools = [...mcpTools, ...systemTools, ...officeTools];

  if (activeTools.length > 0 && typeof model.bindTools === "function") {
    return { llm: model.bindTools(activeTools), activeTools };
  }

  return { llm: model, activeTools };
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
  } = {}
) => {
  const toolRegistry = new Map(activeTools.map((tool) => [tool.name, tool]));
  const conversation: BaseMessage[] = [...messages];
  logToolCallDiagnostics("before_invoke", {
    model: activeGeminiModel,
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
      model: activeGeminiModel,
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

    for (const toolCall of toolCalls) {
      const tool = toolRegistry.get(toolCall.name);
      if (runtimeRole) {
        toolEvents.push({
          name: toolCall.name,
          status: "started",
          argsPreview: formatToolPayload(toolCall.args),
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
            startedAt: new Date().toISOString(),
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
            role: runtimeRole,
            agentName: runtimeRole,
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            argsPreview: formatToolPayload(toolCall.args),
            message: `Using tool ${toolCall.name}`,
            officeId: runtimeOfficeId,
          },
        });
      }

      const startedAt = Date.now();
      let toolOutput: unknown;
      let toolFailed = false;
      try {
        executedTools.add(toolCall.name);
        if (!tool) {
          toolOutput = `Tool '${toolCall.name}' is not registered for this office.`;
        } else if (tool instanceof DynamicStructuredTool) {
          toolOutput = await tool.invoke(toStructuredPayload(toolCall.args));
        } else {
          const toolInput =
            typeof toolCall.args === "string" ? toolCall.args : JSON.stringify(toolCall.args ?? {});
          toolOutput = await tool.invoke(toolInput);
        }
      } catch (error) {
        toolFailed = true;
        toolOutput = `Tool '${toolCall.name}' execution failed: ${
          error instanceof Error ? error.message : "unknown_error"
        }`;
      }

      if (runtimeRole) {
        toolEvents.push({
          name: toolCall.name,
          status: toolFailed ? "failed" : "completed",
          argsPreview: formatToolPayload(toolCall.args),
          message: toolFailed ? `Tool ${toolCall.name} failed` : `Tool ${toolCall.name} completed`,
          output: typeof toolOutput === "string" ? toolOutput : formatToolPayload(toolOutput),
        });
        await patchAgentRuntimeByRole(runtimeRole, {
          officeId: runtimeOfficeId,
          status: toolFailed ? "error" : "working",
          currentAction: toolFailed
            ? `Tool ${toolCall.name} failed`
            : `Tool ${toolCall.name} completed`,
          currentSkill: null,
          metadata: {
            source: "llm_tool_call",
            toolName: toolCall.name,
            finishedAt: new Date().toISOString(),
            elapsedMs: Date.now() - startedAt,
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
            role: runtimeRole,
            agentName: runtimeRole,
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            argsPreview: formatToolPayload(toolCall.args),
            message: toolFailed ? `Tool ${toolCall.name} failed` : `Tool ${toolCall.name} completed`,
            output:
              typeof toolOutput === "string" ? toolOutput.slice(0, 1500) : formatToolPayload(toolOutput),
            failed: toolFailed,
            officeId: runtimeOfficeId,
          },
        });
      }

      conversation.push(
        new ToolMessage({
          tool_call_id: toolCall.id,
          content: typeof toolOutput === "string" ? toolOutput : formatToolPayload(toolOutput),
        })
      );
    }

    response = await llm.invoke(conversation);
  }

  return { response, executedTools: Array.from(executedTools), toolEvents };
};

const getTokenCounter = () => {
  if (!geminiApiKey) {
    return null;
  }

  if (geminiTokenCounter) {
    return geminiTokenCounter;
  }

  const client = new GoogleGenerativeAI(geminiApiKey);
  geminiTokenCounter = client.getGenerativeModel({ model: activeGeminiModel });
  return geminiTokenCounter;
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

const countTokensByApi = async (text: string): Promise<number | null> => {
  const normalized = text.trim();
  if (!normalized) return 0;

  const counter = getTokenCounter();
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
  const { llm, activeTools } = await getInvokableLlm(
    options.officeId ?? null,
    options.role ?? role,
    options.taskId ?? null,
    options.threadId ?? null,
    options.roomKey ?? null
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
        needsPrompt ? countTokensByApi(promptText) : Promise.resolve<number | null>(null),
        needsCompletion ? countTokensByApi(content) : Promise.resolve<number | null>(null),
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
      model: (response as any).response_metadata?.model_name ?? activeGeminiModel,
      promptTokens: Math.max(0, Math.round(promptTokens)),
      completionTokens: Math.max(0, Math.round(completionTokens)),
      availableTools,
      executedTools: result.executedTools,
      toolEvents: result.toolEvents,
    };
  } catch (error) {
    if (isModelUnavailableError(error) && activeGeminiModel !== DEFAULT_GEMINI_MODEL) {
      console.warn(
        `[LLM] ${role} model '${activeGeminiModel}' unavailable. Retrying with '${DEFAULT_GEMINI_MODEL}'.`
      );
      activeGeminiModel = DEFAULT_GEMINI_MODEL;
      llmInstance = null;
      geminiTokenCounter = null;
      return invokeAgentModel(role, messages, options);
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

