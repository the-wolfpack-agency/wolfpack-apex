 
/**
 * GET /api/meetings/feeds/[slug]/messages/[messageId]/attachments/[attachmentId]/download
 *
 * Locks: 401 unauth, 404 not-found, 200 success with bytes + headers,
 * analytics fires on success only.
 */

const mockGet = jest.fn();
const mockRequireCapability = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/automations/meeting-insights/attachment-store", () => ({
  getAttachmentForServe: (...a: any[]) => mockGet(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

const USER = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co", created_at: "" };
const PARAMS = {
  slug: "weekly-standup",
  messageId: "msg-123",
  attachmentId: "att-456",
};

function req(url = "https://x.test/api/meetings/feeds/weekly-standup/messages/msg-123/attachments/att-456/download"): NextRequest {
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: "Bearer x" },
  });
}

beforeEach(() => {
  mockGet.mockReset();
  mockRequireCapability.mockReset();
  mockTrackEvent.mockReset();
});

describe("GET attachments/[id]/download", () => {
  test("401 when requireCapability rejects", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });
    const res = await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(res.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("requireCapability is called with 'meetings.export'", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(mockRequireCapability).toHaveBeenCalledWith(
      expect.anything(),
      "meetings.export",
    );
  });

  test("404 when attachment missing", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    mockGet.mockResolvedValue(null);
    const res = await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(res.status).toBe(404);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("404 when attachment row exists but bytes are null (Phase 2 object-storage gap)", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockGet.mockResolvedValue({
      id: "att-456",
      message_id: "msg-123",
      feed_slug: "weekly-standup",
      filename: "notes.txt",
      mime: "text/plain",
      size_bytes: 0,
      extracted_text: null,
      extraction_status: "extracted",
      bytes: null,
    });
    const res = await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(res.status).toBe(404);
  });

  test("200 returns bytes + Content-Type + Content-Disposition", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: true,
      user: USER,
      capabilities: new Set(),
    });
    const bytes = Buffer.from("hello world");
    mockGet.mockResolvedValue({
      id: "att-456",
      message_id: "msg-123",
      feed_slug: "weekly-standup",
      filename: "agenda.txt",
      mime: "text/plain",
      size_bytes: bytes.length,
      extracted_text: "hello world",
      extraction_status: "extracted",
      bytes,
    });
    const res = await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="agenda.txt"',
    );
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.toString("utf8")).toBe("hello world");
  });

  test("escapes filename quotes / strips CR-LF in Content-Disposition", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    const bytes = Buffer.from("x");
    mockGet.mockResolvedValue({
      id: "att-456",
      message_id: "msg-123",
      feed_slug: "weekly-standup",
      filename: 'evil"\r\nX-Header: hax".txt',
      mime: "text/plain",
      size_bytes: 1,
      extracted_text: null,
      extraction_status: "extracted",
      bytes,
    });
    const res = await GET(req(), { params: Promise.resolve(PARAMS) });
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).not.toContain("\r");
    expect(cd).not.toContain("\n");
    // Quote inside filename must be backslash-escaped.
    expect(cd).toMatch(/filename="evil\\"/);
  });

  test("falls back to application/octet-stream when mime is empty", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockGet.mockResolvedValue({
      id: "att-456",
      message_id: "msg-123",
      feed_slug: "weekly-standup",
      filename: "x.bin",
      mime: "",
      size_bytes: 1,
      extracted_text: null,
      extraction_status: "unsupported_mime",
      bytes: Buffer.from([0]),
    });
    const res = await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  test("fires meeting_insights.attachment_downloaded on success", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockGet.mockResolvedValue({
      id: "att-456",
      message_id: "msg-123",
      feed_slug: "weekly-standup",
      filename: "agenda.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size_bytes: 1024,
      extracted_text: "hi",
      extraction_status: "extracted",
      bytes: Buffer.from("X"),
    });
    await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [event, uid, role, meta] = mockTrackEvent.mock.calls[0];
    expect(event).toBe("meeting_insights.attachment_downloaded");
    expect(uid).toBe(USER.id);
    expect(role).toBe(USER.role);
    expect(meta).toMatchObject({
      feed_slug: "weekly-standup",
      message_id: "msg-123",
      attachment_id: "att-456",
      filename: "agenda.docx",
      size_bytes: 1024,
    });
  });
});
