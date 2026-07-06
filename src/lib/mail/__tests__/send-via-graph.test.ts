/**
 * Unit tests for sendViaGraph — Microsoft Graph app-only Mail.Send wrapper.
 */

const mockGetAppOnlyToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getAppOnlyToken: (...a: any[]) => mockGetAppOnlyToken(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

const realFetch = global.fetch;

import { sendViaGraph, isGraphMailConfigured } from "@/lib/mail/send-via-graph";

const ARGS = {
  to: "max@thewolfpack.agency",
  subject: "Test",
  text: "Plain body",
  html: "<p>HTML body</p>",
};

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn() as any;
  delete process.env.MS_MAIL_FROM;
  delete process.env.MS_MAIL_FROM_NAME;
});

afterAll(() => {
  global.fetch = realFetch;
});

describe("isGraphMailConfigured", () => {
  it("false when MS_MAIL_FROM unset", () => {
    expect(isGraphMailConfigured()).toBe(false);
  });
  it("false when MS_MAIL_FROM has no @ (defensive against bad env)", () => {
    process.env.MS_MAIL_FROM = "nomail";
    expect(isGraphMailConfigured()).toBe(false);
  });
  it("true when MS_MAIL_FROM looks like an email", () => {
    process.env.MS_MAIL_FROM = "noreply@thewolfpack.agency";
    expect(isGraphMailConfigured()).toBe(true);
  });
});

describe("sendViaGraph", () => {
  it("no_mail_from when MS_MAIL_FROM is unset — never calls Graph", async () => {
    const result = await sendViaGraph(ARGS);
    expect(result).toEqual({ delivered: false, reason: "no_mail_from" });
    expect(mockGetAppOnlyToken).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("no_app_token when app-only token can't be acquired (env or consent missing)", async () => {
    process.env.MS_MAIL_FROM = "noreply@thewolfpack.agency";
    mockGetAppOnlyToken.mockResolvedValueOnce(null);
    const result = await sendViaGraph(ARGS);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no_app_token");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("delivered: true on Graph 202 Accepted", async () => {
    process.env.MS_MAIL_FROM = "noreply@thewolfpack.agency";
    mockGetAppOnlyToken.mockResolvedValueOnce("app-token");
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 202,
      text: () => Promise.resolve(""),
    } as any);

    const result = await sendViaGraph(ARGS);
    expect(result).toEqual({ delivered: true, reason: "ok" });

    const [calledUrl, calledInit] = (global.fetch as jest.Mock).mock.calls[0];
    expect(calledUrl).toBe(
      "https://graph.microsoft.com/v1.0/users/noreply%40thewolfpack.agency/sendMail",
    );
    expect(calledInit.method).toBe("POST");
    expect(calledInit.headers.Authorization).toBe("Bearer app-token");
    const body = JSON.parse(calledInit.body);
    expect(body.message.toRecipients[0].emailAddress.address).toBe(ARGS.to);
    expect(body.message.from.emailAddress.address).toBe("noreply@thewolfpack.agency");
    expect(body.message.body.contentType).toBe("HTML");
    expect(body.message.body.content).toBe(ARGS.html);
    expect(body.saveToSentItems).toBe(true);
  });

  it("scope_missing on Graph 403 — surfaces the Mail.Send consent hint", async () => {
    process.env.MS_MAIL_FROM = "noreply@thewolfpack.agency";
    mockGetAppOnlyToken.mockResolvedValueOnce("app-token");
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 403,
      text: () => Promise.resolve("ErrorAccessDenied: Mail.Send not granted"),
    } as any);

    const result = await sendViaGraph(ARGS);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("scope_missing");
    expect(result.detail).toMatch(/Mail\.Send not granted/);
  });

  it("provider_error on any other non-202 (e.g. 500)", async () => {
    process.env.MS_MAIL_FROM = "noreply@thewolfpack.agency";
    mockGetAppOnlyToken.mockResolvedValueOnce("app-token");
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 500,
      text: () => Promise.resolve("Internal error"),
    } as any);

    const result = await sendViaGraph(ARGS);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("provider_error");
    expect(result.detail).toContain("500");
  });

  it("provider_error on network failure — never throws to caller", async () => {
    process.env.MS_MAIL_FROM = "noreply@thewolfpack.agency";
    mockGetAppOnlyToken.mockResolvedValueOnce("app-token");
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("ECONNRESET"));

    const result = await sendViaGraph(ARGS);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("provider_error");
    expect(result.detail).toMatch(/ECONNRESET/);
  });

  it("honors MS_MAIL_FROM_NAME for the from-envelope display", async () => {
    process.env.MS_MAIL_FROM = "noreply@thewolfpack.agency";
    process.env.MS_MAIL_FROM_NAME = "Wolfpack Agency";
    mockGetAppOnlyToken.mockResolvedValueOnce("app-token");
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 202,
      text: () => Promise.resolve(""),
    } as any);

    await sendViaGraph(ARGS);
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.message.from.emailAddress.name).toBe("Wolfpack Agency");
  });
});

describe("sendViaGraph — undeliverable seed-recipient chokepoint", () => {
  it("refuses to send to a seed domain even when fully configured", async () => {
    // Fully configured: MS_MAIL_FROM set and a token available. The guard must
    // still short-circuit BEFORE any Graph call — this is the last line of
    // defense against the cto@wolfpack.dev bounce class (6 DSNs 2026-07-04).
    process.env.MS_MAIL_FROM = "noreply@thewolfpack.agency";
    mockGetAppOnlyToken.mockResolvedValue("app-token");

    const result = await sendViaGraph({ ...ARGS, to: "cto@wolfpack.dev" });

    expect(result).toEqual({ delivered: false, reason: "seed_recipient" });
    expect(mockGetAppOnlyToken).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("records mail.seed_recipient_skipped so the learning loop sees demand", async () => {
    process.env.MS_MAIL_FROM = "noreply@thewolfpack.agency";
    await sendViaGraph({ ...ARGS, to: "ceo@wolfpack.dev" });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "mail.seed_recipient_skipped",
      "system",
      "system",
      expect.objectContaining({ to: "ceo@wolfpack.dev", domain: "wolfpack.dev" }),
    );
  });

  it("does NOT flag a real recipient — no false positives, delivers normally", async () => {
    process.env.MS_MAIL_FROM = "noreply@thewolfpack.agency";
    mockGetAppOnlyToken.mockResolvedValueOnce("app-token");
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      status: 202,
      text: () => Promise.resolve(""),
    } as any);

    const result = await sendViaGraph({ ...ARGS, to: "max@thewolfpack.agency" });

    expect(result).toEqual({ delivered: true, reason: "ok" });
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "mail.seed_recipient_skipped",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
