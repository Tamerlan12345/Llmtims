export interface OfficeSummary {
  id: string;
  name: string;
  accessRole: "owner" | "member";
}

export const DEFAULT_OFFICE_NAME = "Digital Pixel Office";
export const DEFAULT_ROOM_KEY = "pixel-office-cic";

export const buildOfficeRoomKey = (officeId?: string | null): string => {
  const normalized = String(officeId ?? "").trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_ROOM_KEY;
  }

  const safeOfficeId = normalized
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return safeOfficeId ? `pixel-office-${safeOfficeId}` : DEFAULT_ROOM_KEY;
};

export const dedupeOffices = (offices: OfficeSummary[]): OfficeSummary[] => {
  const next = new Map<string, OfficeSummary>();
  for (const office of offices) {
    if (!office.id) continue;
    next.set(office.id, office);
  }
  return Array.from(next.values());
};
