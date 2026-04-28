/**
 * support / auto-acknowledge — unit tests.
 *
 * Mocks @/lib/ai, @/lib/microsoft-graph, @/lib/support/repo,
 * @/lib/support/pattern-library, @/lib/analytics, @/lib/obs + global.fetch
 * so we exercise every gate, every error path, and the happy path
 * without hitting infrastructure.
 */

const mockAIComplete = jest.fn();
jest.mock("@/lib/ai", () => ({
  getAIClient: () => ({ complete: (...args: unknown[]) => mockAIComplete(...args) }),
}));

const mockLookupCachedResponse = jest.fn();
const mockCacheResponse = jest.fn();
jest.mock("@/lib/ai/response-cache", () => ({
  __esModule: true,
  lookupCachedResponse: (...args: unknown[]) => mockLookupCachedResponse(...args),
  cacheResponse: (...args: unknown[]) => mockCacheResponse(...args),
}));

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

const mockGetTicket = jest.fn();
const mockListEnabledPatterns = jest.fn();
const mockMarkAck = jest.fn();
const mockAppendReply = jest.fn();
const mockSetTicketCacheIds = jest.fn();
jest.mock("@/lib/support/repo", () => ({
  getTicket: (...args: unknown[]) => mockGetTicket(...args),
  listEnabledPatterns: (...args: unknown[]) => mockListEnabledPatterns(...args),
  markTicketAutoAcknowledged: (...args: unknown[]) => mockMarkAck(...args),
  appendTicketReply: (...args: unknown[]) => mockAppendReply(...args),
  setTicketCacheIds: (...args: unknown[]) => mockSetTicketCacheIds(...args),
}));

const mockFindMatching = jest.fn();
jest.mock("@/lib/support/pattern-library", () => ({
  findMatchingPatterns: (...args: unknown[]) => mockFindMatching(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

const mockRecordError = jest.fn();
jest.mock("@/lib/obs", () => ({
  getObsClient: () => ({ recordError: (...args: unknown[]) => mockRecordError(...args) }),
}));

import {
  generateAutoAcknowledge,
  processAutoAcknowledge,
  sendAutoAcknowledge,
  shouldAutoAcknowledge,
} from "@/lib/support/auto-acknowledge";
import type { SupportPattern, SupportTicket } from "@/lib/support/types";

const baseTicket: SupportTicket = {
  id: "tk-1",
  title: "Cannot sign in to Outlook",
  body: "I keep seeing AADSTS20012 when I try to log in.",
  diagnostic_text: null,
  category: "m365",
  severity: "p2",
  status: "open",
  audience: "client",
  created_by_user_id: "external:user@example.com",
  created_by_email: "user@example.com",
  draft_response: null,
  draft_generated_at: null,
  draft_pattern_ids: [],
  sent_response: null,
  sent_at: null,
  sent_to_email: null,
  helpful: null,
  edit_diff: null,
  feedback_notes: null,
  feedback_at: null,
  graph_message_id: "AAMkAD-msg-1",
  graph_internet_message_id: "<msg-1@ex>",
  graph_conversation_id: "conv-1",
  category_source: "ai",
  category_confidence: 0.91,
  category_history: [],
  auto_acknowledged_at: null,
  auto_acknowledge_message_id: null,
  auto_acknowledge_pattern_id: null,
  created_at: "2026-04-27T01:00:00.000Z",
  updated_at: "2026-04-27T01:00:00.000Z",
};

const basePattern: SupportPattern = {
  id: "p-1",
  slug: "aadsts20012",
  name: "AADSTS20012",
  category: "m365",
  match_signatures: [{ type: "regex", pattern: "AADSTS20012" }],
  draft_template: "Operator-only draft",
  success_count: 4,
  fail_count: 0,
  enabled: true,
  auto_acknowledge_enabled: true,
  auto_acknowledge_template:
    "1. Try signing out and back in.\n2. Clear browser cache.\n3. Re-open Outlook.",
  created_at: "2026-04-27T00:00:00.000Z",
  updated_at: "2026-04-27T00:00:00.000Z",
};

let consoleWarnSpy: jest.SpyInstance;
let originalFetch: typeof fetch;

beforeEach(() => {
  jest.clearAllMocks();
  consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  originalFetch = global.fetch;

  /* Default AI response: a polite acknowledgement with no forbidden
     phrases. Tests that need a different shape override per-call. */
  mockAIComplete.mockResolvedValue({
    content:
      "Hi there,\n\nThanks for reaching out about trouble signing in. Here are a few steps you can try while we look into it:\n\n1. Sign out and back in.\n2. Clear your browser cache.\n3. Re-open Outlook.\n\nA Wolfpack team member will follow up shortly.\n\nThe Wolfpack Team",
    model_used: "gpt-4o-mini",
    provider_used: "azure-openai",
    input_tokens: 200,
    output_tokens: 80,
    cost_usd: 0.0001,
    latency_ms: 800,
  });

  mockGetValidToken.mockResolvedValue({
    accessToken: "tk",
    userEmail: "support@thewolfpack.agency",
  });

  mockGetTicket.mockResolvedValue({ ...baseTicket });
  mockListEnabledPatterns.mockResolvedValue([basePattern]);
  mockFindMatching.mockReturnValue([basePattern]);
  mockMarkAck.mockResolvedValue(undefined);
  mockAppendReply.mockResolvedValue("msg-row-1");
  mockSetTicketCacheIds.mockResolvedValue(undefined);

  /* Default cache mocks: every test gets a clean miss + a successful
     write unless the test overrides per-call. */
  mockLookupCachedResponse.mockResolvedValue({ hit: false });
  mockCacheResponse.mockResolvedValue({ cache_id: "new-cache-id" });

  /* Default fetch: 202 Accepted (Graph reply happy path). */
  global.fetch = jest
    .fn()
    .mockResolvedValue(new Response("", { status: 202 })) as unknown as typeof fetch;

  process.env.AUTOMATION_POLL_USER_ID = "automation-cron";
});

afterEach(() => {
  consoleWarnSpy.mockRestore();
  global.fetch = originalFetch;
});

/* ------------------------------------------------------------------ */
/* shouldAutoAcknowledge                                                */
/* ------------------------------------------------------------------ */

describe("shouldAutoAcknowledge", () => {
  it("returns true when audience=client + graph_message_id + opted-in pattern + clean body", () => {
    expect(shouldAutoAcknowledge(baseTicket, basePattern)).toBe(true);
  });

  it("returns false for internal audience", () => {
    expect(
      shouldAutoAcknowledge({ ...baseTicket, audience: "internal" }, basePattern),
    ).toBe(false);
  });

  it("returns false when no graph_message_id (manual /support form ticket)", () => {
    expect(
      shouldAutoAcknowledge(
        { ...baseTicket, graph_message_id: null },
        basePattern,
      ),
    ).toBe(false);
  });

  it("returns false when pattern is null", () => {
    expect(shouldAutoAcknowledge(baseTicket, null)).toBe(false);
  });

  it("returns false when pattern.auto_acknowledge_enabled is false", () => {
    expect(
      shouldAutoAcknowledge(baseTicket, {
        ...basePattern,
        auto_acknowledge_enabled: false,
      }),
    ).toBe(false);
  });

  it("returns false when body contains 'lawsuit'", () => {
    expect(
      shouldAutoAcknowledge(
        { ...baseTicket, body: "Considering a lawsuit if not resolved" },
        basePattern,
      ),
    ).toBe(false);
  });

  it("returns false when body contains 'CEO' (case-insensitive)", () => {
    expect(
      shouldAutoAcknowledge(
        { ...baseTicket, body: "Please CC the CEO on this thread" },
        basePattern,
      ),
    ).toBe(false);
  });

  it("returns false when body contains 'data breach'", () => {
    expect(
      shouldAutoAcknowledge(
        {
          ...baseTicket,
          body: "We may be looking at a Data Breach situation",
        },
        basePattern,
      ),
    ).toBe(false);
  });

  it("returns false when body contains 'refund'", () => {
    expect(
      shouldAutoAcknowledge(
        { ...baseTicket, body: "I want a full refund please" },
        basePattern,
      ),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* generateAutoAcknowledge                                              */
/* ------------------------------------------------------------------ */

describe("generateAutoAcknowledge", () => {
  it("calls the AI client with cheap tier + correct system prompt + auto_ack feature", async () => {
    await generateAutoAcknowledge(baseTicket, basePattern);
    expect(mockAIComplete).toHaveBeenCalledTimes(1);
    const call = mockAIComplete.mock.calls[0][0];
    expect(call.model_tier).toBe("cheap");
    expect(call.metadata).toEqual({ feature: "support.auto_ack" });
    expect(call.system).toMatch(/NEVER assert facts/);
    expect(call.system).toMatch(/NEVER claim a fix/);
    expect(call.system).toMatch(/Wolfpack Team/);
  });

  it("returns subject prefixed 'Re: <ticket.title>' for threading", async () => {
    const out = await generateAutoAcknowledge(baseTicket, basePattern);
    expect(out.subject).toBe("Re: Cannot sign in to Outlook");
  });

  it("returns the AI body when no forbidden phrases present", async () => {
    const out = await generateAutoAcknowledge(baseTicket, basePattern);
    expect(out.body).toMatch(/Wolfpack Team/);
  });

  it("falls back to safe generic body when AI output trips the forbidden-phrase guard", async () => {
    mockAIComplete.mockResolvedValueOnce({
      content:
        "Hi, your account is locked due to repeated failures. Please wait.\n\nThe Wolfpack Team",
      model_used: "x",
      provider_used: "x",
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: 0,
      latency_ms: 1,
    });
    const out = await generateAutoAcknowledge(baseTicket, basePattern);
    expect(out.body).not.toMatch(/your account is locked/i);
    expect(out.body).toMatch(/We received your message/i);
  });

  it("falls back to safe generic body when the AI throws", async () => {
    mockAIComplete.mockRejectedValueOnce(new Error("ai down"));
    const out = await generateAutoAcknowledge(baseTicket, basePattern);
    expect(out.body).toMatch(/We received your message/i);
  });

  it("falls back to safe generic body when the AI returns empty content", async () => {
    mockAIComplete.mockResolvedValueOnce({
      content: "",
      model_used: "x",
      provider_used: "x",
      input_tokens: 1,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: 1,
    });
    const out = await generateAutoAcknowledge(baseTicket, basePattern);
    expect(out.body).toMatch(/We received your message/i);
  });

  it("returns cached body and DOES NOT call AI when the cache hits", async () => {
    mockLookupCachedResponse.mockResolvedValueOnce({
      hit: true,
      cache_id: "cached-ack-1",
      cached: {
        content:
          "Hi there,\n\nThanks for reaching out. A team member will follow up.\n\nThe Wolfpack Team",
        model_used: "gpt-4o-mini",
        provider_used: "cache",
        input_tokens: 200,
        output_tokens: 80,
        cost_usd: 0,
        latency_ms: 0,
      },
    });
    const out = await generateAutoAcknowledge(baseTicket, basePattern);
    expect(out.cache_id).toBe("cached-ack-1");
    expect(out.body).toMatch(/Wolfpack Team/);
    expect(mockAIComplete).not.toHaveBeenCalled();
    expect(mockCacheResponse).not.toHaveBeenCalled();
  });

  it("calls AI on a cache miss and writes the result to the cache", async () => {
    mockLookupCachedResponse.mockResolvedValueOnce({ hit: false });
    /* Default beforeEach AI mock returns a clean ack body. */
    mockCacheResponse.mockResolvedValueOnce({ cache_id: "fresh-ack-1" });
    const out = await generateAutoAcknowledge(baseTicket, basePattern);
    expect(out.cache_id).toBe("fresh-ack-1");
    expect(mockAIComplete).toHaveBeenCalledTimes(1);
    expect(mockCacheResponse).toHaveBeenCalledTimes(1);
    const cacheArgs = mockCacheResponse.mock.calls[0][0];
    expect(cacheArgs.feature).toBe("support.auto_ack");
  });

  it("does NOT cache the safe fallback body", async () => {
    /* Force an AI throw → safe fallback. */
    mockLookupCachedResponse.mockResolvedValueOnce({ hit: false });
    mockAIComplete.mockRejectedValueOnce(new Error("ai down"));
    const out = await generateAutoAcknowledge(baseTicket, basePattern);
    expect(out.body).toMatch(/We received your message/i);
    /* Critical: never persist the fallback to the cache. */
    expect(mockCacheResponse).not.toHaveBeenCalled();
    expect(out.cache_id).toBeNull();
  });

  it("treats a cache hit that trips the forbidden-phrase guard as a miss + falls through to AI", async () => {
    mockLookupCachedResponse.mockResolvedValueOnce({
      hit: true,
      cache_id: "stale-ack-1",
      cached: {
        content:
          "Hi, your account is locked. Wait.\n\nThe Wolfpack Team",
        model_used: "x",
        provider_used: "cache",
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0,
        latency_ms: 0,
      },
    });
    /* Default fresh AI mock from beforeEach returns a clean body. */
    mockCacheResponse.mockResolvedValueOnce({ cache_id: "fresh-ack-2" });
    const out = await generateAutoAcknowledge(baseTicket, basePattern);
    expect(out.body).not.toMatch(/your account is locked/i);
    /* AI was called precisely because the cached body failed the guard. */
    expect(mockAIComplete).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* sendAutoAcknowledge                                                  */
/* ------------------------------------------------------------------ */

describe("sendAutoAcknowledge", () => {
  it("POSTs to Graph /me/messages/<id>/reply with comment + toRecipients override", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 202 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await sendAutoAcknowledge("tk-1", baseTicket, {
      subject: "Re: ...",
      body: "Hello there",
    });

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.messageId).toMatch(/^auto-ack:tk-1:/);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/AAMkAD-msg-1/reply",
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const sentBody = JSON.parse(String(init.body));
    expect(sentBody.comment).toBe("Hello there");
    expect(sentBody.message.toRecipients[0].emailAddress.address).toBe(
      "user@example.com",
    );
  });

  it("returns ok:false with error='no_token' when service identity has no token", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const out = await sendAutoAcknowledge("tk-1", baseTicket, {
      subject: "x",
      body: "y",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected !ok");
    expect(out.error).toBe("no_token");
  });

  it("returns ok:false on Graph 5xx and does not throw", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response("upstream broke", { status: 500 }),
      ) as unknown as typeof fetch;
    const out = await sendAutoAcknowledge("tk-1", baseTicket, {
      subject: "x",
      body: "y",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected !ok");
    expect(out.error).toMatch(/^graph_status_500/);
  });

  it("returns ok:false on Graph 401", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response("unauthorized", { status: 401 }),
      ) as unknown as typeof fetch;
    const out = await sendAutoAcknowledge("tk-1", baseTicket, {
      subject: "x",
      body: "y",
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected !ok");
    expect(out.error).toBe("graph_auth_401");
  });
});

/* ------------------------------------------------------------------ */
/* processAutoAcknowledge                                               */
/* ------------------------------------------------------------------ */

describe("processAutoAcknowledge", () => {
  it("happy path: ticket → pattern → gate passes → AI → send → DB updated → analytics fires", async () => {
    const out = await processAutoAcknowledge("tk-1");

    expect(out.acknowledged).toBe(true);
    expect(mockMarkAck).toHaveBeenCalledTimes(1);
    const markArgs = mockMarkAck.mock.calls[0];
    expect(markArgs[0]).toBe("tk-1");
    expect(markArgs[1].patternId).toBe("p-1");
    expect(markArgs[1].messageId).toMatch(/^auto-ack:tk-1:/);

    expect(mockAppendReply).toHaveBeenCalledTimes(1);
    const replyArgs = mockAppendReply.mock.calls[0];
    expect(replyArgs[0]).toBe("tk-1");
    expect(replyArgs[1].direction).toBe("outbound");
    expect(replyArgs[1].from_email).toBe("support@thewolfpack.agency");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "support.auto_acknowledged",
      "automation-cron",
      "system",
      expect.objectContaining({
        ticket_id: "tk-1",
        pattern_id: "p-1",
        char_count: expect.any(Number),
        latency_ms: expect.any(Number),
      }),
    );
  });

  it("returns acknowledged:false (gate_blocked) for an internal-audience ticket", async () => {
    mockGetTicket.mockResolvedValueOnce({ ...baseTicket, audience: "internal" });
    const out = await processAutoAcknowledge("tk-1");
    expect(out.acknowledged).toBe(false);
    expect(out.reason).toBe("gate_blocked");
    expect(mockAIComplete).not.toHaveBeenCalled();
    expect(mockMarkAck).not.toHaveBeenCalled();
  });

  it("returns acknowledged:false (already_acknowledged) when ticket already has auto_acknowledged_at", async () => {
    mockGetTicket.mockResolvedValueOnce({
      ...baseTicket,
      auto_acknowledged_at: "2026-04-27T01:00:00.000Z",
    });
    const out = await processAutoAcknowledge("tk-1");
    expect(out.acknowledged).toBe(false);
    expect(out.reason).toBe("already_acknowledged");
    expect(mockAIComplete).not.toHaveBeenCalled();
  });

  it("returns acknowledged:false when the matched pattern is NOT opted in to auto-ack", async () => {
    mockFindMatching.mockReturnValueOnce([
      { ...basePattern, auto_acknowledge_enabled: false },
    ]);
    const out = await processAutoAcknowledge("tk-1");
    expect(out.acknowledged).toBe(false);
    expect(out.reason).toBe("gate_blocked");
  });

  it("does NOT throw when the AI provider errors — falls through to the safe-fallback send + still acknowledges", async () => {
    mockAIComplete.mockRejectedValueOnce(new Error("ai upstream down"));
    /* Graph happy-path send is still set up by the beforeEach default. */
    const out = await processAutoAcknowledge("tk-1");
    /* The orchestrator treats the safe-fallback as a successful auto-ack
       — the customer still got a reply. */
    expect(out.acknowledged).toBe(true);
  });

  it("logs but does not throw when the Graph send fails", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response("upstream broke", { status: 500 }),
      ) as unknown as typeof fetch;
    const out = await processAutoAcknowledge("tk-1");
    expect(out.acknowledged).toBe(false);
    expect(out.reason).toMatch(/^graph_status_500/);
    /* Persistence side effects must NOT have fired on a send failure. */
    expect(mockMarkAck).not.toHaveBeenCalled();
    expect(mockAppendReply).not.toHaveBeenCalled();
    /* obs.recordError fired so we can alert. */
    expect(mockRecordError).toHaveBeenCalled();
  });

  it("returns acknowledged:false when the ticket id is unknown", async () => {
    mockGetTicket.mockResolvedValueOnce(null);
    const out = await processAutoAcknowledge("missing");
    expect(out.acknowledged).toBe(false);
    expect(out.reason).toBe("ticket_not_found");
  });
});
