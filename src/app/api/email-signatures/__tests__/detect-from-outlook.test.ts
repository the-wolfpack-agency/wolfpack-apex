 
const mockDetectText = jest.fn();
const mockDetectHtml = jest.fn();
const mockTrackEvent = jest.fn();
let authUser: { id: string; role: string; name: string; email: string } | null = {
  id: "u1",
  role: "ceo",
  name: "Nick",
  email: "n@x.co",
};

jest.mock("@/lib/email-signatures-detect", () => ({
  detectSignatureFromOutlook: (...a: any[]) => mockDetectText(...a),
  detectSignatureHtmlFromOutlook: (...a: any[]) => mockDetectHtml(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: () => authUser,
}));

import { NextRequest } from "next/server";
import { POST } from "../detect-from-outlook/route";

beforeEach(() => {
  mockDetectText.mockReset();
  mockDetectHtml.mockReset();
  mockTrackEvent.mockReset();
  authUser = { id: "u1", role: "ceo", name: "Nick", email: "n@x.co" };
});

function reqWith(
  body?: unknown,
  search?: string,
  auth: string = "Bearer x",
): NextRequest {
  const url = `https://wp.test/api/email-signatures/detect-from-outlook${search ?? ""}`;
  return new NextRequest(url, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("POST /api/email-signatures/detect-from-outlook", () => {
  test("401 when unauthenticated", async () => {
    authUser = null;
    const res = await POST(reqWith({}, undefined, ""));
    expect(res.status).toBe(401);
  });

  test("defaults to HTML detection", async () => {
    mockDetectHtml.mockResolvedValueOnce({
      ok: true,
      signature: {
        html: "<p>sig</p>",
        text: "sig",
        sampledCount: 5,
        matchedCount: 4,
        confidence: 0.8,
      },
    });
    const res = await POST(reqWith({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.signature.html).toBe("<p>sig</p>");
    expect(mockDetectHtml).toHaveBeenCalledWith("u1", {});
    expect(mockDetectText).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "microsoft.signature_detected",
      "u1",
      "ceo",
      expect.objectContaining({
        format: "html",
        sampled_count: 5,
        matched_count: 4,
      }),
    );
  });

  test("format=text routes to text detector", async () => {
    mockDetectText.mockResolvedValueOnce({
      ok: true,
      signature: {
        text: "sig",
        sampledCount: 3,
        matchedCount: 2,
        confidence: 0.66,
      },
    });
    const res = await POST(reqWith({ format: "text" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signature.text).toBe("sig");
    expect(mockDetectText).toHaveBeenCalledWith("u1", {});
    expect(mockDetectHtml).not.toHaveBeenCalled();
  });

  test("forwards top option from body", async () => {
    mockDetectHtml.mockResolvedValueOnce({
      ok: true,
      signature: {
        html: "<p>x</p>",
        text: "",
        sampledCount: 10,
        matchedCount: 0,
        confidence: 0,
      },
    });
    await POST(reqWith({ top: 10 }));
    expect(mockDetectHtml).toHaveBeenCalledWith("u1", { top: 10 });
  });

  test("returns ok:false with code on detect failure (no_sent_mail)", async () => {
    mockDetectHtml.mockResolvedValueOnce({
      ok: false,
      code: "no_sent_mail",
      message: "No sent messages found",
    });
    const res = await POST(reqWith({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("no_sent_mail");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "microsoft.signature_detected",
      "u1",
      "ceo",
      expect.objectContaining({ format: "html", failure_code: "no_sent_mail" }),
    );
  });

  test("scope_missing surfaces as ok:false code (so UI can prompt reconnect)", async () => {
    mockDetectHtml.mockResolvedValueOnce({
      ok: false,
      code: "scope_missing",
      message: "Mail.Read scope required",
    });
    const res = await POST(reqWith({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("scope_missing");
  });
});
