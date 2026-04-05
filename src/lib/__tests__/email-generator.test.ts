/**
 * Email Generator Tests
 *
 * Tests template generation, variable substitution, error handling,
 * template listing, customization, and analytics tracking.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { trackEvent } from "@/lib/analytics";

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

import {
  generateProposalEmail,
  generateFollowUpEmail,
  generateStatusUpdateEmail,
  generateOnboardingEmail,
  getEmailTemplates,
  customizeTemplate,
} from "@/lib/email-generator";

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// generateProposalEmail
// ---------------------------------------------------------------------------

describe("generateProposalEmail", () => {
  test("generates valid subject and body", () => {
    const draft = generateProposalEmail("Acme Corp", "Auto Platform", [
      "Inventory management",
      "Lead tracking",
    ]);
    expect(draft.subject).toContain("Acme Corp");
    expect(draft.subject).toContain("Auto Platform");
    expect(draft.body).toContain("Acme Corp");
    expect(draft.body).toContain("Inventory management");
    expect(draft.body).toContain("Lead tracking");
    expect(draft.templateId).toBe("proposal");
    expect(draft.generatedAt).toBeTruthy();
  });

  test("includes pricing when provided", () => {
    const draft = generateProposalEmail(
      "Acme Corp",
      "Auto Platform",
      ["Feature 1"],
      "u1",
      "sales",
      "$5,000/month",
    );
    expect(draft.body).toContain("$5,000/month");
    expect(draft.body).toContain("Investment");
  });

  test("tracks analytics", () => {
    generateProposalEmail("Client X", "Product Y", ["F1"], "u1", "sales");
    expect(trackEvent).toHaveBeenCalledWith(
      "client.email_drafted",
      "u1",
      "sales",
      expect.objectContaining({ template: "proposal", client: "Client X" }),
    );
  });
});

// ---------------------------------------------------------------------------
// generateFollowUpEmail
// ---------------------------------------------------------------------------

describe("generateFollowUpEmail", () => {
  test("generates valid subject and body", () => {
    const draft = generateFollowUpEmail("Bob Smith", "March 15, 2026", [
      "Review proposal",
      "Schedule demo",
    ]);
    expect(draft.subject).toContain("March 15, 2026");
    expect(draft.body).toContain("Bob Smith");
    expect(draft.body).toContain("Review proposal");
    expect(draft.body).toContain("Schedule demo");
    expect(draft.templateId).toBe("followup");
  });

  test("tracks analytics", () => {
    generateFollowUpEmail("Bob", "Jan 1", ["Item"], "u2", "ops");
    expect(trackEvent).toHaveBeenCalledWith(
      "client.email_drafted",
      "u2",
      "ops",
      expect.objectContaining({ template: "followup" }),
    );
  });
});

// ---------------------------------------------------------------------------
// generateStatusUpdateEmail
// ---------------------------------------------------------------------------

describe("generateStatusUpdateEmail", () => {
  test("generates valid subject and body", () => {
    const draft = generateStatusUpdateEmail(
      "Jane Doe",
      "Wolfpack Auto",
      ["Authentication system", "Dashboard v1"],
      ["Payment integration", "Mobile responsive"],
    );
    expect(draft.subject).toContain("Wolfpack Auto");
    expect(draft.body).toContain("Jane Doe");
    expect(draft.body).toContain("Authentication system");
    expect(draft.body).toContain("Payment integration");
    expect(draft.body).toContain("Completed");
    expect(draft.body).toContain("Coming Up Next");
    expect(draft.templateId).toBe("status_update");
  });

  test("tracks analytics", () => {
    generateStatusUpdateEmail("J", "P", ["a"], ["b"], "u3", "ops");
    expect(trackEvent).toHaveBeenCalledWith(
      "client.email_drafted",
      "u3",
      "ops",
      expect.objectContaining({ template: "status_update" }),
    );
  });
});

// ---------------------------------------------------------------------------
// generateOnboardingEmail
// ---------------------------------------------------------------------------

describe("generateOnboardingEmail", () => {
  test("generates valid subject and body", () => {
    const draft = generateOnboardingEmail(
      "New Client",
      "https://app.wolfpack.dev/login",
      "https://app.wolfpack.dev/admin",
    );
    expect(draft.subject).toContain("Welcome to Wolfpack");
    expect(draft.body).toContain("New Client");
    expect(draft.body).toContain("https://app.wolfpack.dev/login");
    expect(draft.body).toContain("https://app.wolfpack.dev/admin");
    expect(draft.templateId).toBe("onboarding");
  });

  test("tracks analytics", () => {
    generateOnboardingEmail("C", "http://a", "http://b", "u4", "ops");
    expect(trackEvent).toHaveBeenCalledWith(
      "client.email_drafted",
      "u4",
      "ops",
      expect.objectContaining({ template: "onboarding" }),
    );
  });
});

// ---------------------------------------------------------------------------
// getEmailTemplates
// ---------------------------------------------------------------------------

describe("getEmailTemplates", () => {
  test("returns all templates", () => {
    const templates = getEmailTemplates();
    expect(templates.length).toBe(4);

    const ids = templates.map((t) => t.id);
    expect(ids).toContain("proposal");
    expect(ids).toContain("followup");
    expect(ids).toContain("status_update");
    expect(ids).toContain("onboarding");
  });

  test("each template has required fields", () => {
    const templates = getEmailTemplates();
    for (const t of templates) {
      expect(t).toHaveProperty("id");
      expect(t).toHaveProperty("name");
      expect(t).toHaveProperty("description");
      expect(t).toHaveProperty("requiredVariables");
      expect(t).toHaveProperty("optionalVariables");
      expect(Array.isArray(t.requiredVariables)).toBe(true);
      expect(t.requiredVariables.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// customizeTemplate
// ---------------------------------------------------------------------------

describe("customizeTemplate", () => {
  test("works with any template", () => {
    const draft = customizeTemplate("proposal", {
      clientName: "Test Client",
      productName: "Test Product",
      features: "Feature A, Feature B",
    });
    expect(draft.subject).toContain("Test Client");
    expect(draft.body).toContain("Feature A");
    expect(draft.templateId).toBe("proposal");
  });

  test("tracks analytics with custom flag", () => {
    customizeTemplate(
      "followup",
      { clientName: "C", meetingDate: "today", actionItems: "do stuff" },
      "u5",
      "sales",
    );
    expect(trackEvent).toHaveBeenCalledWith(
      "client.email_drafted",
      "u5",
      "sales",
      expect.objectContaining({ template: "followup", custom: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("missing required variables throws helpful error", () => {
    expect(() =>
      customizeTemplate("proposal", { clientName: "X" }),
    ).toThrow("Missing required variables");
    expect(() =>
      customizeTemplate("proposal", { clientName: "X" }),
    ).toThrow("productName");
  });

  test("unknown template throws helpful error", () => {
    expect(() => customizeTemplate("nonexistent", {})).toThrow("Unknown template");
    expect(() => customizeTemplate("nonexistent", {})).toThrow("Available:");
  });

  test("empty string variable is treated as missing", () => {
    expect(() =>
      customizeTemplate("proposal", {
        clientName: "",
        productName: "P",
        features: "F",
      }),
    ).toThrow("Missing required variables");
  });
});
