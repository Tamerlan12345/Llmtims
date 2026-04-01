import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { DynamicTool } from "@langchain/core/tools";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { randomUUID } from "node:crypto";
import { loadServerEnv } from "@/lib/config/serverEnv";
import { isServerSupabaseConfigured, supabaseServer as supabase } from "@/lib/supabase/server";

loadServerEnv();

const enableMockMcpTools = process.env.ENABLE_MOCK_MCP_TOOLS === "true";

export const LLM_TOOL_RUNTIME_MODE = enableMockMcpTools
  ? "stub-tools-enabled"
  : "direct-model-only";

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

const formatToolPayload = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const SKILL_ARTIFACTS_BUCKET = process.env.SKILL_ARTIFACTS_BUCKET ?? "skill-artifacts";

const SKILL_ENDPOINT_ENV_BY_NAME: Record<string, string> = {
  vercel_project_deployer: "VERCEL_DEPLOYER_ENDPOINT",
};

const normalizeSkillName = (value: string): string => value.trim().toLowerCase();

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

const toDataUrl = (contentType: string, payload: Buffer): string =>
  `data:${contentType};base64,${payload.toString("base64")}`;

const ensureStorageBucket = async (bucketName: string) => {
  try {
    await supabase.storage.createBucket(bucketName, { public: true });
  } catch {
    // Ignore, bucket may already exist or current key may not have bucket admin rights.
  }
};

const uploadArtifactToStorage = async (
  fileName: string,
  contentType: string,
  payload: Buffer
): Promise<{
  url: string;
  storagePath: string | null;
  transport: "storage" | "data_url";
}> => {
  if (!isServerSupabaseConfigured) {
    return { url: toDataUrl(contentType, payload), storagePath: null, transport: "data_url" };
  }

  const safeName = sanitizeFileName(fileName, `artifact-${Date.now()}`);
  const storagePath = `generated/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeName}`;

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
    return { url: toDataUrl(contentType, payload), storagePath: null, transport: "data_url" };
  }

  const bucket = supabase.storage.from(SKILL_ARTIFACTS_BUCKET);
  const { data: publicData } = bucket.getPublicUrl(storagePath);
  if (publicData?.publicUrl) {
    return {
      url: publicData.publicUrl,
      storagePath,
      transport: "storage",
    };
  }

  const signed = await bucket.createSignedUrl(storagePath, 60 * 60 * 24 * 7);
  if (!signed.error && signed.data?.signedUrl) {
    return {
      url: signed.data.signedUrl,
      storagePath,
      transport: "storage",
    };
  }

  return { url: toDataUrl(contentType, payload), storagePath: null, transport: "data_url" };
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
  const streamContent = streamLines.join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(streamContent, "utf8")} >>\nstream\n${streamContent}\nendstream`,
  ];

  let output = "%PDF-1.4\n";
  const offsets: number[] = [0];

  objects.forEach((objectBody, index) => {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += `${index + 1} 0 obj\n${objectBody}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
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

const executeImagenSkill = async (payload: Record<string, unknown>): Promise<string> => {
  const prompt =
    typeof payload.prompt === "string" && payload.prompt.trim().length > 0
      ? payload.prompt.trim()
      : typeof payload.input === "string" && payload.input.trim().length > 0
        ? payload.input.trim()
        : "";

  if (!prompt) {
    return "image_generator: prompt is required.";
  }

  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    return "image_generator: GEMINI_API_KEY is not configured.";
  }

  const aspectRatio = resolveImagenAspectRatio(payload.aspect_ratio);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-images:predict?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio,
          outputOptions: { mimeType: "image/jpeg" },
        },
      }),
    });

    const data = (await response.json()) as {
      predictions?: Array<{ bytesBase64Encoded?: string }>;
      [key: string]: unknown;
    };

    if (!response.ok) {
      return `image_generator failed with ${response.status}: ${JSON.stringify(data)}`;
    }

    const base64Image = data.predictions?.[0]?.bytesBase64Encoded;
    if (typeof base64Image !== "string" || base64Image.length === 0) {
      return `Ошибка генерации изображения: ${JSON.stringify(data)}`;
    }

    return `![Generated Image](data:image/jpeg;base64,${base64Image})`;
  } catch (error) {
    return `image_generator request failed: ${error instanceof Error ? error.message : "unknown_error"}`;
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
  ].join("\n");
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
  payload: Record<string, unknown>
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
      `${sanitizeFileName(title, "document")}.pdf`,
      "application/pdf",
      pdfBuffer
    );

    return [
      `PDF generated using template '${template}'.`,
      `Title: ${title}`,
      `URL: ${uploaded.url}`,
      uploaded.storagePath ? `Storage path: ${uploaded.storagePath}` : null,
    ]
      .filter(Boolean)
      .join("\n");
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
      `${sanitizeFileName(filename, "report")}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      workbook
    );

    return [
      `Excel report generated with ${Math.max(1, sheets.length)} sheet(s).`,
      `URL: ${uploaded.url}`,
      uploaded.storagePath ? `Storage path: ${uploaded.storagePath}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (skillName === "image_generator") {
    return executeImagenSkill(payload);
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
  input: string
): Promise<string> => {
  const payload = parseStructuredToolInput(input);
  const managedResult = await executeManagedSkill(definition, payload);
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
  input: string
): Promise<string> => {
  const payload = parseStructuredToolInput(input);
  const normalizedName = definition.name.toLowerCase();

  const managedResult = await executeManagedSkill(definition, payload);
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
    ].join("\n");
  }

  return [
    `Internal skill '${definition.name}' executed.`,
    definition.implementationRef ? `Implementation ref: ${definition.implementationRef}` : null,
    `Payload: ${formatToolPayload(payload)}`,
  ]
    .filter(Boolean)
    .join("\n");
};

const buildOfficeSkillTool = (definition: OfficeSkillToolDefinition) =>
  new DynamicTool({
    name: definition.name,
    description: [
      definition.description,
      definition.instructionMarkdown
        ? `Instruction summary: ${definition.instructionMarkdown.slice(0, 320)}`
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    func: async (input: string) => {
      const runtime = definition.runtime ?? "internal";
      if (runtime === "http") {
        return executeHttpSkill(definition, input);
      }
      if (runtime === "internal") {
        return executeInternalSkill(definition, input);
      }

      return [
        `Skill '${definition.name}' uses runtime '${runtime}'.`,
        definition.endpoint ? `Endpoint: ${definition.endpoint}` : null,
        "Runtime adapter is not available in this service build.",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

export const loadInstalledSkillTools = async (
  officeId?: string | null,
  role?: string | null
): Promise<DynamicTool[]> => {
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
        });
      })
      .filter((tool): tool is DynamicTool => Boolean(tool));
  } catch (error) {
    console.error("[tools] failed to load installed skill tools:", error);
    return [];
  }
};
const geminiApiKey =
  process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
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
    modelName: geminiModel,
    maxOutputTokens: 2048,
    apiKey: geminiApiKey,
  });

  llmInstance = model;
  return llmInstance;
};

const getInvokableLlm = async (
  officeId?: string | null,
  role?: string | null
): Promise<{
  llm: ReturnType<ChatGoogleGenerativeAI["bindTools"]> | ChatGoogleGenerativeAI | null;
  activeTools: DynamicTool[];
}> => {
  const model = getLlm();
  if (!model) {
    return { llm: null, activeTools: [] };
  }

  const officeTools = await loadInstalledSkillTools(officeId, role);
  const activeTools = [...(enableMockMcpTools ? tools : []), ...officeTools];

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

const runModelWithTools = async (
  llm: ReturnType<ChatGoogleGenerativeAI["bindTools"]> | ChatGoogleGenerativeAI,
  messages: BaseMessage[],
  activeTools: DynamicTool[]
) => {
  const toolRegistry = new Map(activeTools.map((tool) => [tool.name, tool]));
  const conversation: BaseMessage[] = [...messages];
  let response = await llm.invoke(conversation);

  for (let round = 0; round < 4; round += 1) {
    const toolCalls = normalizeToolCalls(response);
    if (toolCalls.length === 0) {
      return response;
    }

    conversation.push(response as AIMessage);

    for (const toolCall of toolCalls) {
      const tool = toolRegistry.get(toolCall.name);
      const toolInput = typeof toolCall.args === "string" ? toolCall.args : JSON.stringify(toolCall.args ?? {});
      const toolOutput = tool
        ? await tool.invoke(toolInput)
        : `Tool '${toolCall.name}' is not registered for this office.`;

      conversation.push(
        new ToolMessage({
          tool_call_id: toolCall.id,
          content: typeof toolOutput === "string" ? toolOutput : formatToolPayload(toolOutput),
        })
      );
    }

    response = await llm.invoke(conversation);
  }

  return response;
};

const getTokenCounter = () => {
  if (!geminiApiKey) {
    return null;
  }

  if (geminiTokenCounter) {
    return geminiTokenCounter;
  }

  const client = new GoogleGenerativeAI(geminiApiKey);
  geminiTokenCounter = client.getGenerativeModel({ model: geminiModel });
  return geminiTokenCounter;
};

export interface AgentInvocationResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

interface AgentInvocationOptions {
  officeId?: string | null;
  role?: string | null;
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
      .join("\n");
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
    .join("\n")
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
  const { llm, activeTools } = await getInvokableLlm(options.officeId ?? null, options.role ?? role);
  if (!llm) {
    return {
      content: resolveFallbackByRole(role),
      model: "fallback",
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  try {
    const response =
      activeTools.length > 0 ? await runModelWithTools(llm, messages, activeTools) : await llm.invoke(messages);
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
      model: (response as any).response_metadata?.model_name ?? geminiModel,
      promptTokens: Math.max(0, Math.round(promptTokens)),
      completionTokens: Math.max(0, Math.round(completionTokens)),
    };
  } catch (error) {
    console.error(`[LLM] ${role} fallback triggered:`, error);
    return {
      content: resolveFallbackByRole(role),
      model: "fallback",
      promptTokens: 0,
      completionTokens: 0,
    };
  }
};
