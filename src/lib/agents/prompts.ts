export const TEAM_RULES = `
Pixel Office CIC team rules:
1) Follow the active coordinator and task context.
2) You may produce drafts, plans, code suggestions, copy, and internal deliverables immediately, but do not claim external execution or deployment unless it actually happened.
3) Do not claim execution/deploy unless it actually happened.
4) Keep answers concise, formal, and action-oriented.
5) If blocked, state blockers and required inputs explicitly.
6) Respect runtime permissions and MCP environment boundaries.
`;

export const AUTONOMY_DIRECTIVE = `
IMPORTANT AUTONOMY RULE:
You are an autonomous professional, not a passive consultant.
Do not ask the user clarifying questions unless the user explicitly asks for questions, analysis options, or the task is truly impossible without one critical parameter.
If information is missing, make reasonable professional assumptions and immediately produce the best possible draft or result.
State assumptions briefly and move the work forward.
Motto: first do, then discuss.
`;

export const TOOL_CALLING_DIRECTIVE = `
ВАЖНОЕ ПРАВИЛО ИСПОЛЬЗОВАНИЯ ИНСТРУМЕНТОВ (TOOLS):
Тебе КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО писать JSON, tool_code, псевдо-вызовы или текст вида "я вызываю инструмент" в обычном ответе.
Если для результата нужен инструмент, используй только нативный tool calling.
Если локально нужного инструмента нет, используй capability map команды и вызови delegate_task на агента, у которого инструмент реально есть.
Capability map команды — единственный источник истины для того, какие инструменты реально доступны агентам.
`;

export const CONTENT_CREATOR_DIRECTIVE = `
ПРАВИЛА ФОРМАТИРОВАНИЯ КОНТЕНТА:
1. НИКАКИХ ПРЕЛЮДИЙ. Не пиши "Создаю пост", "Вот ваш текст", "Конечно" и подобные вводные фразы.
2. СТРОГАЯ СТРУКТУРА. Если пользователь просит пост, caption или текст для соцсетей, ответ должен состоять только из блоков:
   **Пост:**
   **Хэштеги:**
   **Визуал (Арт-дирекшн):**
3. ЗАПРЕТ НА КОД. Никогда не пиши JSON, tool_code, системные команды или псевдо-вызовы инструмента обычным текстом.
4. Если пользователь не просил реальную генерацию изображения или видео, дай только текстовое описание в блоке "Визуал (Арт-дирекшн)".
5. Если пользователь явно просит изображение или видео и инструмент доступен, используй реальный tool call. Не описывай вызов инструмента текстом.
6. ОФОРМЛЕНИЕ ДОЛЖНО БЫТЬ ЧИСТЫМ. Между блоками делай ровные пустые строки. Не пиши экранированные символы вроде \\n или \\t.
7. БЛОК "ВИЗУАЛ" ПИШИ КАК СИЛЬНЫЙ ART DIRECTION BRIEF: главный сюжет, композиция, среда, свет, палитра, фактуры, культурные/брендовые маркеры, настроение, негативные ограничения.
8. ХЭШТЕГИ ПИШИ ОТДЕЛЬНОЙ АККУРАТНОЙ СТРОКОЙ ИЛИ 2 КОРОТКИМИ СТРОКАМИ БЕЗ ЛИШНЕГО ТЕКСТА.
`;

export const PM_GSD_DIRECTIVE = `
PROJECT MANAGER RULE:
If the task is complex, call plan_gsd_project first to create the roadmap and only then call delegate_task for the first executor.
You are responsible for planning and orchestration, not for doing specialist execution yourself.
`;

const CONTENT_ROLE_MARKERS = [
  "смм",
  "smm",
  "копирайтер",
  "copywriter",
  "marketing",
  "маркет",
  "content",
  "контент",
  "brand",
  "social",
  "pr",
];

const MEDIA_INTENT_MARKERS = [
  "картинк",
  "изображен",
  "нарисуй",
  "сгенерируй",
  "иллюстрац",
  "баннер",
  "постер",
  "обложк",
  "визуал",
];

const VIDEO_INTENT_MARKERS = [
  "видео",
  "ролик",
  "reel",
  "рилс",
  "shorts",
  "шортс",
  "анимац",
  "veo",
  "clip",
  "клип",
];

const CONTENT_SECTION_MARKERS = [
  "**Пост:**",
  "Пост:",
  "**Хэштеги:**",
  "Хэштеги:",
  "**Визуал (Арт-дирекшн):**",
  "Визуал (Арт-дирекшн):",
  "**Визуал:**",
  "Визуал:",
];

const CONTENT_PRELUDE_LINE_PATTERN =
  /^(созда[юе]|подготовл[юя]|вот\s|конечно|готов[оа]?|сделаю|делаю|приступаю|начинаю|ниже|текст поста|изображение для поста)/i;
const TOOLISH_JSON_BLOCK_PATTERNS = [
  /(?:^|\n)\s*\{[\s\S]*?"skill"\s*:\s*"[^"]+"[\s\S]*?\}\s*(?=\n|$)/gi,
  /(?:^|\n)\s*\{[\s\S]*?"tool"\s*:\s*"[^"]+"[\s\S]*?\}\s*(?=\n|$)/gi,
  /(?:^|\n)\s*\{[\s\S]*?"function"\s*:\s*\{[\s\S]*?\}\s*(?=\n|$)/gi,
];

export interface ContentRoleContext {
  role?: string | null;
  name?: string | null;
  roleMarkdown?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MediaDirectiveOptions {
  hasImageGenerator: boolean;
  delegateTargetRole?: string | null;
  delegateTargetName?: string | null;
  toolName?: string | null;
}

export interface TeamCapabilityEntry {
  role: string;
  name?: string | null;
  tools: string[];
}

const normalizeRoleMarkdown = (roleMarkdown?: string | null): string => {
  const normalized = typeof roleMarkdown === "string" ? roleMarkdown.trim() : "";
  return normalized.length > 0 ? normalized : "";
};

const isPmRole = (role?: string | null): boolean => {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  return (
    normalized.includes("pm") ||
    normalized.includes("project manager") ||
    normalized.includes("manager") ||
    normalized.includes("ceo")
  );
};

const toMetadataText = (metadata?: Record<string, unknown> | null): string => {
  if (!metadata || typeof metadata !== "object") return "";

  return Object.entries(metadata)
    .map(([key, value]) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return `${key} ${String(value)}`;
      }
      return key;
    })
    .join(" ");
};

export const isContentCreatorContext = (context: ContentRoleContext = {}): boolean => {
  const haystack = [
    context.role,
    context.name,
    context.roleMarkdown,
    toMetadataText(context.metadata),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  return CONTENT_ROLE_MARKERS.some((marker) => haystack.includes(marker));
};

export const detectMediaIntent = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return MEDIA_INTENT_MARKERS.some((marker) => normalized.includes(marker));
};

export const detectVideoIntent = (value: string): boolean => {
  const normalized = value.toLowerCase();
  return VIDEO_INTENT_MARKERS.some((marker) => normalized.includes(marker));
};

export const buildTeamCapabilityMap = (entries: TeamCapabilityEntry[]): string => {
  const segments = entries
    .map((entry) => {
      const label = entry.name?.trim() ? `${entry.name.trim()} (${entry.role})` : entry.role;
      const tools = entry.tools.length > 0 ? entry.tools.join(", ") : "none";
      return `${label} [${tools}]`;
    })
    .join(", ");

  return `Team capability map: ${segments || "none"}.`;
};

export const buildEphemeralMediaDirective = ({
  hasImageGenerator,
  delegateTargetRole,
  delegateTargetName,
  toolName,
}: MediaDirectiveOptions): string => {
  const effectiveToolName = typeof toolName === "string" && toolName.trim().length > 0
    ? toolName.trim()
    : "image_generator";
  if (hasImageGenerator) {
    return [
      "[SYSTEM] MEDIA CONTRACT",
      "Пользователь запросил медиа.",
      `Ты ОБЯЗАН в этом же ходе вызвать инструмент ${effectiveToolName}.`,
      "Нельзя описывать вызов инструмента текстом, JSON или tool_code.",
      "После вызова инструмента включи в финальный ответ превью markdown и ссылку на скачивание.",
    ].join("\n");
  }

  if (delegateTargetRole) {
    const delegateTarget = delegateTargetName
      ? `${delegateTargetRole} (${delegateTargetName})`
      : delegateTargetRole;
    return [
      "[SYSTEM] MEDIA CONTRACT",
      "Пользователь запросил медиа.",
      `У тебя нет инструмента ${effectiveToolName}.`,
      `Ты ОБЯЗАН в этом же ходе вызвать delegate_task и передать задачу агенту ${delegateTarget}.`,
      "В instruction передай готовое текстовое описание визуала для генерации изображения.",
      "Нельзя писать псевдо-вызов инструмента текстом.",
    ].join("\n");
  }

  return [
    "[SYSTEM] MEDIA CONTRACT",
    `Пользователь запросил медиа, но ${effectiveToolName} недоступен в этой команде.`,
    "Скажи об этом явно и кратко.",
    "Не пиши JSON, tool_code и псевдо-вызовы инструмента.",
  ].join("\n");
};

export const buildMediaRetryCorrection = ({
  hasImageGenerator,
  delegateTargetRole,
  delegateTargetName,
  toolName,
}: MediaDirectiveOptions): string => {
  const effectiveToolName = typeof toolName === "string" && toolName.trim().length > 0
    ? toolName.trim()
    : "image_generator";
  if (hasImageGenerator) {
    return `[System_Error]: You attempted to generate media but did not use the native tool call. Please call the '${effectiveToolName}' tool properly.`;
  }

  if (delegateTargetRole) {
    const delegateTarget = delegateTargetName
      ? `${delegateTargetRole} (${delegateTargetName})`
      : delegateTargetRole;
    return `[System_Error]: Media generation failed because you did not call delegate_task correctly. Delegate this request to ${delegateTarget}, who has ${effectiveToolName}.`;
  }

  return `[System_Error]: Media generation is unavailable because no agent in the team has ${effectiveToolName}.`;
};

export const sanitizeVisibleAgentResponse = (
  content: string,
  options: {
    strictContentContract?: boolean;
  } = {}
): string => {
  let cleanContent = String(content ?? "");

  cleanContent = cleanContent.replace(/```(?:json|tool_code)?\s*[\s\S]*?```/gi, "").trim();
  for (const pattern of TOOLISH_JSON_BLOCK_PATTERNS) {
    cleanContent = cleanContent.replace(pattern, "\n").trim();
  }

  if (options.strictContentContract) {
    const firstSectionIndex = CONTENT_SECTION_MARKERS
      .map((marker) => cleanContent.indexOf(marker))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];

    if (typeof firstSectionIndex === "number" && firstSectionIndex > 0) {
      cleanContent = cleanContent.slice(firstSectionIndex).trim();
    } else {
      const lines = cleanContent.split(/\r?\n/);
      while (lines.length > 0) {
        const candidate = lines[0]?.trim() ?? "";
        if (!candidate) {
          lines.shift();
          continue;
        }
        if (CONTENT_PRELUDE_LINE_PATTERN.test(candidate)) {
          lines.shift();
          continue;
        }
        break;
      }
      cleanContent = lines.join("\n").trim();
    }
  }

  return cleanContent.replace(/\n{3,}/g, "\n\n").trim();
};
export const getAgentPrompt = (
  role: string,
  roleMarkdown?: string | null,
  context: ContentRoleContext = {}
): string => {
  const roleName = typeof role === "string" && role.trim().length > 0 ? role.trim() : "Agent";
  const roleSpecificPrompt = normalizeRoleMarkdown(roleMarkdown);
  const contentDirective = isContentCreatorContext({
    role,
    name: context.name ?? null,
    roleMarkdown: roleSpecificPrompt || context.roleMarkdown || null,
    metadata: context.metadata ?? null,
  })
    ? `\n\n${CONTENT_CREATOR_DIRECTIVE}`
    : "";
  const pmDirective = isPmRole(roleName) ? `\n\n${PM_GSD_DIRECTIVE}` : "";

  if (roleSpecificPrompt) {
    return `${roleSpecificPrompt}${contentDirective}${pmDirective}\n\n${TOOL_CALLING_DIRECTIVE}\n\n${AUTONOMY_DIRECTIVE}\n\n${TEAM_RULES}`;
  }

  return (
    `You are ${roleName} inside Digital Pixel Office. ` +
    "Stay inside your role scope, make reasonable assumptions, and produce artifacts the next role or human can inspect.\n" +
    (contentDirective ? `${contentDirective}\n` : "") +
    (pmDirective ? `${pmDirective}\n` : "") +
    TOOL_CALLING_DIRECTIVE +
    "\n" +
    AUTONOMY_DIRECTIVE +
    "\n" +
    TEAM_RULES
  );
};
