export interface TeamTemplateRoleEntry {
  roleKey: string;
  displayName: string;
  runtimeRole: string;
  skills: string[];
  roleMarkdown?: string;
  metadata?: Record<string, unknown>;
}

export const parseTeamTemplateRoles = (value: unknown): TeamTemplateRoleEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map<TeamTemplateRoleEntry | null>((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const row = entry as Record<string, unknown>;
      const runtimeRole =
        typeof row.runtimeRole === "string" && row.runtimeRole.trim().length > 0
          ? row.runtimeRole.trim()
          : typeof row.role_name === "string" && row.role_name.trim().length > 0
            ? row.role_name.trim()
            : typeof row.roleName === "string" && row.roleName.trim().length > 0
              ? row.roleName.trim()
          : "";
      if (!runtimeRole) {
        return null;
      }

      const skills = Array.isArray(row.skills)
        ? row.skills.filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0)
        : [];

      return {
        roleKey:
          typeof row.roleKey === "string" && row.roleKey.trim().length > 0
            ? row.roleKey.trim()
            : typeof row.role_name === "string" && row.role_name.trim().length > 0
              ? row.role_name.trim().toLowerCase().replace(/\s+/g, "_")
            : runtimeRole.toLowerCase().replace(/\s+/g, "_"),
        displayName:
          typeof row.displayName === "string" && row.displayName.trim().length > 0
            ? row.displayName.trim()
            : typeof row.role_name === "string" && row.role_name.trim().length > 0
              ? row.role_name.trim()
            : runtimeRole,
        runtimeRole,
        skills: Array.from(new Set(skills)),
        roleMarkdown:
          typeof row.roleMarkdown === "string" && row.roleMarkdown.trim().length > 0
            ? row.roleMarkdown
            : typeof row.role_md === "string" && row.role_md.trim().length > 0
              ? row.role_md
            : undefined,
        metadata:
          row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : undefined,
      } satisfies TeamTemplateRoleEntry;
    })
    .filter((entry): entry is TeamTemplateRoleEntry => entry !== null);
};

export const collapseTemplateRolesByRuntimeRole = (
  roles: TeamTemplateRoleEntry[]
): TeamTemplateRoleEntry[] => {
  const collapsed = new Map<string, TeamTemplateRoleEntry>();

  for (const role of roles) {
    const current = collapsed.get(role.runtimeRole);
    if (!current) {
      collapsed.set(role.runtimeRole, {
        ...role,
        skills: [...role.skills],
        metadata: { ...(role.metadata ?? {}) },
      });
      continue;
    }

    collapsed.set(role.runtimeRole, {
      ...current,
      displayName: current.displayName || role.displayName,
      roleMarkdown: current.roleMarkdown || role.roleMarkdown,
      skills: Array.from(new Set([...current.skills, ...role.skills])),
      metadata: {
        ...(current.metadata ?? {}),
        ...(role.metadata ?? {}),
      },
    });
  }

  return Array.from(collapsed.values());
};
