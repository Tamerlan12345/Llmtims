import { TEAM_RULES, getAgentPrompt } from "./prompts";

declare const describe: (name: string, run: () => void) => void;
declare const it: (name: string, run: () => void) => void;
declare const expect: (value: unknown) => {
  toContain: (needle: string) => void;
};

describe("Agent prompt resolution", () => {
  it("uses role_md when provided", () => {
    const prompt = getAgentPrompt("Senior Web Developer", "Ты senior developer. Пиши код и проверяй качество.");
    expect(prompt).toContain("Ты senior developer. Пиши код и проверяй качество.");
    expect(prompt).toContain("Pixel Office CIC team rules");
  });

  it("falls back to dynamic default prompt when role_md is missing", () => {
    const prompt = getAgentPrompt("Analyst");
    expect(prompt).toContain("You are Analyst inside Digital Pixel Office");
    expect(prompt).toContain(TEAM_RULES.trim().split("\n")[0]);
  });

  it("injects the PM GSD directive for project manager roles", () => {
    const prompt = getAgentPrompt("PM");
    expect(prompt).toContain("call plan_gsd_project first");
    expect(prompt).toContain("delegate_task for the first executor");
  });
});
