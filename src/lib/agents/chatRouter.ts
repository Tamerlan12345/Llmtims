export type ChatAgentRole = "PM" | "Developer" | "QA" | "DevOps";
export type ChatTargetRole = ChatAgentRole | "All" | "Auto";

export interface RoutedChatIntent {
  responderRole: ChatAgentRole;
  coordinatorRole: "PM";
  targetRole: ChatTargetRole;
  broadcast: boolean;
  needsClarification: boolean;
}

const ROLE_KEYWORDS: Record<ChatAgentRole, string[]> = {
  PM: [
    "план",
    "спринт",
    "приоритет",
    "roadmap",
    "strategy",
    "scope",
    "декомпоз",
    "срок",
    "дедлайн",
  ],
  Developer: [
    "код",
    "api",
    "endpoint",
    "bug",
    "feature",
    "frontend",
    "backend",
    "рефактор",
    "база",
    "sql",
    "typescript",
    "react",
  ],
  QA: [
    "qa",
    "test",
    "testing",
    "regression",
    "тест",
    "проверь",
    "регресс",
    "валидац",
    "чеклист",
    "quality",
    "edge case",
  ],
  DevOps: [
    "devops",
    "deploy",
    "деплой",
    "ci",
    "cd",
    "infra",
    "сервер",
    "docker",
    "railway",
    "лог",
    "monitor",
    "build",
    "mcp",
    "github",
    "sandbox",
    "контейнер",
  ],
};

const ROLE_MARKERS: Record<ChatAgentRole, string[]> = {
  PM: ["@pm", "@айгерім", "@айгерим", "pm", "manager", "менеджер", "проект"],
  Developer: [
    "@dev",
    "@developer",
    "@алексей",
    "dev",
    "developer",
    "разработчик",
  ],
  QA: ["@qa", "@алуа", "qa", "тестировщик", "quality"],
  DevOps: ["@ops", "@devops", "@илья", "ops", "devops", "инфра", "деплойер"],
};

const BROADCAST_MARKERS = ["@all", "всем", "команде", "all", "общая задача", "для всех"];
const CLARIFICATION_MARKERS = ["сделай", "помоги", "почини", "надо", "реши", "быстро", "срочно"];
const GREETING_MARKERS = ["привет", "здравствуйте", "добрый день", "добрый вечер", "hello", "hi"];

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const hasToken = (text: string, token: string): boolean => {
  if (token.startsWith("@")) {
    const escaped = escapeRegExp(token);
    const pattern = new RegExp(`(^|\\s)${escaped}(?=$|\\s|[,:;.!?])`);
    return pattern.test(text);
  }

  if (token.includes(" ")) {
    return text.includes(token);
  }

  const escaped = escapeRegExp(token);
  const pattern = new RegExp(`\\b${escaped}\\b`);
  return pattern.test(text);
};

export const roleLabel = (role: ChatAgentRole): string => {
  if (role === "Developer") return "Developer";
  if (role === "DevOps") return "DevOps";
  return role;
};

export const roleLabelRu = (role: ChatAgentRole): string => {
  if (role === "Developer") return "Разработчик";
  if (role === "DevOps") return "DevOps";
  if (role === "QA") return "QA";
  return "PM";
};

export const normalizeTargetRole = (input?: string): ChatTargetRole => {
  if (!input) return "Auto";

  const value = input.trim().toLowerCase();
  if (value === "all" || value === "всем" || value === "команде") return "All";
  if (value === "pm") return "PM";
  if (value === "developer" || value === "dev" || value === "разработчик") return "Developer";
  if (value === "qa" || value === "тестировщик") return "QA";
  if (value === "devops" || value === "ops") return "DevOps";
  return "Auto";
};

const detectRoleMention = (message: string): ChatAgentRole | null => {
  const text = message.toLowerCase();

  for (const role of Object.keys(ROLE_MARKERS) as ChatAgentRole[]) {
    if (ROLE_MARKERS[role].some((marker) => hasToken(text, marker))) {
      return role;
    }
  }

  return null;
};

const detectBroadcast = (message: string): boolean => {
  const text = message.toLowerCase();
  return BROADCAST_MARKERS.some((marker) => text.includes(marker));
};

const detectNeedsClarification = (message: string): boolean => {
  const text = message.trim().toLowerCase();
  if (!text) return true;
  if (GREETING_MARKERS.some((marker) => text.includes(marker))) return false;

  const words = text.split(/\s+/).filter(Boolean).length;
  const hasActionOnly = CLARIFICATION_MARKERS.some((marker) => hasToken(text, marker));
  const hasQuestion = text.includes("?");

  if (hasQuestion) return false;
  return words <= 3 && hasActionOnly;
};

export const pickResponderRole = (
  message: string,
  fallbackRole: ChatAgentRole = "PM"
): ChatAgentRole => {
  const text = message.toLowerCase();
  let topRole = fallbackRole;
  let topScore = 0;

  for (const role of Object.keys(ROLE_KEYWORDS) as ChatAgentRole[]) {
    const score = ROLE_KEYWORDS[role].reduce((acc, token) => {
      return hasToken(text, token) ? acc + 1 : acc;
    }, 0);

    if (score > topScore) {
      topScore = score;
      topRole = role;
    }
  }

  return topRole;
};

export const routeChatIntent = (
  message: string,
  explicitTarget?: string
): RoutedChatIntent => {
  const normalizedTarget = normalizeTargetRole(explicitTarget);
  const mentionedRole = detectRoleMention(message);
  const broadcast = normalizedTarget === "All" || detectBroadcast(message);

  const targetRole: ChatTargetRole =
    normalizedTarget !== "Auto" ? normalizedTarget : mentionedRole ?? (broadcast ? "All" : "Auto");

  const predictedRole = pickResponderRole(message);
  const responderRole: ChatAgentRole =
    targetRole === "All" || targetRole === "Auto" ? predictedRole : targetRole;

  const needsClarification = detectNeedsClarification(message);

  return {
    responderRole,
    coordinatorRole: "PM",
    targetRole,
    broadcast,
    needsClarification,
  };
};
