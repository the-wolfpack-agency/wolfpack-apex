/**
 * cleanMailSnippet — UI noise scrubber for MS Graph bodyPreview.
 *
 * Every case here comes from a real bodyPreview pattern observed on
 * wolfpack-instinct.vercel.app. The fixtures mirror the mobile
 * screenshot from 2026-04-22.
 */

import { cleanMailSnippet } from "@/lib/mail/snippet";

describe("cleanMailSnippet", () => {
  test("returns empty string for null / undefined / empty input", () => {
    expect(cleanMailSnippet(null)).toBe("");
    expect(cleanMailSnippet(undefined)).toBe("");
    expect(cleanMailSnippet("")).toBe("");
  });

  test("passes clean messages through unchanged", () => {
    expect(cleanMailSnippet("Confirmed for Tuesday.")).toBe(
      "Confirmed for Tuesday.",
    );
  });

  test("collapses whitespace", () => {
    expect(cleanMailSnippet("  hello\n\n  world  ")).toBe("hello world");
  });

  test("truncates with ellipsis past maxLen", () => {
    const long = "a".repeat(300);
    const out = cleanMailSnippet(long, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("…")).toBe(true);
  });

  test("cuts the Outlook underscore divider (Teams invite below)", () => {
    const raw =
      "Hi Kate, Looking forward to chatting through the proposed program. " +
      "Regrds, Jorge ________________________________ Microsoft Teams meeting Join: https://teams.microsoft.com/meet/xxx p=";
    expect(cleanMailSnippet(raw)).toBe(
      "Hi Kate, Looking forward to chatting through the proposed program. Regrds, Jorge",
    );
  });

  test("cuts 'Microsoft Teams meeting' footer even without a divider", () => {
    const raw =
      "Agenda attached. Microsoft Teams meeting Join: https://teams.microsoft.com/meet/xxx";
    expect(cleanMailSnippet(raw)).toBe("Agenda attached.");
  });

  test("cuts 'Get Outlook for iOS' mobile footer", () => {
    const raw = "Those look great, thank you! 9159778936 Get Outlook for iOS";
    expect(cleanMailSnippet(raw)).toBe(
      "Those look great, thank you! 9159778936",
    );
  });

  test("cuts 'Sent from my iPhone' footer", () => {
    expect(
      cleanMailSnippet("Sounds good — will send tomorrow. Sent from my iPhone"),
    ).toBe("Sounds good — will send tomorrow.");
  });

  test("cuts quoted-reply 'From: ... Sent: ...' header block", () => {
    const raw =
      "Those look great, thank you! " +
      "From: Alicia Zulker <alicia@thewolfpack.agency> Sent: Tuesday, April 21, 2026 4:52:34 PM " +
      "To: Nick Homyk <homyk@thewolfpack.agency>";
    expect(cleanMailSnippet(raw)).toBe("Those look great, thank you!");
  });

  test("cuts inline 'On <date>, <name> wrote:' reply marker", () => {
    const raw =
      "Confirming Thursday at 3. On Mon, Apr 20, 2026 at 4:52 PM, Alicia wrote: earlier stuff";
    expect(cleanMailSnippet(raw)).toBe("Confirming Thursday at 3.");
  });

  test("takes the EARLIEST cut when multiple patterns match", () => {
    const raw =
      "Short reply. " +
      "From: Alicia Zulker <x@y.com> Sent: Tuesday " +
      "________________________________ Microsoft Teams meeting";
    expect(cleanMailSnippet(raw)).toBe("Short reply.");
  });

  test("falls back to trimmed original if scrubbing leaves empty string", () => {
    // Pathological: message starts with a divider. Real preview is
    // just boilerplate. We should still surface SOMETHING, not blank.
    const raw = "________________________________ Microsoft Teams meeting Join: https://teams.microsoft.com/...";
    const out = cleanMailSnippet(raw, 60);
    expect(out.length).toBeGreaterThan(0);
    expect(out.startsWith("_")).toBe(true);
  });

  test("Re: Dallas Flights signature-block case from live prod", () => {
    const raw =
      "These look ok on Delta? If yes, please sign up for Sky Miles account and send me the number. Thanks! " +
      "Alicia Zulker Program Director The Wolfpack Agency +1.734.718.2974 alicia@thewolfpack.agency www.TheWolfpack.Agency " +
      "From: Nick Homyk <homyk@thewolfpack.agency> Sent: Tuesday, April 21, 2026 3:15 PM";
    // We keep the signature (hard to detect cleanly without false
    // positives) but drop the quoted reply header block. The user's
    // primary complaint was the quoted "From:/Sent:/To:" chain.
    expect(cleanMailSnippet(raw)).toBe(
      "These look ok on Delta? If yes, please sign up for Sky Miles account and send me the number. Thanks! " +
        "Alicia Zulker Program Director The Wolfpack Agency +1.734.718.2974 alicia@thewolfpack.agency www.TheWolfpack.Agency",
    );
  });
});
