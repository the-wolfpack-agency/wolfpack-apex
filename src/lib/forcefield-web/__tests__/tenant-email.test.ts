/** @jest-environment node */
import { renderConfirmEmail, renderFirstEvidenceEmail, renderTenantDigestEmail, withTenantFooter, confirmUrl } from "@/lib/forcefield-web/tenant-email";

const C = { agentsDetected: 12, welcomed: 3, hostile: 4, trapped: 1, probed: 2, payloads: 1 };
const links = { baseUrl: "https://i.example/", unsubscribeToken: "u t" };

describe("tenant emails", () => {
  it("confirm: the confirm link is the call to action; no unsubscribe link needed (nothing sent until confirmed)", () => {
    const m = renderConfirmEmail({ site: "acme.com", to: "qa@thewolfpack.agency", baseUrl: "https://i.example", confirmToken: "a.b.c", expiresHours: 48 });
    expect(m.subject).toBe("Confirm Forcefield alerts for acme.com");
    expect(m.links[0].href).toBe(confirmUrl("https://i.example", "a.b.c"));
    expect(m.text).toContain("48 hours");
    expect(m.html).not.toContain("/admin");
  });

  it("first evidence + digest: dashboard CTA, one unsubscribe link, escaped fields, no /admin", () => {
    for (const m of [
      renderFirstEvidenceEmail({ site: "<acme>.com", to: "qa@thewolfpack.agency", firstEventAt: "2026-10-26T09:00:00Z", counts: C, ...links }),
      renderTenantDigestEmail({ site: "<acme>.com", to: "qa@thewolfpack.agency", day: "2026-10-26", counts: C, attacks: [{ attack: "sql_injection", count: 1 }], ...links }),
    ]) {
      expect(m.links[0].href).toBe("https://i.example/forcefield/dashboard");
      expect(m.links.filter((l) => l.label === "Unsubscribe")).toEqual([{ label: "Unsubscribe", href: "https://i.example/forcefield/unsubscribe?token=u%20t" }]);
      expect(m.html).toContain("&lt;acme&gt;.com");
      expect(m.html).not.toContain("<acme>");
      expect(`${m.html}${m.text}`).not.toContain("/admin");
    }
  });

  it("first evidence wording changes with whether anything hostile was caught", () => {
    expect(renderFirstEvidenceEmail({ site: "a.com", to: "x@thewolfpack.agency", firstEventAt: "2026-10-26T09:00:00Z", counts: { ...C, hostile: 0 }, ...links }).text).toContain("Nothing hostile so far");
    expect(renderFirstEvidenceEmail({ site: "a.com", to: "x@thewolfpack.agency", firstEventAt: "2026-10-26T09:00:00Z", counts: C, ...links }).text).toContain("already caught 4 hostile actions");
  });

  it("withTenantFooter appends manage + unsubscribe to html and text", () => {
    const out = withTenantFooter({ subject: "s", html: "<html><body>x</body></html>", text: "x", links: [] as { label: string; href: string }[] }, "acme.com", "qa@thewolfpack.agency", links);
    expect(out.html).toMatch(/Unsubscribe<\/a>[\s\S]*<\/body>/);
    expect(out.text).toContain("Unsubscribe: https://i.example/forcefield/unsubscribe?token=u%20t");
    expect(out.links.map((l) => l.label)).toEqual(["Manage alerts", "Unsubscribe"]);
  });
});
