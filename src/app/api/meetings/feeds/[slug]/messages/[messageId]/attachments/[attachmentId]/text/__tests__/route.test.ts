 
/**
 * GET /api/meetings/feeds/[slug]/messages/[messageId]/attachments/[attachmentId]/text
 *
 * Locks: 401 unauth, 404 not-found, 200 returns the canonical
 * { text, status, filename, mime, size_bytes } shape.
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

function req(): NextRequest {
  return new NextRequest(
    "https://x.test/api/meetings/feeds/weekly-standup/messages/msg-123/attachments/att-456/text",
    { method: "GET", headers: { authorization: "Bearer x" } },
  );
}

beforeEach(() => {
  mockGet.mockReset();
  mockRequireCapability.mockReset();
  mockTrackEvent.mockReset();
});

describe("GET attachments/[id]/text", () => {
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

  test("requireCapability is called with 'meetings.view'", async () => {
    mockRequireCapability.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(mockRequireCapability).toHaveBeenCalledWith(
      expect.anything(),
      "meetings.view",
    );
  });

  test("404 when attachment missing", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockGet.mockResolvedValue(null);
    const res = await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(res.status).toBe(404);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  test("200 returns canonical text payload", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockGet.mockResolvedValue({
      id: "att-456",
      message_id: "msg-123",
      feed_slug: "weekly-standup",
      filename: "agenda.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size_bytes: 1234,
      extracted_text: "Q2 goals\n- ship",
      extraction_status: "extracted",
      bytes: null,
    });
    const res = await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      text: "Q2 goals\n- ship",
      status: "extracted",
      filename: "agenda.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size_bytes: 1234,
    });
  });

  test("200 surfaces unsupported_mime cleanly (text:null)", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockGet.mockResolvedValue({
      id: "att-456",
      message_id: "msg-123",
      feed_slug: "weekly-standup",
      filename: "img.png",
      mime: "image/png",
      size_bytes: 8192,
      extracted_text: null,
      extraction_status: "unsupported_mime",
      bytes: null,
    });
    const res = await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBeNull();
    expect(body.status).toBe("unsupported_mime");
  });

  test("fires meeting_insights.attachment_text_viewed on success", async () => {
    mockRequireCapability.mockResolvedValue({ ok: true, user: USER, capabilities: new Set() });
    mockGet.mockResolvedValue({
      id: "att-456",
      message_id: "msg-123",
      feed_slug: "weekly-standup",
      filename: "x.txt",
      mime: "text/plain",
      size_bytes: 5,
      extracted_text: "hi",
      extraction_status: "extracted",
      bytes: null,
    });
    await GET(req(), { params: Promise.resolve(PARAMS) });
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [event, uid, role, meta] = mockTrackEvent.mock.calls[0];
    expect(event).toBe("meeting_insights.attachment_text_viewed");
    expect(uid).toBe(USER.id);
    expect(role).toBe(USER.role);
    expect(meta).toMatchObject({
      feed_slug: "weekly-standup",
      message_id: "msg-123",
      attachment_id: "att-456",
      extraction_status: "extracted",
      mime: "text/plain",
    });
  });
});
