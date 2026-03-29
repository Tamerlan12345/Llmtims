export type AgentRole = "PM" | "Developer" | "QA" | "DevOps" | string;
export type OfficeZone = "planning" | "coding" | "testing" | "cloud" | "lounge" | "meeting";
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "review"
  | "done"
  | "failed"
  | "waiting_approval"
  | string;
export type AgentMode =
  | "walking"
  | "typing"
  | "testing"
  | "monitoring"
  | "watching_tv"
  | "celebrating"
  | "debugging"
  | "discussing";

export interface OfficeAgentLite {
  id: string;
  is_active: boolean;
}

export interface OfficePoint {
  x: string;
  y: string;
}

const DESK_POINTS: Record<Exclude<OfficeZone, "lounge" | "meeting">, OfficePoint> = {
  planning: { x: "21%", y: "47%" },
  coding: { x: "79%", y: "47%" },
  testing: { x: "21%", y: "81%" },
  cloud: { x: "79%", y: "81%" },
};

const LOUNGE_SEATS: OfficePoint[] = [
  { x: "46%", y: "72%" },
  { x: "54%", y: "72%" },
  { x: "61%", y: "71%" },
];

export const MEETING_POINTS: Record<"PM" | "Peer", OfficePoint> = {
  PM: { x: "47%", y: "59%" },
  Peer: { x: "54%", y: "59%" },
};

export const roleLabelRu = (role: AgentRole): string => {
  if (role === "PM") return "PM";
  if (role === "Developer") return "Разработчик";
  if (role === "QA") return "QA";
  if (role === "DevOps") return "DevOps";
  return String(role);
};

export const resolveZoneByRole = (role: AgentRole): Exclude<OfficeZone, "lounge" | "meeting"> => {
  if (role === "PM") return "planning";
  if (role === "Developer") return "coding";
  if (role === "QA") return "testing";
  return "cloud";
};

export const resolveAgentMode = (
  role: AgentRole,
  isActive: boolean,
  taskStatus: TaskStatus,
  discussing = false
): AgentMode => {
  if (discussing) return "discussing";

  if (taskStatus === "done") {
    return "celebrating";
  }

  if (taskStatus === "failed") {
    return isActive ? "debugging" : "watching_tv";
  }

  if (!isActive) {
    return "watching_tv";
  }

  if (taskStatus === "pending") {
    return "walking";
  }

  if (taskStatus === "review" || taskStatus === "waiting_approval") {
    return role === "QA" ? "testing" : "walking";
  }

  if (role === "Developer") return "typing";
  if (role === "QA") return "testing";
  if (role === "DevOps") return "monitoring";
  return "typing";
};

export const resolveTargetPoint = (
  role: AgentRole,
  isActive: boolean,
  index: number,
  taskStatus: TaskStatus
): OfficePoint => {
  const mode = resolveAgentMode(role, isActive, taskStatus);

  if (mode === "watching_tv" || mode === "celebrating") {
    return LOUNGE_SEATS[index % LOUNGE_SEATS.length];
  }

  const zone = resolveZoneByRole(role);
  return DESK_POINTS[zone];
};

export const resolveActivityLabel = (role: AgentRole, mode: AgentMode): string => {
  if (mode === "watching_tv") return "Гуляет по офису";
  if (mode === "walking") return "Идёт по офису";
  if (mode === "celebrating") return "Отмечает релиз";
  if (mode === "debugging") return "Разбирает инцидент";
  if (mode === "testing") return role === "QA" ? "Прогоняет тесты" : "Помогает QA";
  if (mode === "monitoring") return "Следит за деплоем";
  if (mode === "discussing") return "Синхронизируется с PM";
  return role === "PM" ? "Координирует команду" : "Работает над задачей";
};

export const rotateActiveAgent = <T extends OfficeAgentLite>(agents: T[]): T[] => {
  if (!agents.length) {
    return agents;
  }

  const currentIndex = agents.findIndex((agent) => agent.is_active);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % agents.length : 0;

  return agents.map((agent, index) => ({
    ...agent,
    is_active: index === nextIndex,
  }));
};

export const rotateMockTaskStatus = (current: TaskStatus): TaskStatus => {
  const flow: TaskStatus[] = ["pending", "in_progress", "review", "done", "failed"];
  const index = flow.indexOf(current);
  if (index < 0) {
    return flow[0];
  }

  return flow[(index + 1) % flow.length];
};
