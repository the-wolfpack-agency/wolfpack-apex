 
/**
 * /api/assistant — ServerResponse shape contract.
 *
 * Documents the exact JSON shape the POST handler returns on a
 * successful chat. The UI layer reads these fields directly; a
 * rename or type drift here is a silent UI break.
 *
 * Contract (locked):
 *   response:        string
 *   answer?:         string              (mirrors response; tool path
 *                                         sets both, chat path sets
 *                                         only response)
 *   source:          string
 *   tokensUsed:      number
 *   conversationId:  string | null
 *   sources?:        Array<{ id: string; title: string; url: string;
 *                            type: string }>
 *   relatedPages?:   Array<{ domain: string; label: string;
 *                            href: string }>
 */

const mockChat = jest.fn();
const mockTryTool = jest.fn();
const mockClassifyIntent = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/assistant", () => ({
  chat: (...a: any[]) => mockChat(...a),
  getConversations: jest.fn(),
  getConversationMessages: jest.fn(),
  rateMessage: jest.fn(),
  archiveConversation: jest.fn(),
}));
jest.mock("@/lib/assistant/orchestrator", () => ({
  tryToolAnswer: (...a: any[]) => mockTryTool(...a),
  classifyIntent: (...a: any[]) => mockClassifyIntent(...a),
}));
jest.mock("@/lib/doc-quality-gate", () => ({
  checkDocQuality: jest.fn(),
  trackGateResult: jest.fn(),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => ({ id: "u1", role: "ceo", name: "N", email: "n@x.co" }),
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

// Runtime type assertions — one per field — so a field-rename or
// null-vs-undefined drift breaks the build loudly.
function assertString(v: unknown, path: string): void {
  expect(typeof v === "string").toBe(true);
  if (typeof v !== "string") throw new Error(`${path} not string`);
}
function assertNumber(v: unknown, path: string): void {
  expect(typeof v === "number" && Number.isFinite(v)).toBe(true);
  if (typeof v !== "number") throw new Error(`${path} not number`);
}
function assertStringOrNull(v: unknown, path: string): void {
  expect(v === null || typeof v === "string").toBe(true);
  if (!(v === null || typeof v === "string")) throw new Error(`${path} not string|null`);
}
function assertSourceRow(row: any, idx: number): void {
  const p = `sources[${idx}]`;
  assertString(row.id, `${p}.id`);
  assertString(row.title, `${p}.title`);
  assertString(row.url, `${p}.url`);
  assertString(row.type, `${p}.type`);
}
function assertRelatedPageRow(row: any, idx: number): void {
  const p = `relatedPages[${idx}]`;
  assertString(row.domain, `${p}.domain`);
  assertString(row.label, `${p}.label`);
  assertString(row.href, `${p}.href`);
  expect(row.href.startsWith("/")).toBe(true);
}

beforeEach(() => {
  mockChat.mockReset();
  mockTryTool.mockReset();
  mockClassifyIntent.mockReset();
  mockTrackEvent.mockReset();
  mockClassifyIntent.mockReturnValue({ intent: "unknown", confidence: 0, slots: {} });
});

describe("POST /api/assistant — ServerResponse shape", () => {
  test("chat path: response/source/tokensUsed/conversationId all typed", async () => {
    mockChat.mockResolvedValue({
      response: "typed answer",
      source: "ai",
      tokensUsed: 12,
      conversationId: "c-shape-1",
      messageId: "m-shape-1",
    });

    const res = await POST(postMessage("shape me"));
    expect(res.status).toBe(200);
    const body: any = await res.json();

    assertString(body.response, "response");
    assertString(body.source, "source");
    assertNumber(body.tokensUsed, "tokensUsed");
    assertStringOrNull(body.conversationId, "conversationId");

    // sources / relatedPages are optional on this path (may be absent
    // when chat() returned none). When present, each row must type-
    // check.
    if (body.sources !== undefined) {
      expect(Array.isArray(body.sources)).toBe(true);
      body.sources.forEach(assertSourceRow);
    }
    if (body.relatedPages !== undefined) {
      expect(Array.isArray(body.relatedPages)).toBe(true);
      body.relatedPages.forEach(assertRelatedPageRow);
    }
  });

  test("tool path: answer mirrors response, sources[] typed, relatedPages[] typed", async () => {
    mockClassifyIntent.mockReturnValue({
      intent: "calendar_availability",
      confidence: 0.9,
      slots: {},
    });
    mockTryTool.mockResolvedValue({
      intent: "calendar_availability",
      answer: "You have one meeting today.",
      data: {},
      source: "tool",
    });

    const res = await POST(postMessage("today's meetings"));
    expect(res.status).toBe(200);
    const body: any = await res.json();

    assertString(body.response, "response");
    // Tool path is the only path that currently sets `answer` — we
    // pin that so the UI can rely on either field.
    assertString(body.answer, "answer");
    expect(body.answer).toBe(body.response);

    assertString(body.source, "source");
    assertNumber(body.tokensUsed, "tokensUsed");
    assertStringOrNull(body.conversationId, "conversationId");

    expect(Array.isArray(body.sources)).toBe(true);
    expect(body.sources.length).toBeGreaterThan(0);
    body.sources.forEach(assertSourceRow);

    expect(Array.isArray(body.relatedPages)).toBe(true);
    body.relatedPages.forEach(assertRelatedPageRow);
  });

  test("null conversationId is acceptable (new unsaved chat)", async () => {
    mockChat.mockResolvedValue({
      response: "fresh",
      source: "ai",
      tokensUsed: 3,
      conversationId: null as any,
      messageId: null as any,
    });

    const res = await POST(postMessage("new thread"));
    const body: any = await res.json();
    assertStringOrNull(body.conversationId, "conversationId");
  });
});
