import "server-only";
import { loadServerEnv } from "@/lib/config/serverEnv";

loadServerEnv();

export type RailwayAgentAction =
  | "status"
  | "create_service"
  | "deploy_service"
  | "set_variables"
  | "help";

type RailwayAuthMode = "bearer" | "project_access_token";

interface ParsedRailwayCommand {
  isRailwayCommand: boolean;
  action: RailwayAgentAction;
  requiresApproval: boolean;
  serviceName?: string;
  image?: string;
  environmentName?: string;
  variables: Record<string, string>;
  deployAfterVariables: boolean;
  summary: string;
}

interface RailwayServiceInfo {
  id: string;
  name: string;
}

interface RailwayEnvironmentInfo {
  id: string;
  name: string;
}

interface RailwayProjectInfo {
  id: string;
  name: string;
  services: RailwayServiceInfo[];
  environments: RailwayEnvironmentInfo[];
}

interface RailwayAuthCandidate {
  mode: RailwayAuthMode;
  token: string;
  source: string;
}

interface RailwayConnection {
  endpoint: string;
  projectId: string;
  candidate: RailwayAuthCandidate;
}

interface RailwayGqlResult<TData = Record<string, unknown>> {
  ok: boolean;
  data?: TData;
  error?: string;
}

export interface RailwayExecutionResult {
  handled: boolean;
  ok: boolean;
  requiresApproval: boolean;
  action: RailwayAgentAction;
  summary: string;
  details: string[];
}

const RAILWAY_ENDPOINT =
  process.env.RAILWAY_GRAPHQL_ENDPOINT?.trim() ||
  "https://backboard.railway.com/graphql/v2";

const MANAGED_SERVICE_PREFIX =
  process.env.RAILWAY_MANAGED_SERVICE_PREFIX?.trim().toLowerCase() || "task-";

const DEFAULT_IMAGE = process.env.RAILWAY_DEFAULT_IMAGE?.trim() || "nginx:alpine";

const RAILWAY_KEYWORDS = [
  "railway",
  "рейлвей",
  "контейнер",
  "container",
  "сервис",
  "service",
  "деплой",
  "deploy",
];

const STATUS_MARKERS = ["status", "статус", "list", "список", "покажи сервисы"];
const CREATE_MARKERS = [
  "create",
  "создай",
  "создать",
  "подними контейнер",
  "запусти контейнер",
  "new service",
];
const DEPLOY_MARKERS = ["deploy", "redeploy", "деплой", "разверни", "перезапусти"];
const VARIABLE_MARKERS = ["переменн", "variable", "env", "окружен"];
const HELP_MARKERS = ["help", "помощь", "как", "пример", "format", "формат"];

const normalizeText = (value: string) => value.trim().toLowerCase();

const hasAny = (text: string, markers: string[]) =>
  markers.some((marker) => text.includes(marker));

const cleanEnvValue = (value: string | undefined): string => {
  if (!value) return "";
  return value.trim().replace(/^["']|["']$/g, "");
};

const resolveProjectId = (): string => {
  return (
    cleanEnvValue(process.env.RAILWAY_PROJECT_ID) ||
    cleanEnvValue(process.env.RAILWAY_PROJECT) ||
    cleanEnvValue(process.env.RAILWAY_PROJECT_NAME)
  );
};

const normalizeServiceName = (value: string): string => {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 48);
};

const ensureManagedServiceName = (value: string): string => {
  const normalized = normalizeServiceName(value);
  if (!normalized) return `${MANAGED_SERVICE_PREFIX}${Date.now().toString(36)}`;
  if (normalized.startsWith(MANAGED_SERVICE_PREFIX)) return normalized;
  return `${MANAGED_SERVICE_PREFIX}${normalized}`;
};

const isManagedServiceName = (value: string): boolean => {
  return normalizeServiceName(value).startsWith(MANAGED_SERVICE_PREFIX);
};

const extractServiceName = (message: string): string | undefined => {
  const regexes = [
    /(?:service|сервис|container|контейнер)\s*(?:=|:)?\s*([a-z0-9][a-z0-9-]{2,63})/i,
    /(?:name|имя)\s*(?:=|:)\s*([a-z0-9][a-z0-9-]{2,63})/i,
  ];

  for (const pattern of regexes) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1];
  }

  return undefined;
};

const extractEnvironmentName = (message: string): string | undefined => {
  const match = message.match(
    /(?:env|environment|окружение)\s*(?:=|:)\s*([a-z0-9][a-z0-9-_]{1,63})/i
  );
  return match?.[1];
};

const extractImage = (message: string): string | undefined => {
  const explicit = message.match(
    /(?:image|образ)\s*(?:=|:)\s*([a-z0-9./:_-]{3,200})/i
  );
  if (explicit?.[1]) return explicit[1];

  const firstImageLike = message
    .split(/\s+/)
    .map((token) => token.trim())
    .find((token) => /[/:]/.test(token) && /^[a-z0-9./:_-]{3,200}$/i.test(token));
  return firstImageLike;
};

const extractVariables = (message: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const regex = /\b([A-Z][A-Z0-9_]{1,63})=([^\s,;]+)/g;
  let match = regex.exec(message);
  while (match) {
    const key = match[1];
    const value = match[2];
    result[key] = value;
    match = regex.exec(message);
  }
  return result;
};

export const parseRailwayCommand = (message: string): ParsedRailwayCommand | null => {
  const text = normalizeText(message);
  const isRailwayCommand = hasAny(text, RAILWAY_KEYWORDS);
  if (!isRailwayCommand) return null;

  const variables = extractVariables(message);
  const hasVariables = Object.keys(variables).length > 0;
  const serviceName = extractServiceName(message);
  const environmentName = extractEnvironmentName(message);
  const image = extractImage(message);
  const deployAfterVariables = hasAny(text, DEPLOY_MARKERS);

  if (hasAny(text, STATUS_MARKERS)) {
    return {
      isRailwayCommand: true,
      action: "status",
      requiresApproval: false,
      serviceName,
      environmentName,
      image,
      variables,
      deployAfterVariables,
      summary: "Запрос статуса Railway проекта.",
    };
  }

  if (hasVariables || hasAny(text, VARIABLE_MARKERS)) {
    return {
      isRailwayCommand: true,
      action: "set_variables",
      requiresApproval: true,
      serviceName,
      environmentName,
      image,
      variables,
      deployAfterVariables,
      summary: "Изменение переменных Railway сервиса.",
    };
  }

  if (hasAny(text, CREATE_MARKERS)) {
    return {
      isRailwayCommand: true,
      action: "create_service",
      requiresApproval: true,
      serviceName,
      environmentName,
      image,
      variables,
      deployAfterVariables: true,
      summary: "Создание нового Railway сервиса/контейнера.",
    };
  }

  if (hasAny(text, DEPLOY_MARKERS)) {
    return {
      isRailwayCommand: true,
      action: "deploy_service",
      requiresApproval: true,
      serviceName,
      environmentName,
      image,
      variables,
      deployAfterVariables: true,
      summary: "Запуск деплоя Railway сервиса.",
    };
  }

  if (hasAny(text, HELP_MARKERS)) {
    return {
      isRailwayCommand: true,
      action: "help",
      requiresApproval: false,
      serviceName,
      environmentName,
      image,
      variables,
      deployAfterVariables,
      summary: "Справка по командам Railway.",
    };
  }

  return null;
};

const buildRailwayHelpText = () => {
  return [
    "Поддерживаемые Railway-команды:",
    `1) Создать сервис: "Railway create service=<name> image=<image>"`,
    `2) Деплой сервиса: "Railway deploy service=<task-name>"`,
    `3) Переменные: "Railway env service=<task-name> KEY=VALUE [KEY2=VALUE2]"`,
    `4) Статус: "Railway status"`,
    `Политика безопасности: изменяем только сервисы с префиксом "${MANAGED_SERVICE_PREFIX}".`,
  ].join("\n");
};

const buildAuthCandidates = (): RailwayAuthCandidate[] => {
  const candidates: RailwayAuthCandidate[] = [];
  const apiToken = cleanEnvValue(process.env.RAILWAY_API_TOKEN);
  const apiKey = cleanEnvValue(process.env.RAILWAY_API_KEY);
  const projectToken = cleanEnvValue(process.env.RAILWAY_TOKEN);

  if (apiToken) candidates.push({ mode: "bearer", token: apiToken, source: "RAILWAY_API_TOKEN" });
  if (apiKey) candidates.push({ mode: "bearer", token: apiKey, source: "RAILWAY_API_KEY" });
  if (projectToken) {
    candidates.push({
      mode: "project_access_token",
      token: projectToken,
      source: "RAILWAY_TOKEN",
    });
    candidates.push({ mode: "bearer", token: projectToken, source: "RAILWAY_TOKEN" });
  }
  return candidates;
};

const buildHeaders = (candidate: RailwayAuthCandidate): Record<string, string> => {
  const baseHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (candidate.mode === "project_access_token") {
    baseHeaders["Project-Access-Token"] = candidate.token;
    return baseHeaders;
  }
  baseHeaders.Authorization = `Bearer ${candidate.token}`;
  return baseHeaders;
};

const railwayGraphql = async <TData = Record<string, unknown>>(
  candidate: RailwayAuthCandidate,
  query: string,
  variables?: Record<string, unknown>,
  timeoutMs = 10000
): Promise<RailwayGqlResult<TData>> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(RAILWAY_ENDPOINT, {
      method: "POST",
      headers: buildHeaders(candidate),
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: controller.signal,
    });

    const json = (await response.json().catch(() => null)) as
      | { data?: TData; errors?: Array<{ message?: string }> }
      | null;

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    if (json?.errors?.length) {
      return { ok: false, error: String(json.errors[0]?.message ?? "GraphQL error") };
    }

    return { ok: true, data: json?.data };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "network error";
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
};

const fetchProjectInfo = async (
  candidate: RailwayAuthCandidate,
  projectId: string
): Promise<RailwayGqlResult<{ project?: RailwayProjectInfo }>> => {
  return railwayGraphql<{ project?: RailwayProjectInfo }>(
    candidate,
    "query($id:String!){ project(id:$id){ id name environments{edges{node{id name}}} services{edges{node{id name}}} } }",
    { id: projectId }
  ).then((result) => {
    if (!result.ok || !result.data?.project) return result;
    const raw = result.data.project as unknown as {
      id: string;
      name: string;
      environments?: { edges?: Array<{ node?: RailwayEnvironmentInfo }> };
      services?: { edges?: Array<{ node?: RailwayServiceInfo }> };
    };
    const project: RailwayProjectInfo = {
      id: raw.id,
      name: raw.name,
      environments: (raw.environments?.edges ?? [])
        .map((edge) => edge.node)
        .filter((node): node is RailwayEnvironmentInfo => Boolean(node?.id && node?.name)),
      services: (raw.services?.edges ?? [])
        .map((edge) => edge.node)
        .filter((node): node is RailwayServiceInfo => Boolean(node?.id && node?.name)),
    };
    return { ok: true, data: { project } };
  });
};

const resolveConnection = async (): Promise<
  | { ok: true; connection: RailwayConnection; project: RailwayProjectInfo }
  | { ok: false; error: string; details: string[] }
> => {
  const projectId = resolveProjectId();
  if (!projectId) {
    return {
      ok: false,
      error: "RAILWAY_PROJECT_ID не задан.",
      details: ["Добавьте RAILWAY_PROJECT_ID в ENV и перезапустите сервис."],
    };
  }

  const candidates = buildAuthCandidates();
  if (candidates.length === 0) {
    return {
      ok: false,
      error: "Railway token не найден.",
      details: ["Нужен RAILWAY_API_KEY/RAILWAY_API_TOKEN или RAILWAY_TOKEN."],
    };
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    const projectProbe = await fetchProjectInfo(candidate, projectId);
    if (projectProbe.ok && projectProbe.data?.project) {
      return {
        ok: true,
        connection: { endpoint: RAILWAY_ENDPOINT, projectId, candidate },
        project: projectProbe.data.project,
      };
    }
    failures.push(`${candidate.source} (${candidate.mode}): ${projectProbe.error ?? "unknown error"}`);
  }

  return {
    ok: false,
    error: "Не удалось подтвердить доступ к Railway project scope.",
    details: failures,
  };
};

const resolveEnvironment = (
  project: RailwayProjectInfo,
  requestedName?: string
): RailwayEnvironmentInfo | null => {
  if (project.environments.length === 0) return null;

  const explicitId = cleanEnvValue(process.env.RAILWAY_ENVIRONMENT_ID);
  if (explicitId) {
    const byId = project.environments.find((item) => item.id === explicitId);
    if (byId) return byId;
  }

  if (requestedName) {
    const target = requestedName.toLowerCase();
    const byName = project.environments.find((item) => item.name.toLowerCase() === target);
    if (byName) return byName;
  }

  const production = project.environments.find((item) => item.name.toLowerCase() === "production");
  return production ?? project.environments[0];
};

const findServiceByName = (
  project: RailwayProjectInfo,
  serviceName: string
): RailwayServiceInfo | null => {
  const target = normalizeServiceName(serviceName);
  return (
    project.services.find((service) => normalizeServiceName(service.name) === target) ?? null
  );
};

const createService = async (
  connection: RailwayConnection,
  environmentId: string,
  serviceName: string,
  image: string
) => {
  return railwayGraphql<{ serviceCreate?: { id: string; name: string } }>(
    connection.candidate,
    "mutation($input:ServiceCreateInput!){ serviceCreate(input:$input){ id name } }",
    {
      input: {
        projectId: connection.projectId,
        environmentId,
        name: serviceName,
        source: { image },
      },
    }
  );
};

const deployService = async (
  connection: RailwayConnection,
  environmentId: string,
  serviceId: string
) => {
  return railwayGraphql<{ serviceInstanceDeployV2?: string }>(
    connection.candidate,
    "mutation($environmentId:String!,$serviceId:String!){ serviceInstanceDeployV2(environmentId:$environmentId,serviceId:$serviceId) }",
    { environmentId, serviceId }
  );
};

const upsertVariable = async (
  connection: RailwayConnection,
  environmentId: string,
  serviceId: string | null,
  name: string,
  value: string
) => {
  return railwayGraphql<{ variableUpsert?: boolean }>(
    connection.candidate,
    "mutation($input:VariableUpsertInput!){ variableUpsert(input:$input) }",
    {
      input: {
        projectId: connection.projectId,
        environmentId,
        serviceId: serviceId ?? undefined,
        name,
        value,
        skipDeploys: true,
      },
    }
  );
};

const buildApprovalMessage = (parsed: ParsedRailwayCommand): string => {
  const lines = [
    `Запрошено действие Railway: ${parsed.summary}`,
    `Требуется подтверждение перед выполнением.`,
  ];
  if (parsed.serviceName) lines.push(`service: ${ensureManagedServiceName(parsed.serviceName)}`);
  if (parsed.image) lines.push(`image: ${parsed.image}`);
  if (parsed.environmentName) lines.push(`environment: ${parsed.environmentName}`);
  if (Object.keys(parsed.variables).length > 0) {
    lines.push(`variables: ${Object.keys(parsed.variables).join(", ")}`);
  }
  lines.push(`Подтвердите командой: "подтверждаю запуск".`);
  return lines.join("\n");
};

const buildStatusMessage = (project: RailwayProjectInfo): string => {
  const managedServices = project.services.filter((service) =>
    isManagedServiceName(service.name)
  );
  const serviceLines =
    managedServices.length > 0
      ? managedServices.map((service) => `- ${service.name} (${service.id})`)
      : ["- управляемых сервисов пока нет"];
  return [
    `Railway project: ${project.name} (${project.id})`,
    `Environments: ${project.environments.map((env) => env.name).join(", ") || "none"}`,
    `Managed services (${MANAGED_SERVICE_PREFIX}*):`,
    ...serviceLines,
  ].join("\n");
};

export const executeRailwayCommand = async (
  message: string,
  approved: boolean
): Promise<RailwayExecutionResult> => {
  const parsed = parseRailwayCommand(message);
  if (!parsed?.isRailwayCommand) {
    return {
      handled: false,
      ok: false,
      requiresApproval: false,
      action: "help",
      summary: "",
      details: [],
    };
  }

  if (parsed.action === "help") {
    return {
      handled: true,
      ok: true,
      requiresApproval: false,
      action: "help",
      summary: buildRailwayHelpText(),
      details: [],
    };
  }

  if (parsed.requiresApproval && !approved) {
    return {
      handled: true,
      ok: false,
      requiresApproval: true,
      action: parsed.action,
      summary: buildApprovalMessage(parsed),
      details: [],
    };
  }

  const connectionResult = await resolveConnection();
  if (connectionResult.ok === false) {
    return {
      handled: true,
      ok: false,
      requiresApproval: false,
      action: parsed.action,
      summary: `Railway preflight failed: ${connectionResult.error}`,
      details: connectionResult.details,
    };
  }

  const { connection, project } = connectionResult;
  const environment = resolveEnvironment(project, parsed.environmentName);
  if (!environment) {
    return {
      handled: true,
      ok: false,
      requiresApproval: false,
      action: parsed.action,
      summary: "Не найдено окружение Railway для выполнения операции.",
      details: ["Проверьте environments в проекте и RAILWAY_ENVIRONMENT_ID."],
    };
  }

  if (parsed.action === "status") {
    return {
      handled: true,
      ok: true,
      requiresApproval: false,
      action: parsed.action,
      summary: buildStatusMessage(project),
      details: [],
    };
  }

  if (parsed.action === "create_service") {
    const requested = parsed.serviceName ?? `task-${Date.now().toString(36)}`;
    const managedName = ensureManagedServiceName(requested);
    const image = parsed.image ?? DEFAULT_IMAGE;
    const existing = findServiceByName(project, managedName);

    let serviceId = existing?.id ?? null;
    const details: string[] = [
      `project: ${project.name}`,
      `environment: ${environment.name}`,
      `service: ${managedName}`,
      `image: ${image}`,
    ];

    if (!serviceId) {
      const created = await createService(connection, environment.id, managedName, image);
      if (!created.ok || !created.data?.serviceCreate?.id) {
        return {
          handled: true,
          ok: false,
          requiresApproval: false,
          action: parsed.action,
          summary: "Не удалось создать Railway сервис.",
          details: [created.error ?? "serviceCreate failed"],
        };
      }
      serviceId = created.data.serviceCreate.id;
      details.push(`createdServiceId: ${serviceId}`);
    } else {
      details.push(`service already exists: ${serviceId}`);
    }

    if (Object.keys(parsed.variables).length > 0) {
      for (const [name, value] of Object.entries(parsed.variables)) {
        const upserted = await upsertVariable(connection, environment.id, serviceId, name, value);
        if (!upserted.ok) {
          return {
            handled: true,
            ok: false,
            requiresApproval: false,
            action: parsed.action,
            summary: `Не удалось установить переменную ${name}.`,
            details: [upserted.error ?? "variableUpsert failed"],
          };
        }
      }
      details.push(`variables set: ${Object.keys(parsed.variables).join(", ")}`);
    }

    const deployed = await deployService(connection, environment.id, serviceId);
    if (!deployed.ok) {
      return {
        handled: true,
        ok: false,
        requiresApproval: false,
        action: parsed.action,
        summary: "Сервис создан, но деплой не запущен.",
        details: [deployed.error ?? "serviceInstanceDeployV2 failed", ...details],
      };
    }

    details.push(`deploymentId: ${String(deployed.data?.serviceInstanceDeployV2 ?? "n/a")}`);
    return {
      handled: true,
      ok: true,
      requiresApproval: false,
      action: parsed.action,
      summary: "Railway сервис создан и деплой запущен.",
      details,
    };
  }

  if (parsed.action === "deploy_service") {
    if (!parsed.serviceName) {
      return {
        handled: true,
        ok: false,
        requiresApproval: false,
        action: parsed.action,
        summary: "Для деплоя нужно указать service=<name>.",
        details: [],
      };
    }

    const managedName = ensureManagedServiceName(parsed.serviceName);
    if (!isManagedServiceName(managedName)) {
      return {
        handled: true,
        ok: false,
        requiresApproval: false,
        action: parsed.action,
        summary: `Разрешены только managed сервисы (${MANAGED_SERVICE_PREFIX}*).`,
        details: [],
      };
    }

    const service = findServiceByName(project, managedName);
    if (!service) {
      return {
        handled: true,
        ok: false,
        requiresApproval: false,
        action: parsed.action,
        summary: `Сервис ${managedName} не найден.`,
        details: [],
      };
    }

    const deployed = await deployService(connection, environment.id, service.id);
    if (!deployed.ok) {
      return {
        handled: true,
        ok: false,
        requiresApproval: false,
        action: parsed.action,
        summary: `Не удалось запустить деплой для ${managedName}.`,
        details: [deployed.error ?? "serviceInstanceDeployV2 failed"],
      };
    }

    return {
      handled: true,
      ok: true,
      requiresApproval: false,
      action: parsed.action,
      summary: `Деплой запущен для ${managedName}.`,
      details: [`deploymentId: ${String(deployed.data?.serviceInstanceDeployV2 ?? "n/a")}`],
    };
  }

  if (parsed.action === "set_variables") {
    if (!parsed.serviceName) {
      return {
        handled: true,
        ok: false,
        requiresApproval: false,
        action: parsed.action,
        summary: "Для изменения переменных нужно указать service=<name>.",
        details: [],
      };
    }

    const keys = Object.keys(parsed.variables);
    if (keys.length === 0) {
      return {
        handled: true,
        ok: false,
        requiresApproval: false,
        action: parsed.action,
        summary: "Не найдены пары KEY=VALUE в запросе.",
        details: [],
      };
    }

    const managedName = ensureManagedServiceName(parsed.serviceName);
    const service = findServiceByName(project, managedName);
    if (!service) {
      return {
        handled: true,
        ok: false,
        requiresApproval: false,
        action: parsed.action,
        summary: `Сервис ${managedName} не найден.`,
        details: [],
      };
    }

    for (const [name, value] of Object.entries(parsed.variables)) {
      const upserted = await upsertVariable(connection, environment.id, service.id, name, value);
      if (!upserted.ok) {
        return {
          handled: true,
          ok: false,
          requiresApproval: false,
          action: parsed.action,
          summary: `Не удалось установить переменную ${name}.`,
          details: [upserted.error ?? "variableUpsert failed"],
        };
      }
    }

    const details = [`service: ${managedName}`, `variables: ${keys.join(", ")}`];
    if (parsed.deployAfterVariables) {
      const deployed = await deployService(connection, environment.id, service.id);
      if (!deployed.ok) {
        return {
          handled: true,
          ok: false,
          requiresApproval: false,
          action: parsed.action,
          summary: "Переменные применены, но деплой не запущен.",
          details: [deployed.error ?? "serviceInstanceDeployV2 failed", ...details],
        };
      }
      details.push(`deploymentId: ${String(deployed.data?.serviceInstanceDeployV2 ?? "n/a")}`);
    }

    return {
      handled: true,
      ok: true,
      requiresApproval: false,
      action: parsed.action,
      summary: "Переменные Railway сервиса обновлены.",
      details,
    };
  }

  return {
    handled: true,
    ok: true,
    requiresApproval: false,
    action: "help",
    summary: buildRailwayHelpText(),
    details: [],
  };
};
