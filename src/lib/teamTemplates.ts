export type SupportedTemplateRuntimeRole = "PM" | "Developer" | "QA" | "DevOps";

export interface TeamTemplateRoleEntry {
  roleKey: string;
  displayName: string;
  runtimeRole: SupportedTemplateRuntimeRole;
  skills: string[];
}

export const SUPPORTED_TEMPLATE_RUNTIME_ROLES: SupportedTemplateRuntimeRole[] = [
  "PM",
  "Developer",
  "QA",
  "DevOps",
];

export const isSupportedTemplateRuntimeRole = (
  value: unknown
): value is SupportedTemplateRuntimeRole => {
  return (
    typeof value === "string" &&
    SUPPORTED_TEMPLATE_RUNTIME_ROLES.includes(value as SupportedTemplateRuntimeRole)
  );
};

export const parseTeamTemplateRoles = (value: unknown): TeamTemplateRoleEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const row = entry as Record<string, unknown>;
      const runtimeRole = row.runtimeRole;
      if (!isSupportedTemplateRuntimeRole(runtimeRole)) {
        return null;
      }

      const skills = Array.isArray(row.skills)
        ? row.skills.filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0)
        : [];

      return {
        roleKey:
          typeof row.roleKey === "string" && row.roleKey.trim().length > 0
            ? row.roleKey.trim()
            : runtimeRole.toLowerCase(),
        displayName:
          typeof row.displayName === "string" && row.displayName.trim().length > 0
            ? row.displayName.trim()
            : runtimeRole,
        runtimeRole,
        skills: Array.from(new Set(skills)),
      } satisfies TeamTemplateRoleEntry;
    })
    .filter((entry): entry is TeamTemplateRoleEntry => Boolean(entry));
};

export const collapseTemplateRolesByRuntimeRole = (
  roles: TeamTemplateRoleEntry[]
): TeamTemplateRoleEntry[] => {
  const collapsed = new Map<SupportedTemplateRuntimeRole, TeamTemplateRoleEntry>();

  for (const role of roles) {
    const current = collapsed.get(role.runtimeRole);
    if (!current) {
      collapsed.set(role.runtimeRole, {
        ...role,
        skills: [...role.skills],
      });
      continue;
    }

    collapsed.set(role.runtimeRole, {
      ...current,
      displayName: current.displayName || role.displayName,
      skills: Array.from(new Set([...current.skills, ...role.skills])),
    });
  }

  return SUPPORTED_TEMPLATE_RUNTIME_ROLES.map((runtimeRole) => collapsed.get(runtimeRole)).filter(
    (entry): entry is TeamTemplateRoleEntry => Boolean(entry)
  );
};
