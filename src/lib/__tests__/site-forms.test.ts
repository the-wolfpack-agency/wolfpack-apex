/**
 * site-forms.ts — submitForm() logic tests.
 *
 * All external deps (safeQuery, trackEvent, getSite, listVerifiedDomains,
 * sendEmail, rateLimit) are injected via the `deps` seam so no DB /
 * Vercel / Resend call ever fires. Covers every FormSubmitReason branch
 * + the happy path + the honeypot decoy behavior.
 */

const safeQueryMock = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => safeQueryMock(...args),
}));

const trackMock = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => trackMock(...args),
}));

import {
  submitForm,
  normalizeOrigin,
  buildAllowedOrigins,
  _resetRateLimit,
  HONEYPOT_FIELD,
  MAX_FIELDS,
  MAX_FIELD_LENGTH,
  type FormSubmitInput,
  type SiteProjectLite,
} from "@/lib/site-forms";

function mkSite(overrides: Partial<SiteProjectLite> = {}): SiteProjectLite {
  return {
    id: "site_1",
    client_slug: "acme",
    display_name: "Acme Inc",
    preview_url: "https://wolfpack-acme.vercel.app",
    brief: {
      client: "acme",
      product: { name: "Acme Inc" },
      pages: [{ route: "/", sections: [] }],
      contactForm: {
        fields: ["name", "email", "message"],
        recipientEmail: "leads@acme.com",
      },
    },
    ...overrides,
  };
}

function mkInput(overrides: Partial<FormSubmitInput> = {}): FormSubmitInput {
  const base = {
    siteId: "site_1",
    origin: "https://wolfpack-acme.vercel.app",
    ipHash: "hash_default",
    userAgent: "jest",
    payload: {
      name: "Jane",
      email: "jane@example.com",
      message: "hello",
    } as Record<string, string>,
  };
  return {
    ...base,
    ...overrides,
    deps: {
      getSite: jest.fn(async () => mkSite()),
      listVerifiedDomains: jest.fn(async () => []),
      sendEmail: jest.fn(async () => {}),
      rateLimitCheck: jest.fn(async () => ({ allowed: true })),
      now: () => 1700000000000,
      ...(overrides.deps ?? {}),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimit();
  safeQueryMock.mockResolvedValue({ rows: [] });
});

describe("normalizeOrigin", () => {
  it("strips scheme + trailing slash + lowercases", () => {
    expect(normalizeOrigin("HTTPS://Foo.COM/")).toBe("foo.com");
  });
  it("returns null for empty / undefined", () => {
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
  });
  it("handles bare hosts", () => {
    expect(normalizeOrigin("acme.com")).toBe("acme.com");
  });
  it("preserves ports (differentiating test servers)", () => {
    expect(normalizeOrigin("https://foo.com:8443")).toBe("foo.com:8443");
  });
});

describe("buildAllowedOrigins", () => {
  it("combines preview_url + verified custom domains, lowercased", () => {
    const site = mkSite({ preview_url: "https://WP-Acme.vercel.app/" });
    const allowed = buildAllowedOrigins(site, ["Acme.com", "blog.Acme.com"]);
    expect(Array.from(allowed).sort()).toEqual([
      "acme.com",
      "blog.acme.com",
      "wp-acme.vercel.app",
    ]);
  });
  it("skips null preview_url gracefully", () => {
    const site = mkSite({ preview_url: null });
    const allowed = buildAllowedOrigins(site, ["acme.com"]);
    expect(Array.from(allowed)).toEqual(["acme.com"]);
  });
});

describe("submitForm — happy path", () => {
  it("returns ok + submissionId, inserts row, tracks site.form_submitted, sends email", async () => {
    const input = mkInput();
    const res = await submitForm(input);
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("ok");
    expect(res.submissionId).toBeTruthy();
    expect(res.fieldCount).toBe(3);

    // Insert was attempted
    const inserts = safeQueryMock.mock.calls.filter((c) =>
      /INSERT INTO apex_site_form_submissions/i.test(c[0] as string),
    );
    expect(inserts).toHaveLength(1);

    // trackEvent fired with site.form_submitted (no recipient in plaintext)
    const submittedEvents = trackMock.mock.calls.filter(
      (c) => c[0] === "site.form_submitted",
    );
    expect(submittedEvents).toHaveLength(1);
    const meta = submittedEvents[0][3] as Record<string, unknown>;
    expect(meta.had_recipient).toBe(true);
    expect(JSON.stringify(meta)).not.toContain("leads@acme.com");

    // sendEmail was invoked with the recipient
    expect(input.deps?.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("submitForm — rejections", () => {
  it("site_not_found when getSite returns null", async () => {
    const input = mkInput({
      deps: { getSite: async () => null },
    });
    const res = await submitForm(input);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("site_not_found");
    expect(trackMock).toHaveBeenCalledWith(
      "site.form_rejected",
      "public",
      "public",
      expect.objectContaining({ reason: "site_not_found" }),
    );
  });

  it("no_contact_form when brief has no contactForm", async () => {
    const input = mkInput({
      deps: {
        getSite: async () => {
          const s = mkSite();
          s.brief = { ...s.brief, contactForm: undefined };
          return s;
        },
      },
    });
    const res = await submitForm(input);
    expect(res.reason).toBe("no_contact_form");
  });

  it("no_recipient when contactForm has no recipientEmail", async () => {
    const input = mkInput({
      deps: {
        getSite: async () => {
          const s = mkSite();
          s.brief = {
            ...s.brief,
            contactForm: { fields: ["name"] },
          };
          return s;
        },
      },
    });
    const res = await submitForm(input);
    expect(res.reason).toBe("no_recipient");
  });

  it("origin_not_allowed when Origin is not in the allowlist", async () => {
    const input = mkInput({
      origin: "https://evil.example.com",
    });
    const res = await submitForm(input);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("origin_not_allowed");
  });

  it("accepts a verified custom domain origin", async () => {
    const input = mkInput({
      origin: "https://acme.com",
      deps: {
        getSite: async () => mkSite(),
        listVerifiedDomains: async () => ["acme.com"],
        sendEmail: async () => {},
        rateLimitCheck: async () => ({ allowed: true }),
      },
    });
    const res = await submitForm(input);
    expect(res.reason).toBe("ok");
    expect(res.acceptedOrigin).toBe("acme.com");
  });

  it("normalizes trailing slash + case in Origin", async () => {
    const input = mkInput({ origin: "HTTPS://Wolfpack-Acme.vercel.app/" });
    const res = await submitForm(input);
    expect(res.reason).toBe("ok");
  });

  it("rate_limited returns retryAfterSec", async () => {
    const input = mkInput({
      deps: {
        getSite: async () => mkSite(),
        rateLimitCheck: async () => ({ allowed: false, retryAfterSec: 400 }),
      },
    });
    const res = await submitForm(input);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("rate_limited");
    expect(res.retryAfterSec).toBe(400);
  });

  it("missing_required_field when a declared field is absent", async () => {
    const input = mkInput({ payload: { name: "Jane", email: "j@x.com" } });
    const res = await submitForm(input);
    expect(res.reason).toBe("missing_required_field");
  });

  it("missing_required_field when a declared field is empty string", async () => {
    const input = mkInput({
      payload: { name: "Jane", email: "j@x.com", message: "   " },
    });
    const res = await submitForm(input);
    expect(res.reason).toBe("missing_required_field");
  });

  it("unexpected_field when an undeclared field is present", async () => {
    const input = mkInput({
      payload: {
        name: "Jane",
        email: "j@x.com",
        message: "hello",
        extra: "nope",
      },
    });
    const res = await submitForm(input);
    expect(res.reason).toBe("unexpected_field");
  });

  it("too_many_fields when >MAX_FIELDS keys", async () => {
    const payload: Record<string, string> = {};
    for (let i = 0; i < MAX_FIELDS + 1; i++) payload[`f${i}`] = "x";
    const input = mkInput({ payload });
    const res = await submitForm(input);
    expect(res.reason).toBe("too_many_fields");
  });

  it("field_too_long when a value exceeds MAX_FIELD_LENGTH", async () => {
    const input = mkInput({
      payload: {
        name: "Jane",
        email: "j@x.com",
        message: "x".repeat(MAX_FIELD_LENGTH + 1),
      },
    });
    const res = await submitForm(input);
    expect(res.reason).toBe("field_too_long");
  });
});

describe("submitForm — honeypot trickery", () => {
  it("returns ok=true when honeypot is filled, persists row with spam_score=100", async () => {
    const input = mkInput({
      payload: {
        name: "Jane",
        email: "j@x.com",
        message: "hello",
        [HONEYPOT_FIELD]: "I'm a bot",
      },
    });
    const res = await submitForm(input);
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("honeypot_tripped");
    expect(res.spamScore).toBe(100);

    // Row WAS persisted (for learning-loop signal), with email_status='throttled'
    const insertCall = safeQueryMock.mock.calls.find((c) =>
      /INSERT INTO apex_site_form_submissions/i.test(c[0] as string),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // email_status is the 8th placeholder, spam_score is the 10th
    expect(params[7]).toBe("throttled");
    expect(params[9]).toBe(100);

    // sendEmail was NOT invoked
    expect(input.deps?.sendEmail).not.toHaveBeenCalled();

    // site.form_rejected fired (honeypot is a rejection even though
    // we return ok=true to the caller to fool the bot)
    expect(trackMock).toHaveBeenCalledWith(
      "site.form_rejected",
      "public",
      "public",
      expect.objectContaining({ reason: "honeypot_tripped" }),
    );
  });

  it("whitespace-only honeypot is NOT tripped", async () => {
    const input = mkInput({
      payload: {
        name: "Jane",
        email: "j@x.com",
        message: "hello",
        [HONEYPOT_FIELD]: "   ",
      },
    });
    const res = await submitForm(input);
    expect(res.reason).toBe("ok");
  });
});

describe("submitForm — analytics + privacy", () => {
  it("never logs recipient email plaintext in any trackEvent metadata", async () => {
    const input = mkInput();
    await submitForm(input);
    for (const call of trackMock.mock.calls) {
      const meta = call[3] as Record<string, unknown>;
      expect(JSON.stringify(meta)).not.toContain("leads@acme.com");
    }
  });

  it("origin normalization applied to trackEvent metadata", async () => {
    const input = mkInput({
      origin: "HTTPS://Wolfpack-Acme.vercel.app/",
    });
    await submitForm(input);
    const submitted = trackMock.mock.calls.find(
      (c) => c[0] === "site.form_submitted",
    );
    expect(submitted).toBeDefined();
    const meta = submitted![3] as Record<string, unknown>;
    expect(meta.origin).toBe("wolfpack-acme.vercel.app");
  });
});
