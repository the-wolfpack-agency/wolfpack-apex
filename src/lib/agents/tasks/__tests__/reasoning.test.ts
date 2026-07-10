const mockComplete = jest.fn();
jest.mock("@/lib/ai", () => ({
  getAIClient: () => ({ complete: (...a: unknown[]) => mockComplete(...a) }),
}));

import { reasonAboutInstruction } from "@/lib/agents/tasks/reasoning";

const BASE = { instruction: "break down the popular AI agents", agentId: "a1", role: "ops", workspaceId: "ws1" };
const origKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "test-key"; // aiConfigured() -> true
});
afterAll(() => {
  if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = origKey;
});

it("degrades to ok:false when no AI provider is configured (never calls the model)", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.AZURE_OPENAI_API_KEY;
  const r = await reasonAboutInstruction(BASE);
  expect(r.ok).toBe(false);
  expect(mockComplete).not.toHaveBeenCalled();
});

it("reasons via the governed router with the constitution applied", async () => {
  mockComplete.mockResolvedValue({ content: "  Here is the analysis.  " });
  const r = await reasonAboutInstruction({
    ...BASE,
    guidance: "Success criteria: a useful report",
    priorResults: [{ instruction: "search", result: "found 5 agents" }],
  });
  expect(r).toEqual({ ok: true, answer: "Here is the analysis." });
  const req = mockComplete.mock.calls[0][0];
  expect(req.apply_constitution).toBe(true);
  expect(req.metadata).toMatchObject({ feature: "agent_reasoning", user_id: "a1", workspace_id: "ws1" });
  // guidance + prior results are threaded into the prompt.
  const userContent = req.messages[0].content;
  expect(userContent).toContain("Success criteria: a useful report");
  expect(userContent).toContain("found 5 agents");
  expect(userContent).toContain("break down the popular AI agents");
});

it("returns ok:false on empty content", async () => {
  mockComplete.mockResolvedValue({ content: "   " });
  const r = await reasonAboutInstruction(BASE);
  expect(r.ok).toBe(false);
});

it("returns ok:false (never throws) when the router refuses / fails (e.g. over budget)", async () => {
  mockComplete.mockRejectedValue(new Error("Workspace ws1 is over its monthly AI budget"));
  const r = await reasonAboutInstruction(BASE);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.detail).toMatch(/budget/i);
});
