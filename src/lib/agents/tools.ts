import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { DynamicTool } from "@langchain/core/tools";
import { BaseMessage } from "@langchain/core/messages";
import { loadServerEnv } from "@/lib/config/serverEnv";

loadServerEnv();

// 2. GitHub MCP Tool (Stub for actual MCP integration)
export const githubTool = new DynamicTool({
  name: "github_mcp",
  description: "Manage GitHub repositories, branches, and PRs.",
  func: async (input: string) => {
    console.log("GitHub MCP Action:", input);
    // In a real scenario, this would call the MCP server
    return `Successfully performed GitHub action: ${input}`;
  },
});

// 3. Railway MCP Tool (Stub)
export const railwayTool = new DynamicTool({
  name: "railway_mcp",
  description: "Manage Railway deployments and view logs.",
  func: async (input: string) => {
    console.log("Railway MCP Action:", input);
    return `Successfully performed Railway action: ${input}`;
  },
});

// 4. Sandbox Tool (Stub)
export const sandboxTool = new DynamicTool({
  name: "sandbox_execution",
  description: "Execute code in an isolated Docker sandbox.",
  func: async (input: string) => {
    console.log("Sandbox Execution:", input);
    return `Execution result: Success (Mock)`;
  },
});

export const tools = [githubTool, railwayTool, sandboxTool];
const geminiApiKey = process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL ?? "gemini-2.0-flash";
export const isLlmConfigured = Boolean(geminiApiKey);
let llmInstance: ReturnType<ChatGoogleGenerativeAI["bindTools"]> | ChatGoogleGenerativeAI | null = null;

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

  llmInstance = typeof model.bindTools === "function" ? model.bindTools(tools) : model;
  return llmInstance;
};

export interface AgentInvocationResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
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

export const invokeAgentModel = async (
  role: keyof typeof fallbackByRole,
  messages: BaseMessage[]
): Promise<AgentInvocationResult> => {
  const llm = getLlm();
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
    const usage = (response as any).usage_metadata ?? {};
    const content = normalizeContent((response as any).content) || fallbackByRole[role];

    return {
      content,
      model: (response as any).response_metadata?.model_name ?? geminiModel,
      promptTokens: Number(usage.input_tokens ?? 0),
      completionTokens: Number(usage.output_tokens ?? 0),
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
