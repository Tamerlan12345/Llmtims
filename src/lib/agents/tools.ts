import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { DynamicTool } from "@langchain/core/tools";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { GoogleGenerativeAI } from "@google/generative-ai";
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

const executeHttpSkill = async (
  definition: OfficeSkillToolDefinition,
  input: string
): Promise<string> => {
  if (!definition.endpoint) {
    return `Skill '${definition.name}' has no endpoint configured.`;
  }

  const payload = parseStructuredToolInput(input);
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
const geminiApiKey = process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
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
