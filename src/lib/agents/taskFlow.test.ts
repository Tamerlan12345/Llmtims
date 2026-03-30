import { AGENT_PROMPTS } from "./prompts";
import { pmNode, devOpsNode } from "./nodes";

describe("Agent Prompts & Constraints", () => {
  it("PM should explicitly ask for GitHub or Railway platform", () => {
    expect(AGENT_PROMPTS.PM).toContain("GitHub");
    expect(AGENT_PROMPTS.PM).toContain("Railway");
    expect(AGENT_PROMPTS.PM).toContain("разрешение");
  });

  it("PM should retain context", () => {
    expect(AGENT_PROMPTS.PM).toContain("контекст");
  });

  it("DevOps should return deployment URL", () => {
    expect(AGENT_PROMPTS.DevOps).toContain("URL-адрес");
  });
});

describe("Agent Node Functions", () => {
  it("Exports valid nodes handling AgentState", () => {
    expect(typeof pmNode).toBe("function");
    expect(typeof devOpsNode).toBe("function");
  });
});
