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
  it("includes inviter, role, and accept URL in subject + text + html", () => {
    const body = buildInviteEmailBody(ARGS);
    expect(body.subject).toContain("homyk");
    expect(body.subject).toContain("Wolfpack Instinct");
    expect(body.text).toContain("homyk@thewolfpack.agency");
    expect(body.text).toContain("ops");
    expect(body.text).toContain(ARGS.acceptUrl);
    expect(body.html).toContain(ARGS.acceptUrl);
    expect(body.html).toContain("Wolfpack Instinct");
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
