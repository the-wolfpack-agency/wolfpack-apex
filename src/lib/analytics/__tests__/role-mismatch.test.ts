/**
 * A control the user could see, could click, and was never allowed to use.
 *
 * The API returning 403 is the security layer working. It is also a button
 * that does nothing, and nobody reports that: there is no error to screenshot
 * and no message to quote, so it arrives as somebody quietly using the product
 * less. The Porsche build caught a real user attempting three times to submit
 * a user to an organisation he was not part of. Three attempts, no complaint.
 */
import { shouldReportMismatch, controlKey } from "../role-mismatch";

describe("what counts as a control that lied", () => {
  it("reports a write the API refused", () => {
    expect(shouldReportMismatch("/api/clients/123/documents", "POST")).toBe(true);
    expect(shouldReportMismatch("/api/agents/abc", "PATCH")).toBe(true);
    expect(shouldReportMismatch("/api/invoices/9", "DELETE")).toBe(true);
  });

  /* A GET that 403s is usually a page fetching something incidental for a role
     that cannot see it, which is scoping working as intended. The defect this
     hunts is a control somebody ACTED on, and acting is a write. */
  it("ignores a read, which is scoping working rather than a control lying", () => {
    expect(shouldReportMismatch("/api/clients/123", "GET")).toBe(false);
  });

  /* THE LOOP THAT WOULD KILL THE TAB. Reporting a failed report recurses. */
  it("never reports the analytics endpoint itself", () => {
    expect(shouldReportMismatch("/api/analytics", "POST")).toBe(false);
  });

  /* A 403 from the auth system is the session being refused, not a control
     being offered to the wrong role. */
  it("never reports the auth endpoints", () => {
    expect(shouldReportMismatch("/api/auth/refresh", "POST")).toBe(false);
  });

  it("ignores anything that is not our API", () => {
    expect(shouldReportMismatch("https://graph.microsoft.com/v1.0/me", "POST")).toBe(false);
  });
});

describe("collapsing a URL to the control it represents", () => {
  /* WITHOUT THIS THE REPEAT SIGNAL DISAPPEARS. Two clicks on the same button
     for two different records would look like two separate controls failing
     once each, which is exactly the shape the ranking is built to distinguish
     from one control failing twice. */
  it("treats the same control on different records as one control", () => {
    const a = controlKey("/api/clients/8f21a3b4-1c2d-4e5f-8a9b-0c1d2e3f4a5b/documents");
    const b = controlKey("/api/clients/1234abcd-5678-4e5f-8a9b-0c1d2e3f4a5b/documents");
    expect(a).toBe(b);
    expect(a).toBe("/api/clients/:id/documents");
  });

  it("collapses numeric ids", () => {
    expect(controlKey("/api/invoices/42/send")).toBe("/api/invoices/:id/send");
  });

  it("collapses long opaque ids", () => {
    expect(controlKey("/api/docs/a1b2c3d4e5f60718293a4b5c")).toBe("/api/docs/:id");
  });

  it("drops the query string, which carries values rather than the control", () => {
    expect(controlKey("/api/search?q=secret+thing")).toBe("/api/search");
  });

  /* A word that happens to be hex-ish is not an id. Collapsing it would merge
     two genuinely different controls into one row. */
  it("does not collapse a real path segment", () => {
    expect(controlKey("/api/agents/act")).toBe("/api/agents/act");
    expect(controlKey("/api/clients/documents")).toBe("/api/clients/documents");
  });
});
