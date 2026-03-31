import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { DynamicTool } from "@langchain/core/tools";
import { BaseMessage } from "@langchain/core/messages";
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
  runtime?: string | null;
  endpoint?: string | null;
  parameterSchema?: Record<string, unknown> | null;
  isVerified?: boolean;
  implementationRef?: string | null;
}

const buildOfficeSkillTool = (definition: OfficeSkillToolDefinition) =>
  new DynamicTool({
    name: definition.name,
    description: definition.description,
    func: async (input: string) => {
      const runtime = definition.runtime ?? "internal";
      const verificationNote = definition.isVerified ? "verified" : "unverified";
      console.info(`[OfficeSkill:${definition.name}] runtime=${runtime} input=${input}`);
      return [
        `Office skill '${definition.name}' invoked in ${runtime} mode.`,
        `Verification: ${verificationNote}.`,
        definition.endpoint ? `Endpoint: ${definition.endpoint}` : null,
        definition.implementationRef ? `Implementation ref: ${definition.implementationRef}` : null,
        `Input: ${input}`,
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

export const loadInstalledSkillTools = async (
  officeId?: string | null
): Promise<DynamicTool[]> => {
  if (!isServerSupabaseConfigured || !officeId) {
    return [];
  }

  try {
    const { data: agents } = await supabase.from("agents").select("id").eq("office_id", officeId);
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
      .select("id, name, description, runtime, endpoint, parameter_schema, is_verified, implementation_ref")
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

const getInvokableLlm = async (officeId?: string | null) => {
  const model = getLlm();
  if (!model) {
    return null;
  }

  const officeTools = await loadInstalledSkillTools(officeId);
  const activeTools = [...(enableMockMcpTools ? tools : []), ...officeTools];

  if (activeTools.length > 0 && typeof model.bindTools === "function") {
    return model.bindTools(activeTools);
  }

  return model;
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
}

const fallbackByRole: Record<string, string> = {
  PM: "Принято. Декомпозирую задачу и распределяю работу между ролями.",
  Developer: "Готов к реализации. Подготовлю модульный и типобезопасный план.",
  QA: "Готов к проверке. Сформирую чеклист регресса и edge-case сценариев.",
  DevOps: "Готов к релизу. Проверю окружение, логи и безопасный деплой.",
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
  role: keyof typeof fallbackByRole,
  messages: BaseMessage[],
  options: AgentInvocationOptions = {}
): Promise<AgentInvocationResult> => {
  const llm = await getInvokableLlm(options.officeId ?? null);
  if (!llm) {
    return {
      content: fallbackByRole[role],
      model: "fallback",
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  try {
    const response = await llm.invoke(messages);
    const content = normalizeContent((response as any).content) || fallbackByRole[role];
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
      content: fallbackByRole[role],
      model: "fallback",
      promptTokens: 0,
      completionTokens: 0,
    };
  }
};
