 
/**
 * /api/assistant — response shape contract.
 *
 * Locks the /assistant page's rendering contract:
 *   { response, sources: [{id,title,url,type}], relatedPages: [{...}] }
 *
 * Covers the three paths a question can take:
 *   1. Tool router hit (calendar/goals/financials/mail/brain_history)
 *      → sources[0] = "From Microsoft 365 · your calendar" style chip
 *   2. Knowledge base hit → sources[] = KB rows with /knowledge links
 *   3. Brain hit → sources[] = doc ids with /brain?doc=... links
 *
 * Also covers the zero-match case (no domain keywords → no relatedPages).
 */

const mockChat = jest.fn();
const mockTryTool = jest.fn();
const mockClassifyIntent = jest.fn();
const mockCheckDocQuality = jest.fn();
const mockTrackGateResult = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/assistant", () => ({
  chat: (...a: any[]) => mockChat(...a),
  getConversations: jest.fn(),
  getConversationMessages: jest.fn(),
  rateMessage: jest.fn(),
  archiveConversation: jest.fn(),
  persistToolAnswer: jest.fn().mockResolvedValue({
    conversationId: "c-persist", messageId: "m-persist",
  }),
}));
jest.mock("@/lib/assistant/orchestrator", () => ({
  tryToolAnswer: (...a: any[]) => mockTryTool(...a),
  classifyIntent: (...a: any[]) => mockClassifyIntent(...a),
}));
jest.mock("@/lib/doc-quality-gate", () => ({
  checkDocQuality: (...a: any[]) => mockCheckDocQuality(...a),
  trackGateResult: (...a: any[]) => mockTrackGateResult(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

const AUTH_USER = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => AUTH_USER,
}));

import { NextRequest } from "next/server";
import { POST } from "../route";

function postMessage(message: string): NextRequest {
  return new NextRequest("https://x.test/api/assistant", {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

beforeEach(() => {
  mockChat.mockReset();
  mockTryTool.mockReset();
  mockClassifyIntent.mockReset();
  mockTrackEvent.mockReset();
  mockClassifyIntent.mockReturnValue({ intent: "unknown", confidence: 0, slots: {} });
});

describe("POST /api/assistant — sources + relatedPages", () => {
  test("calendar tool hit returns Microsoft 365 source + /calendar chip", async () => {
    mockClassifyIntent.mockReturnValue({
      intent: "calendar_availability",
      confidence: 0.9,
      slots: { person: "__self__" },
    });
    mockTryTool.mockResolvedValue({
      intent: "calendar_availability",
      answer: "You have 2 meetings today.",
      data: { slots: [] },
      source: "tool",
    });

    const res = await POST(postMessage("do I have meetings on my calendar today?"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // The original tool answer is preserved — we append a trailing
    // "See more: [Page](/route)" footer so the markdown renderer
    // produces an inline clickable link even when the chip row is
    // scrolled off-screen. The original sentence must still be there
    // verbatim at the start.
    expect(body.response).toMatch(/^You have 2 meetings today\./);
    expect(body.response).toMatch(/See more: \[[^\]]+\]\(\/[a-z]+\)/);
    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.sources.length).toBe(1);
    expect(body.sources[0].type).toBe("tool");
    expect(body.sources[0].title).toContain("Microsoft 365");
    expect(Array.isArray(body.relatedPages)).toBe(true);
    const domains = body.relatedPages.map((r: any) => r.domain);
    expect(domains).toContain("calendar");
    expect(domains).toContain("meetings");
  });

  test("knowledge-base hit surfaces sources[] with /knowledge links", async () => {
    mockChat.mockResolvedValue({
      response: "Our API uses bearer tokens.",
      source: "knowledge_cache",
      tokensUsed: 0,
      conversationId: "c-1",
      messageId: "m-1",
      sources: [
        {
          id: "kb-1",
          title: "How does auth work?",
          url: "/knowledge?entry=kb-1",
          type: "knowledge",
        },
      ],
    });

    const res = await POST(postMessage("tell me about our knowledge base on auth"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toEqual([
      {
        id: "kb-1",
        title: "How does auth work?",
        url: "/knowledge?entry=kb-1",
        type: "knowledge",
      },
    ]);
    // "knowledge" domain chip must appear since the query mentioned KB.
    const domains = body.relatedPages.map((r: any) => r.domain);
    expect(domains).toContain("knowledge");
  });

  test("brain hit surfaces sources[] with /brain?doc=... links", async () => {
    mockChat.mockResolvedValue({
      response: "The brain has 3 docs on site layouts.",
      source: "brain",
      tokensUsed: 42,
      conversationId: "c-2",
      messageId: "m-2",
      sources: [
        {
          id: "doc-7",
          title: "layout-guide.pdf",
          url: "/brain?doc=doc-7",
          type: "brain",
        },
      ],
    });

    const res = await POST(postMessage("what does the brain say about site layouts?"));
    const body = await res.json();
    expect(body.sources[0].type).toBe("brain");
    expect(body.sources[0].url).toContain("/brain?doc=");
  });

  test("no domain keywords → no relatedPages key on payload", async () => {
    mockChat.mockResolvedValue({
      response: "Sure thing.",
      source: "ai",
      tokensUsed: 10,
      conversationId: "c-3",
      messageId: "m-3",
    });

    const res = await POST(postMessage("hello friend"));
    const body = await res.json();
    // relatedPages is only attached when at least one keyword matches
    // so the client can treat "no relatedPages" as "skip the chip row".
    expect(body.relatedPages).toBeUndefined();
  });

  test("401 when no user is resolved", async () => {
    jest.resetModules();
    jest.doMock("@/lib/auth", () => ({ getUserFromRequest: () => null }));
    jest.doMock("@/lib/assistant", () => ({
      chat: mockChat,
      getConversations: jest.fn(),
      getConversationMessages: jest.fn(),
      rateMessage: jest.fn(),
      archiveConversation: jest.fn(),
    }));
    jest.doMock("@/lib/assistant/orchestrator", () => ({
      tryToolAnswer: mockTryTool,
      classifyIntent: mockClassifyIntent,
    }));
    jest.doMock("@/lib/doc-quality-gate", () => ({
      checkDocQuality: mockCheckDocQuality,
      trackGateResult: mockTrackGateResult,
    }));
    jest.doMock("@/lib/analytics", () => ({ trackEvent: mockTrackEvent }));
     
    const { POST: anonPost } = require("../route");
    const res = await anonPost(postMessage("hi"));
    expect(res.status).toBe(401);
  });
});
