import "server-only";

import type { NextRequest } from "next/server";

export const isValidAgentWorkerRequest = (req: NextRequest): boolean => {
  const expectedToken = process.env.AGENT_WORKER_TOKEN?.trim();
  if (!expectedToken) return false;

  const bearer = req.headers.get("authorization")?.trim() ?? "";
  const headerToken = req.headers.get("x-agent-worker-token")?.trim() ?? "";
  const providedToken = bearer.toLowerCase().startsWith("bearer ")
    ? bearer.slice("bearer ".length).trim()
    : headerToken;

  return providedToken.length > 0 && providedToken === expectedToken;
};
