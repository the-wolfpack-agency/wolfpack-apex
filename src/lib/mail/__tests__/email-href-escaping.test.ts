/**
 * Every URL an email template puts in an href is escaped.
 *
 * Found by auditing the untrusted-content ratchet. All three templates escaped
 * the URL where it is DISPLAYED and emitted the same value raw inside
 * `href="..."`. Not exploitable today — the base comes from
 * INSTINCT_PUBLIC_URL, an env var, not from a request header — so this is a
 * latent defect rather than a live one, and it is fixed on that basis: the day
 * any of those URLs picks up a request-derived component, an unescaped href is
 * an attribute injection in an email that goes to everyone we invite.
 *
 * The inconsistency was the tell. A file that escapes a value in one place and
 * not another is not making a considered exception; it is missing one.
 */
import { buildInviteEmailBody, buildAcceptUrl } from "../send-invite";
import { buildResetEmailBody, buildResetUrl } from "../send-password-reset";

/** A URL carrying the characters that break out of an attribute. */
const HOSTILE = 'https://evil.test/a" onmouseover="alert(1)';

/** Every href="..." value in a fragment of HTML. */
function hrefValues(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

describe("invite email", () => {
  it("escapes the accept URL inside the href, not only where it is displayed", () => {
    const { html } = buildInviteEmailBody({
      acceptUrl: HOSTILE,
      inviterName: "Dana",
      inviterEmail: "dana@test",
      role: "member",
    } as Parameters<typeof buildInviteEmailBody>[0]);

    // The quote never survives as a quote, so the attribute cannot be closed.
    expect(html).not.toContain('href="https://evil.test/a" onmouseover');
    expect(html).toContain("&quot;");
    // And nothing after the payload became an attribute.
    expect(html).not.toMatch(/onmouseover\s*=\s*"/);
  });

  it("still produces a usable link for an ordinary URL", () => {
    const url = buildAcceptUrl("tok-123");
    const { html } = buildInviteEmailBody({
      acceptUrl: url,
      inviterName: "Dana",
      inviterEmail: "dana@test",
      role: "member",
    } as Parameters<typeof buildInviteEmailBody>[0]);
    // The guard must not break the ordinary case: the href is the real URL.
    expect(hrefValues(html)).toContain(url);
  });

  it("escapes the inviter's name, which is operator-supplied", () => {
    const { html } = buildInviteEmailBody({
      acceptUrl: buildAcceptUrl("t"),
      inviterName: '<img src=x onerror="alert(1)">',
      inviterEmail: "dana@test",
      role: "member",
    } as Parameters<typeof buildInviteEmailBody>[0]);
    expect(html).not.toMatch(/<img\s/i);
    expect(html).toContain("&lt;img");
  });
});

describe("password reset email", () => {
  it("escapes the reset URL inside the href", () => {
    const { html } = buildResetEmailBody({ resetUrl: HOSTILE, name: "Dana" } as Parameters<typeof buildResetEmailBody>[0]);
    expect(html).not.toContain('href="https://evil.test/a" onmouseover');
    expect(html).not.toMatch(/onmouseover\s*=\s*"/);
  });

  it("still links correctly for an ordinary URL", () => {
    const url = buildResetUrl("tok-abc");
    const { html } = buildResetEmailBody({ resetUrl: url, name: "Dana" } as Parameters<typeof buildResetEmailBody>[0]);
    expect(hrefValues(html)).toContain(url);
  });
});

describe("the pattern itself", () => {
  it("no email template emits a bare interpolation inside an href", () => {
    // The ratchet for this specific mistake. `href="${x}"` with no escaper is
    // the shape; catching it here means the next template cannot reintroduce it.
    const files = ["send-invite.ts", "send-password-reset.ts", "../agents/invite-email.ts"];
    for (const f of files) {
      const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", f), "utf-8");
      const bare = [...source.matchAll(/href="\$\{(?!escapeHtml)([^}]*)\}"/g)].map((m) => m[1]);
      expect({ file: f, bare }).toEqual({ file: f, bare: [] });
    }
  });
});
