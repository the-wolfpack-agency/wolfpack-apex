/**
 * The rewriter the retrieval path has always accepted and never been given.
 *
 * "Do we pay half now and half later?" was asked five times by people and
 * answered none of them, while the work order that answers it says fifty per
 * cent on execution and the remainder on delivery. Its embedding scores below
 * the semantic floor entirely: zero hits, not a near miss.
 */
const mockComplete = jest.fn();
jest.mock("@/lib/ai", () => ({ getAIClient: () => ({ complete: mockComplete }) }));

import { makeExpander } from "../expand-runner";
import { EXPANSION_MAX_TOKENS } from "../expand-query";

const ctx = { userId: "u1", userRole: "cto" };

beforeEach(() => mockComplete.mockReset());

describe("rewriting a question into document words", () => {
  it("returns the rewrite", async () => {
    mockComplete.mockResolvedValue({ content: "payment schedule deposit initial payment balance due" });
    const out = await makeExpander(ctx)("do we pay half now and half later?");
    expect(out).toContain("deposit");
  });

  /* Not a reasoning problem. Paying a premium model to produce eight words is
     how a feature that rescues a failed answer becomes a line item somebody
     cancels. */
  it("uses the cheap tier and a small ceiling", async () => {
    mockComplete.mockResolvedValue({ content: "x" });
    await makeExpander(ctx)("q");
    const req = mockComplete.mock.calls[0][0];
    expect(req.model_tier).toBe("cheap");
    expect(req.max_tokens).toBe(EXPANSION_MAX_TOKENS);
  });

  /* A rewrite is still a prompt leaving the building. */
  it("goes through the same redaction as every other call", async () => {
    mockComplete.mockResolvedValue({ content: "x" });
    await makeExpander(ctx)("my card is 4111 1111 1111 1111, what do we owe");
    expect(mockComplete.mock.calls[0][0].sensitivity).toBe("pii");
    expect(mockComplete.mock.calls[0][0].metadata.feature).toBe("brain.query_expansion");
  });
});

describe("when the rewrite cannot happen", () => {
  /* Returning the original is the documented way to say "do not retry", and
     retrieve() checks for exactly that. Nothing is lost that was not already
     lost when the first pass came back thin. */
  it("returns the original question when the provider fails", async () => {
    mockComplete.mockRejectedValue(new Error("provider down"));
    const q = "do we pay half now and half later?";
    expect(await makeExpander(ctx)(q)).toBe(q);
  });

  it("returns the original when the model says nothing", async () => {
    mockComplete.mockResolvedValue({ content: "" });
    const q = "what do we owe";
    expect(await makeExpander(ctx)(q)).toBe(q);
  });
});
