/**
 * send-invite — payload + URL helpers.
 *
 * Pure-function tests. The defaultSendInviteEmail() Resend wrapper is
 * not exercised here because it relies on `fetch` + env state and is
 * already covered by the contract test on /api/team/invite via the
 * injectable mailer seam.
 */

import {
  buildAcceptUrl,
  buildInviteEmailBody,
  sendInviteEmail,
  type InviteEmailArgs,
} from "@/lib/mail/send-invite";

const ARGS: InviteEmailArgs = {
  to: "max@thewolfpack.agency",
  inviterName: "homyk",
  inviterEmail: "homyk@thewolfpack.agency",
  role: "ops",
  acceptUrl: "https://example.com/accept-invite?token=t",
};

describe("buildAcceptUrl", () => {
  const original = process.env.INSTINCT_PUBLIC_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.INSTINCT_PUBLIC_URL;
    else process.env.INSTINCT_PUBLIC_URL = original;
  });

  it("uses INSTINCT_PUBLIC_URL when set, strips trailing slash, encodes the token", () => {
    process.env.INSTINCT_PUBLIC_URL = "https://wolfpack-instinct.vercel.app/";
    const url = buildAcceptUrl("a b/c");
    expect(url).toBe("https://wolfpack-instinct.vercel.app/accept-invite?token=a%20b%2Fc");
  });

  it("falls back to the live alias when INSTINCT_PUBLIC_URL is unset", () => {
    delete process.env.INSTINCT_PUBLIC_URL;
    const url = buildAcceptUrl("xyz");
    expect(url).toBe("https://wolfpack-instinct.vercel.app/accept-invite?token=xyz");
  });
});

describe("buildInviteEmailBody", () => {
  it("uses a fixed product-centric subject line (not inviter-name-prefixed)", () => {
    // Pre-2026-05-20 the subject was "${inviterName} invited you to
    // Wolfpack Instinct" which produced "cto invited you..." when the
    // demo account did the invite. Fixed subject avoids that class of
    // ugly artifact and keeps inbox previews consistent.
    const body = buildInviteEmailBody(ARGS);
    expect(body.subject).toBe("You're invited to Wolfpack Instinct");
  });

  it("includes inviter name, inviter email, role label, and accept URL in body", () => {
    const body = buildInviteEmailBody(ARGS);
    expect(body.text).toContain("homyk");
    expect(body.text).toContain("homyk@thewolfpack.agency");
    expect(body.text).toContain(ARGS.acceptUrl);
    expect(body.html).toContain(ARGS.acceptUrl);
    expect(body.html).toContain("Wolfpack Instinct");
  });

  it("maps role codes to human-readable display labels", () => {
    expect(buildInviteEmailBody({ ...ARGS, role: "ops" }).text).toContain("Operations");
    expect(buildInviteEmailBody({ ...ARGS, role: "cto" }).text).toContain("Chief Technology Officer");
    expect(buildInviteEmailBody({ ...ARGS, role: "ceo" }).text).toContain("Chief Executive Officer");
    expect(buildInviteEmailBody({ ...ARGS, role: "dev" }).text).toContain("Developer");
    expect(buildInviteEmailBody({ ...ARGS, role: "hr" }).text).toContain("HR");
    expect(buildInviteEmailBody({ ...ARGS, role: "evp" }).text).toContain("Executive Vice President");
    expect(buildInviteEmailBody({ ...ARGS, role: "sales" }).text).toContain("Sales");
  });

  it("falls back to the raw role string when not in the display map (defensive)", () => {
    const body = buildInviteEmailBody({ ...ARGS, role: "custom-role" });
    expect(body.text).toContain("custom-role");
  });

  it("escapes HTML in inviter fields to prevent injection in the email", () => {
    const body = buildInviteEmailBody({
      ...ARGS,
      inviterName: '<script>alert(1)</script>',
      inviterEmail: 'a"&b@x.com',
    });
    expect(body.html).not.toContain("<script>alert(1)</script>");
    expect(body.html).toContain("&lt;script&gt;");
    expect(body.html).toContain("&quot;&amp;");
  });
});

describe("sendInviteEmail injection seam", () => {
  it("delegates to the injected sender and returns its result", async () => {
    const stub = jest.fn().mockResolvedValue({ delivered: true, reason: "ok" });
    const result = await sendInviteEmail(ARGS, stub);
    expect(stub).toHaveBeenCalledWith(ARGS);
    expect(result).toEqual({ delivered: true, reason: "ok" });
  });

  it("propagates non-delivery results without throwing", async () => {
    const stub = jest.fn().mockResolvedValue({ delivered: false, reason: "no_api_key" });
    const result = await sendInviteEmail(ARGS, stub);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no_api_key");
  });
});
