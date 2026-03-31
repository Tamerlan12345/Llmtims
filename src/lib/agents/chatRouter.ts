export type ChatAgentRole = string;
export type ChatTargetRole = string;

export interface RouteChatIntentOptions {
  availableRoles?: string[];
  coordinatorRole?: string | null;
  rosterLabels?: Record<string, string>;
}

export interface RoutedChatIntent {
  responderRole: ChatAgentRole;
  coordinatorRole: string;
  targetRole: ChatTargetRole;
  broadcast: boolean;
  needsClarification: boolean;
}

const DEFAULT_COMPAT_ROLES = ["PM", "Developer", "QA", "DevOps"];
const BROADCAST_MARKERS = ["@all", "all", "team", "everyone", "broadcast"];
const CLARIFICATION_MARKERS = ["do", "make", "fix", "start", "run", "help", "urgent"];
const TECHNICAL_CONTEXT_MARKERS = [
  "mcp",
  "railway",
  "github",
  "sandbox",
  "deploy",
  "docker",
  "api",
  "sql",
  "auth",
];
const ROLE_HINTS: Array<{ role: string; markers: string[] }> = [
  {
    role: "DevOps",
    markers: ["deploy", "deployment", "infra", "ci", "cd", "release", "k8s", "docker", "railway", "logs"],
  },
  {
    role: "QA",
    markers: ["test", "tests", "testing", "qa", "regression", "validate", "verification", "bug reproduction"],
  },
  {
    role: "Developer",
    markers: ["refactor", "api", "handler", "implement", "code", "feature", "bug", "fix", "service"],
  },
  {
    role: "PM",
    markers: ["plan", "priorities", "roadmap", "scope", "backlog", "sprint", "stakeholder"],
  },
];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasToken = (text: string, token: string): boolean => {
  if (token.startsWith("@")) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(token)}(?=$|\\s|[,:;.!?])`, "i");
    return pattern.test(text);
  }

  if (token.includes(" ")) {
    return text.includes(token.toLowerCase());
  }

  const pattern = new RegExp(`\\b${escapeRegExp(token)}\\b`, "i");
  return pattern.test(text);
};

const normalizeRole = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const findRoleByMention = (
  message: string,
  availableRoles: string[],
  rosterLabels: Record<string, string>
): string | null => {
  const lowered = message.toLowerCase();

  for (const role of availableRoles) {
    const normalizedRole = role.toLowerCase();
    const roleLabel = String(rosterLabels[role] ?? role).toLowerCase();
    const candidates = [
      `@${normalizedRole.replace(/\s+/g, "")}`,
      normalizedRole,
      roleLabel,
      `@${roleLabel.replace(/\s+/g, "")}`,
    ];

    if (candidates.some((candidate) => hasToken(lowered, candidate))) {
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
  if (text.includes("?")) return false;
  if (TECHNICAL_CONTEXT_MARKERS.some((marker) => hasToken(text, marker))) return false;

  const words = text.split(/\s+/).filter(Boolean).length;
  return words <= 3 && CLARIFICATION_MARKERS.some((marker) => hasToken(text, marker));
};

export const roleLabel = (role: ChatAgentRole): string => {
  return role || "Agent";
};

export const roleLabelRu = (role: ChatAgentRole): string => {
  return role || "Agent";
};

export const normalizeTargetRole = (
  input?: string,
  availableRoles: string[] = [],
  coordinatorRole?: string | null
): ChatTargetRole => {
  const normalizedInput = normalizeRole(input);
  if (!normalizedInput) return "Auto";

  if (normalizedInput.toLowerCase() === "all") return "All";
  if (normalizedInput.toLowerCase() === "auto") return "Auto";

  const matched =
    availableRoles.find((role) => role.toLowerCase() === normalizedInput.toLowerCase()) ??
    availableRoles.find((role) => role.toLowerCase().replace(/\s+/g, "") === normalizedInput.toLowerCase());
  if (matched) return matched;

  return coordinatorRole ?? normalizedInput;
};

export const pickResponderRole = (
  message: string,
  fallbackRole?: ChatAgentRole,
  availableRoles: string[] = DEFAULT_COMPAT_ROLES,
  rosterLabels: Record<string, string> = {}
): ChatAgentRole => {
  const normalizedRoles = Array.from(
    new Set(
      (availableRoles.length > 0 ? availableRoles : DEFAULT_COMPAT_ROLES)
        .map((role) => normalizeRole(role))
        .filter((role): role is string => Boolean(role))
    )
  );
  const safeFallback = normalizeRole(fallbackRole) ?? normalizedRoles[0] ?? "PM";
  const mentionedRole = findRoleByMention(message, normalizedRoles, rosterLabels);
  if (mentionedRole) return mentionedRole;

  const normalizedMessage = message.toLowerCase();
  for (const hint of ROLE_HINTS) {
    if (!hint.markers.some((marker) => hasToken(normalizedMessage, marker))) {
      continue;
    }

    const matchedHintRole = normalizedRoles.find(
      (role) => role.toLowerCase() === hint.role.toLowerCase()
    );
    if (matchedHintRole) {
      return matchedHintRole;
    }
  }

  const scored = normalizedRoles.map((role) => {
    const label = String(rosterLabels[role] ?? role).toLowerCase();
    const score = [role.toLowerCase(), label]
      .filter(Boolean)
      .reduce((total, token) => total + (normalizedMessage.includes(token) ? 1 : 0), 0);
    return { role, score };
  });

  const best = scored.sort((left, right) => right.score - left.score)[0];
  return best && best.score > 0 ? best.role : safeFallback;
};

export const routeChatIntent = (
  message: string,
  explicitTarget?: string,
  options: RouteChatIntentOptions = {}
): RoutedChatIntent => {
  const availableRoles = Array.from(
    new Set(
      ((options.availableRoles ?? []).length > 0 ? options.availableRoles : DEFAULT_COMPAT_ROLES)
        .map((role) => normalizeRole(role))
        .filter((role): role is string => Boolean(role))
    )
  );
  const coordinatorRole =
    normalizeRole(options.coordinatorRole) ?? availableRoles[0] ?? "PM";
  const rosterLabels = options.rosterLabels ?? {};
  const normalizedTarget = normalizeTargetRole(explicitTarget, availableRoles, coordinatorRole);
  const broadcast = normalizedTarget === "All" || detectBroadcast(message);
  const targetRole =
    normalizedTarget !== "Auto"
      ? normalizedTarget
      : findRoleByMention(message, availableRoles, rosterLabels) ?? (broadcast ? "All" : "Auto");
  const responderRole =
    targetRole === "All" || targetRole === "Auto"
      ? pickResponderRole(message, coordinatorRole, availableRoles, rosterLabels)
      : targetRole;

  return {
    responderRole,
    coordinatorRole,
    targetRole,
    broadcast,
    needsClarification: detectNeedsClarification(message),
  };
};
