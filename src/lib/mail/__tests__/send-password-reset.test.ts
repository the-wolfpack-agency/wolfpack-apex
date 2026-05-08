/**
 * send-password-reset — payload + URL helpers (pure-function tests).
 */
import {
  buildResetUrl,
  buildResetEmailBody,
  sendResetEmail,
  type ResetEmailArgs,
} from "@/lib/mail/send-password-reset";

const ARGS: ResetEmailArgs = {
  to: "max@thewolfpack.agency",
  name: "Max",
  resetUrl: "https://example.com/reset-password?token=tok",
  expiresInMinutes: 15,
};

describe("buildResetUrl", () => {
  const original = process.env.INSTINCT_PUBLIC_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.INSTINCT_PUBLIC_URL;
    else process.env.INSTINCT_PUBLIC_URL = original;
  });

  it("uses INSTINCT_PUBLIC_URL + url-encodes token", () => {
    process.env.INSTINCT_PUBLIC_URL = "https://wolfpack-instinct.vercel.app/";
    expect(buildResetUrl("a/b c")).toBe(
      "https://wolfpack-instinct.vercel.app/reset-password?token=a%2Fb%20c",
    );
  });

  it("falls back to live alias when INSTINCT_PUBLIC_URL unset", () => {
    delete process.env.INSTINCT_PUBLIC_URL;
    expect(buildResetUrl("xyz")).toBe(
      "https://wolfpack-instinct.vercel.app/reset-password?token=xyz",
    );
  });
});

describe("buildResetEmailBody", () => {
  it("includes name, expiry, and reset URL in subject + text + html", () => {
    const body = buildResetEmailBody(ARGS);
    expect(body.subject).toContain("Wolfpack Instinct");
    expect(body.text).toContain("Hi Max");
    expect(body.text).toContain("15 minutes");
    expect(body.text).toContain(ARGS.resetUrl);
    expect(body.html).toContain(ARGS.resetUrl);
    expect(body.html).toContain("15 minutes");
  });

  it("escapes HTML in name to prevent injection", () => {
    const body = buildResetEmailBody({ ...ARGS, name: "<script>alert(1)</script>" });
    expect(body.html).not.toContain("<script>alert(1)</script>");
    expect(body.html).toContain("&lt;script&gt;");
  });
});

describe("sendResetEmail injection seam", () => {
  it("delegates to the injected sender", async () => {
    const stub = jest.fn().mockResolvedValue({ delivered: true, reason: "ok" });
    const result = await sendResetEmail(ARGS, stub);
    expect(stub).toHaveBeenCalledWith(ARGS);
    expect(result).toEqual({ delivered: true, reason: "ok" });
  });
});
