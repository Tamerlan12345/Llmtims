export interface OfficeDesk {
  x: number;
  y: number;
}

export const OFFICE_DESKS: OfficeDesk[] = [
  { x: 21, y: 47 },
  { x: 35, y: 47 },
  { x: 49, y: 47 },
  { x: 21, y: 65 },
  { x: 35, y: 65 },
  { x: 49, y: 65 },
];

export const deskKey = (desk: OfficeDesk) => `${desk.x}:${desk.y}`;

const normalizeDeskNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }

  return null;
};

const isDeskObject = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

export const extractDeskFromMetadata = (metadata: unknown): OfficeDesk | null => {
  if (!isDeskObject(metadata)) {
    return null;
  }

  const x = normalizeDeskNumber(metadata.x ?? metadata.default_x);
  const y = normalizeDeskNumber(metadata.y ?? metadata.default_y);
  if (x === null || y === null) {
    return null;
  }

  return { x, y };
};

export const collectOccupiedDeskKeys = (
  agents: Array<{ metadata?: unknown }>
): Set<string> => {
  const deskPool = new Set(OFFICE_DESKS.map(deskKey));
  const occupied = new Set<string>();

  for (const agent of agents) {
    const desk = extractDeskFromMetadata(agent.metadata);
    if (!desk) continue;

    const key = deskKey(desk);
    if (deskPool.has(key)) {
      occupied.add(key);
    }
  }

  return occupied;
};

export const pickFirstFreeDesk = (occupied: Set<string>): OfficeDesk | null => {
  for (const desk of OFFICE_DESKS) {
    if (!occupied.has(deskKey(desk))) {
      return desk;
    }
  }

  return null;
};

