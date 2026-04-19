/**
 * sites-schema.ts — contactForm extension tests (migration 034).
 *
 * Verifies `validateBrief` accepts/rejects the new optional
 * contactForm fields (recipientEmail, subjectTemplate, notifySlack)
 * WITHOUT breaking any existing brief that omits them.
 */

import { validateBrief, BriefValidationError, type SiteBrief } from "@/lib/sites-schema";

function mk(overrides: Partial<SiteBrief> = {}): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme" },
    pages: [{ route: "/", sections: [] }],
    ...overrides,
  } as SiteBrief;
}

describe("contactForm backward-compat", () => {
  it("validates a brief WITHOUT contactForm (pre-034 shape)", () => {
    expect(() => validateBrief(mk())).not.toThrow();
  });

  it("validates a brief with the legacy { fields: [] } shape", () => {
    expect(() =>
      validateBrief(mk({ contactForm: { fields: ["name", "email"] } })),
    ).not.toThrow();
  });
});

describe("contactForm.recipientEmail", () => {
  it("accepts a valid email", () => {
    expect(() =>
      validateBrief(
        mk({
          contactForm: { fields: ["name"], recipientEmail: "leads@acme.com" },
        }),
      ),
    ).not.toThrow();
  });
  it("rejects a non-email string", () => {
    expect(() =>
      validateBrief(
        mk({
          contactForm: { fields: ["name"], recipientEmail: "not-an-email" },
        }),
      ),
    ).toThrow(BriefValidationError);
  });
});

describe("contactForm.subjectTemplate", () => {
  it("accepts a short template", () => {
    expect(() =>
      validateBrief(
        mk({
          contactForm: {
            fields: ["name"],
            subjectTemplate: "[{client}] new lead",
          },
        }),
      ),
    ).not.toThrow();
  });
  it("rejects > 120 chars", () => {
    expect(() =>
      validateBrief(
        mk({
          contactForm: {
            fields: ["name"],
            subjectTemplate: "x".repeat(121),
          },
        }),
      ),
    ).toThrow(BriefValidationError);
  });
});

describe("contactForm.notifySlack", () => {
  it("accepts a hooks.slack.com URL", () => {
    expect(() =>
      validateBrief(
        mk({
          contactForm: {
            fields: ["name"],
            notifySlack: "https://hooks.slack.com/services/T/B/XYZ",
          },
        }),
      ),
    ).not.toThrow();
  });
  it("rejects any non-hooks.slack.com URL", () => {
    expect(() =>
      validateBrief(
        mk({
          contactForm: {
            fields: ["name"],
            notifySlack: "https://evil.com/hook",
          },
        }),
      ),
    ).toThrow(BriefValidationError);
  });
});

describe("contactForm.fields validation", () => {
  it("rejects non-string entries", () => {
    expect(() =>
      validateBrief(
        mk({
          // @ts-expect-error — intentional shape violation
          contactForm: { fields: [1, 2, 3] },
        }),
      ),
    ).toThrow(BriefValidationError);
  });
  it("rejects empty-string entries", () => {
    expect(() =>
      validateBrief(mk({ contactForm: { fields: ["name", ""] } })),
    ).toThrow(BriefValidationError);
  });
  it("rejects > 64 char field names", () => {
    expect(() =>
      validateBrief(mk({ contactForm: { fields: ["a".repeat(65)] } })),
    ).toThrow(BriefValidationError);
  });
});
