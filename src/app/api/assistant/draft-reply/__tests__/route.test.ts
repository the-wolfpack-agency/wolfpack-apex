/* eslint-disable @typescript-eslint/no-explicit-any */
export {};

const mockGetUser = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: any[]) => mockGetUser(...a),
}));

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import { __setDraftProviderForTests } from "@/lib/ai/draft-provider";

function mkReq(body: unknown, auth = "Bearer t"): any {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  headers.set("content-type", "application/json");
  return new Request("http://test/api/assistant/draft-reply", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  __setDraftProviderForTests(null);
});

describe("POST /api/assistant/draft-reply", () => {
  it("401 without auth", async () => {
    mockGetUser.mockReturnValue(null);
    const { POST } = await import("@/app/api/assistant/draft-reply/route");
    const res = await POST(mkReq({ surface: "chat" }, ""));
    expect(res.status).toBe(401);
  });

  it("400 when surface missing or invalid", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "Nick" });
    const { POST } = await import("@/app/api/assistant/draft-reply/route");
    const r1 = await POST(mkReq({}));
    expect(r1.status).toBe(400);
    const r2 = await POST(mkReq({ surface: "twitter" }));
    expect(r2.status).toBe(400);
  });

  it("happy path returns draft + fires assistant.draft_requested with usage", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "Nick" });
    __setDraftProviderForTests({
      draftReply: jest.fn(async (ctx) => ({
        text: `Got it, ${ctx.recipientName ?? "team"} — sending soon.`,
        model: "test-model",
        promptTokens: 42,
        completionTokens: 17,
      })),
    });
    const { POST } = await import("@/app/api/assistant/draft-reply/route");
    const res = await POST(
      mkReq({
        surface: "chat",
        recipientName: "Max",
        threadContext: [
          { from: "Max", text: "any update?" },
          { from: "Nick", text: "checking now" },
        ],
        contextId: "chat-9",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toMatch(/Max/);
    expect(body.model).toBe("test-model");
    expect(body.promptTokens).toBe(42);
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.draft_requested",
      "u1",
      "ceo",
      expect.objectContaining({
        surface: "chat",
        context_id: "chat-9",
        thread_turns: 2,
        model: "test-model",
        prompt_tokens: 42,
        completion_tokens: 17,
      }),
    );
  });

  it("clamps thread context to last 30 turns", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "Nick" });
    const fn = jest.fn(async () => ({
      text: "ok",
      model: "m",
      promptTokens: 1,
      completionTokens: 1,
    }));
    __setDraftProviderForTests({ draftReply: fn });
    const ctx = Array.from({ length: 50 }, (_, i) => ({
      from: "x",
      text: `m${i}`,
    }));
    const { POST } = await import("@/app/api/assistant/draft-reply/route");
    await POST(mkReq({ surface: "chat", threadContext: ctx }));
    const passedCtx = (fn as jest.Mock).mock.calls[0][0]
      .threadContext as unknown[];
    expect(passedCtx.length).toBe(30);
  });

  it("500 + draft_failed analytics on provider error", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "Nick" });
    __setDraftProviderForTests({
      draftReply: jest.fn(async () => {
        throw new Error("LLM rate limited");
      }),
    });
    const { POST } = await import("@/app/api/assistant/draft-reply/route");
    const res = await POST(mkReq({ surface: "chat" }));
    expect(res.status).toBe(500);
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.draft_failed",
      "u1",
      "ceo",
      expect.objectContaining({ surface: "chat" }),
    );
  });

  it("503 + code=missing_api_key when ANTHROPIC_API_KEY not configured", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "Nick" });
    __setDraftProviderForTests({
      draftReply: jest.fn(async () => {
        throw new Error("ANTHROPIC_API_KEY not configured");
      }),
    });
    const { POST } = await import("@/app/api/assistant/draft-reply/route");
    const res = await POST(mkReq({ surface: "chat" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("missing_api_key");
    expect(body.error).toMatch(/AI assistant not configured/i);
  });

  it("503 + code=missing_api_key for OPENAI_API_KEY missing (multi-provider)", async () => {
    mockGetUser.mockReturnValue({ id: "u1", role: "ceo", name: "Nick" });
    __setDraftProviderForTests({
      draftReply: jest.fn(async () => {
        throw new Error("OPENAI_API_KEY missing — set in Vercel env");
      }),
    });
    const { POST } = await import("@/app/api/assistant/draft-reply/route");
    const res = await POST(mkReq({ surface: "chat" }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("missing_api_key");
  });
});
