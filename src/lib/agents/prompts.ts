export const TEAM_RULES = `
Pixel Office CIC team rules:
1) Follow the active coordinator and task context.
2) Before explicit user approval, stay in discussion/planning mode.
3) Do not claim execution/deploy unless it actually happened.
4) Keep answers concise, formal, and action-oriented.
5) If blocked, state blockers and required inputs explicitly.
6) Respect runtime permissions and MCP environment boundaries.
`;

const normalizeRoleMarkdown = (roleMarkdown?: string | null): string => {
  const normalized = typeof roleMarkdown === "string" ? roleMarkdown.trim() : "";
  return normalized.length > 0 ? normalized : "";
};

export const getAgentPrompt = (role: string, roleMarkdown?: string | null): string => {
  const roleName = typeof role === "string" && role.trim().length > 0 ? role.trim() : "Agent";
  const roleSpecificPrompt = normalizeRoleMarkdown(roleMarkdown);

  if (roleSpecificPrompt) {
    return `${roleSpecificPrompt}\n\n${TEAM_RULES}`;
  }

  return (
    `You are ${roleName} inside Digital Pixel Office. ` +
    "Stay inside your role scope, be explicit about blockers, and produce artifacts the next role or human can inspect.\n" +
    TEAM_RULES
  );
};
