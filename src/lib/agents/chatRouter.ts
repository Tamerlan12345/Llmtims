export type ChatAgentRole = string;
export type ChatTargetRole = string;

interface RoleRoutingCandidate {
  role: string;
  label: string;
  description: string;
  tokens: Set<string>;
}

interface PickResponderRoleOptions {
  officeId?: string | null;
  roleDescriptions?: Record<string, string>;
  roleCatalog?: RoleRoutingCandidate[];
}

export interface RouteChatIntentOptions {
  availableRoles?: string[];
  coordinatorRole?: string | null;
  rosterLabels?: Record<string, string>;
  roleDescriptions?: Record<string, string>;
  officeId?: string | null;
}

export interface RoutedChatIntent {
  responderRole: ChatAgentRole;
  coordinatorRole: string;
  targetRole: ChatTargetRole;
  broadcast: boolean;
  needsClarification: boolean;
}

const DEFAULT_AGENT_ROLE = "Coordinator";
const BROADCAST_MARKERS = ["@all", "all", "team", "everyone", "broadcast", "команда", "всем"];
const CLARIFICATION_MARKERS = ["do", "make", "fix", "start", "run", "help", "urgent", "сделай", "запусти"];
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
  "код",
  "инфра",
];
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "about",
  "your",
  "our",
  "you",
  "can",
  "please",
  "need",
  "make",
  "run",
  "есть",
  "как",
  "что",
  "для",
  "или",
  "это",
  "надо",
  "можно",
  "нужно",
  "сделай",
  "запусти",
  "пожалуйста",
  "мне",
]);

const normalizeRole = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeRoleList = (roles: Array<string | null | undefined>): string[] => {
  return Array.from(
    new Set(
      roles
        .map((role) => normalizeRole(role))
        .filter((role): role is string => Boolean(role))
    )
  );
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasToken = (text: string, token: string): boolean => {
  if (!token) return false;

  const normalizedToken = token.toLowerCase();
  if (normalizedToken.startsWith("@")) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(normalizedToken)}(?=$|\\s|[,:;.!?])`, "i");
    return pattern.test(text);
  }

  if (normalizedToken.includes(" ")) {
    return text.includes(normalizedToken);
  }

  const pattern = new RegExp(`\\b${escapeRegExp(normalizedToken)}\\b`, "i");
  return pattern.test(text);
};

const tokenize = (value: string): string[] => {
  const normalized = value
    .toLowerCase()
    .replace(/[^0-9a-zа-яё@\s-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
};

const tokenSet = (value: string): Set<string> => new Set(tokenize(value));

const compactHandle = (value: string): string => value.toLowerCase().replace(/\s+/g, "");

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

const scoreCandidate = (
  loweredMessage: string,
  messageTokens: Set<string>,
  candidate: RoleRoutingCandidate
): number => {
  const candidateHandles = [
    candidate.role.toLowerCase(),
    candidate.label.toLowerCase(),
    compactHandle(candidate.role),
    compactHandle(candidate.label),
  ];

  let score = 0;
  for (const handle of candidateHandles) {
    if (!handle) continue;
    if (hasToken(loweredMessage, handle)) score += 6;
    if (hasToken(loweredMessage, `@${handle}`)) score += 8;
  }

  if (candidate.description && loweredMessage.includes(candidate.description.toLowerCase().slice(0, 24))) {
    score += 2;
  }

  let overlap = 0;
  let fuzzyOverlap = 0;
  for (const token of Array.from(messageTokens)) {
    if (candidate.tokens.has(token)) {
      overlap += 1;
      continue;
    }

    if (token.length < 4) continue;
    for (const candidateToken of Array.from(candidate.tokens)) {
      if (candidateToken.length < 4) continue;
      if (candidateToken.startsWith(token) || token.startsWith(candidateToken)) {
        fuzzyOverlap += 1;
        break;
      }
    }
  }
  score += overlap * 2;
  score += fuzzyOverlap;

  if (candidate.tokens.size > 0) {
    score += (overlap + fuzzyOverlap * 0.5) / candidate.tokens.size;
  }

  return score;
};

const findRoleByMention = (
  message: string,
  candidates: RoleRoutingCandidate[]
): string | null => {
  const lowered = message.toLowerCase();

  for (const candidate of candidates) {
    const handles = [
      `@${compactHandle(candidate.role)}`,
      `@${compactHandle(candidate.label)}`,
      candidate.role.toLowerCase(),
      candidate.label.toLowerCase(),
    ];
    if (handles.some((handle) => hasToken(lowered, handle))) {
      return candidate.role;
    }
  }

  return null;
};

const buildRoleCandidates = (
  availableRoles: string[],
  rosterLabels: Record<string, string>,
  roleDescriptions: Record<string, string>,
  catalog: RoleRoutingCandidate[] = [],
  fallbackRole?: string
): RoleRoutingCandidate[] => {
  const byRole = new Map<string, RoleRoutingCandidate>();

  for (const candidate of catalog) {
    byRole.set(candidate.role, candidate);
  }

  for (const role of availableRoles) {
    const label = normalizeRole(rosterLabels[role]) ?? role;
    const description = normalizeRole(roleDescriptions[role]) ?? byRole.get(role)?.description ?? "";
    byRole.set(role, {
      role,
      label,
      description,
      tokens: tokenSet([role, label, description].join(" ")),
    });
  }

  const resolvedFallback = normalizeRole(fallbackRole);
  if (resolvedFallback && !byRole.has(resolvedFallback)) {
    byRole.set(resolvedFallback, {
      role: resolvedFallback,
      label: normalizeRole(rosterLabels[resolvedFallback]) ?? resolvedFallback,
      description: normalizeRole(roleDescriptions[resolvedFallback]) ?? "",
      tokens: tokenSet(
        [
          resolvedFallback,
          normalizeRole(rosterLabels[resolvedFallback]) ?? resolvedFallback,
          normalizeRole(roleDescriptions[resolvedFallback]) ?? "",
        ].join(" ")
      ),
    });
  }

  return Array.from(byRole.values());
};

const loadOfficeRoleCatalog = async (officeId?: string | null): Promise<RoleRoutingCandidate[]> => {
  const normalizedOfficeId = normalizeRole(officeId);
  if (!normalizedOfficeId) return [];

  try {
    const { isServerSupabaseConfigured, supabaseServer } = await import("../supabase/server");
    if (!isServerSupabaseConfigured) return [];

    const { data, error } = await supabaseServer
      .from("agents")
      .select("role, name, role_md, metadata")
      .eq("office_id", normalizedOfficeId);

    if (error || !Array.isArray(data)) return [];

    const byRole = new Map<string, RoleRoutingCandidate>();
    for (const row of data as Array<Record<string, unknown>>) {
      const role = normalizeRole(row.role);
      if (!role) continue;

      const metadata =
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      const label = normalizeRole(row.name) ?? role;
      const roleMarkdown = normalizeRole(row.role_md) ?? "";
      const metadataDescription = normalizeRole(
        metadata.role_description ?? metadata.roleDescription ?? metadata.action_description
      );
      const description = metadataDescription ?? roleMarkdown;

      byRole.set(role, {
        role,
        label,
        description,
        tokens: tokenSet([role, label, description].join(" ")),
      });
    }

    return Array.from(byRole.values());
  } catch {
    return [];
  }
};

const mergeRoleDescriptions = (
  provided: Record<string, string> | undefined,
  fromCatalog: RoleRoutingCandidate[]
): Record<string, string> => {
  const result: Record<string, string> = { ...(provided ?? {}) };
  for (const candidate of fromCatalog) {
    if (!result[candidate.role] && candidate.description) {
      result[candidate.role] = candidate.description;
    }
  }
  return result;
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
    availableRoles.find((role) => compactHandle(role) === compactHandle(normalizedInput));
  if (matched) return matched;

  return coordinatorRole ?? normalizedInput;
};

export const pickResponderRole = async (
  message: string,
  fallbackRole?: ChatAgentRole,
  availableRoles: string[] = [],
  rosterLabels: Record<string, string> = {},
  options: PickResponderRoleOptions = {}
): Promise<ChatAgentRole> => {
  const normalizedRoles = normalizeRoleList(availableRoles);
  const officeCatalog =
    Array.isArray(options.roleCatalog) && options.roleCatalog.length > 0
      ? options.roleCatalog
      : await loadOfficeRoleCatalog(options.officeId);
  const safeFallback =
    normalizeRole(fallbackRole) ??
    normalizedRoles[0] ??
    officeCatalog[0]?.role ??
    DEFAULT_AGENT_ROLE;
  const roleDescriptions = mergeRoleDescriptions(options.roleDescriptions, officeCatalog);
  const candidates = buildRoleCandidates(
    normalizedRoles,
    rosterLabels,
    roleDescriptions,
    officeCatalog,
    safeFallback
  );

  const mentionedRole = findRoleByMention(message, candidates);
  if (mentionedRole) return mentionedRole;

  const loweredMessage = String(message ?? "").toLowerCase();
  const messageTokens = tokenSet(loweredMessage);
  if (messageTokens.size === 0) {
    return safeFallback;
  }

  const best = candidates
    .map((candidate) => ({
      role: candidate.role,
      score: scoreCandidate(loweredMessage, messageTokens, candidate),
    }))
    .sort((left, right) => right.score - left.score)[0];

  return best && best.score > 0 ? best.role : safeFallback;
};

export const routeChatIntent = async (
  message: string,
  explicitTarget?: string,
  options: RouteChatIntentOptions = {}
): Promise<RoutedChatIntent> => {
  const officeCatalog = await loadOfficeRoleCatalog(options.officeId);
  const availableRoles = normalizeRoleList(
    (options.availableRoles ?? []).length > 0
      ? options.availableRoles
      : officeCatalog.map((candidate) => candidate.role)
  );
  const coordinatorRole =
    normalizeRole(options.coordinatorRole) ??
    availableRoles[0] ??
    officeCatalog[0]?.role ??
    DEFAULT_AGENT_ROLE;
  const rosterLabels = options.rosterLabels ?? {};
  const roleDescriptions = mergeRoleDescriptions(options.roleDescriptions, officeCatalog);
  const normalizedTarget = normalizeTargetRole(explicitTarget, availableRoles, coordinatorRole);
  const candidates = buildRoleCandidates(
    availableRoles,
    rosterLabels,
    roleDescriptions,
    officeCatalog,
    coordinatorRole
  );
  const broadcast = normalizedTarget === "All" || detectBroadcast(message);
  const targetRole =
    normalizedTarget !== "Auto"
      ? normalizedTarget
      : findRoleByMention(message, candidates) ?? (broadcast ? "All" : "Auto");
  const responderRole =
    targetRole === "All" || targetRole === "Auto"
      ? await pickResponderRole(message, coordinatorRole, availableRoles, rosterLabels, {
          officeId: options.officeId,
          roleDescriptions,
          roleCatalog: candidates,
        })
      : targetRole;

  return {
    responderRole,
    coordinatorRole,
    targetRole,
    broadcast,
    needsClarification: detectNeedsClarification(message),
  };
};
