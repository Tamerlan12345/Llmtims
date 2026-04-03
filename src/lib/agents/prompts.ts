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

export const CONTENT_CREATOR_DIRECTIVE = `
ПРАВИЛА ФОРМАТИРОВАНИЯ КОНТЕНТА:
1. НИКАКИХ ПРЕЛЮДИЙ. Не пиши "Создаю пост", "Вот ваш текст", "Конечно" и подобные вводные фразы.
2. СТРОГАЯ СТРУКТУРА. Если пользователь просит пост, caption или текст для соцсетей, ответ должен состоять только из блоков:
   **Пост:**
   **Хэштеги:**
   **Визуал (Арт-дирекшн):**
3. ЗАПРЕТ НА КОД. Никогда не пиши JSON, tool_code, системные команды или псевдо-вызовы инструмента обычным текстом.
4. Если пользователь не просил реальную генерацию изображения, дай только текстовое описание в блоке "Визуал (Арт-дирекшн)".
5. Если пользователь явно просит изображение и инструмент доступен, используй реальный tool call. Не описывай вызов инструмента текстом.
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
}

const normalizeRoleMarkdown = (roleMarkdown?: string | null): string => {
  const normalized = typeof roleMarkdown === "string" ? roleMarkdown.trim() : "";
  return normalized.length > 0 ? normalized : "";
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

export const buildEphemeralMediaDirective = ({
  hasImageGenerator,
  delegateTargetRole,
  delegateTargetName,
}: MediaDirectiveOptions): string => {
  if (hasImageGenerator) {
    return [
      "[SYSTEM] MEDIA CONTRACT",
      "Пользователь запросил медиа.",
      "Ты ОБЯЗАН в этом же ходе вызвать инструмент image_generator.",
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
      "У тебя нет инструмента image_generator.",
      `Ты ОБЯЗАН в этом же ходе вызвать delegate_task и передать задачу агенту ${delegateTarget}.`,
      "В instruction передай готовое текстовое описание визуала для генерации изображения.",
      "Нельзя писать псевдо-вызов инструмента текстом.",
    ].join("\n");
  }

  return [
    "[SYSTEM] MEDIA CONTRACT",
    "Пользователь запросил медиа, но image_generator недоступен в этой команде.",
    "Скажи об этом явно и кратко.",
    "Не пиши JSON, tool_code и псевдо-вызовы инструмента.",
  ].join("\n");
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

  if (roleSpecificPrompt) {
    return `${roleSpecificPrompt}${contentDirective}\n\n${AUTONOMY_DIRECTIVE}\n\n${TEAM_RULES}`;
  }

  return (
    `You are ${roleName} inside Digital Pixel Office. ` +
    "Stay inside your role scope, make reasonable assumptions, and produce artifacts the next role or human can inspect.\n" +
    (contentDirective ? `${contentDirective}\n` : "") +
    AUTONOMY_DIRECTIVE +
    "\n" +
    TEAM_RULES
  );
};
