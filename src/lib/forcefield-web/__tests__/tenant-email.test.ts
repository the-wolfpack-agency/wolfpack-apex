/** @jest-environment node */
import { renderConfirmEmail, renderFirstHourEmail, renderTenantDigestEmail, withTenantFooter, confirmUrl } from "@/lib/forcefield-web/tenant-email";

const C = { agentsDetected: 12, welcomed: 3, hostile: 4, trapped: 1, probed: 2, payloads: 1 };
const links = { baseUrl: "https://i.example/", unsubscribeToken: "u t" };
const ACT = {
  counts: { agentsSeen: 5, welcomed: 2, slowed: 1, blocked: 1, caught: 0 },
  agents: [
    { name: "<Googlebot>", requests: 9, did: "Read your public pages", handled: "welcomed" },
    { name: "sqlmap", requests: 4, did: "Sent an attack payload", handled: "blocked" },
  ],
};
const NONE = { counts: { agentsSeen: 0, welcomed: 0, slowed: 0, blocked: 0, caught: 0 }, agents: [] };

describe("tenant emails", () => {
  it("confirm: the confirm link is the call to action; no unsubscribe link needed (nothing sent until confirmed)", () => {
    const m = renderConfirmEmail({ site: "acme.com", to: "qa@thewolfpack.agency", baseUrl: "https://i.example", confirmToken: "a.b.c", expiresHours: 48 });
    expect(m.subject).toBe("Confirm Forcefield alerts for acme.com");
    expect(m.links[0].href).toBe(confirmUrl("https://i.example", "a.b.c"));
    expect(m.text).toContain("48 hours");
    expect(m.html).not.toContain("/admin");
  });

  it("first hour + digest: dashboard CTA, one unsubscribe link, escaped fields, no /admin", () => {
    for (const m of [
      renderFirstHourEmail({ site: "<acme>.com", to: "qa@thewolfpack.agency", firstEventAt: "2026-10-26T09:00:00Z", activity: ACT, ...links }),
      renderTenantDigestEmail({ site: "<acme>.com", to: "qa@thewolfpack.agency", day: "2026-10-26", counts: C, attacks: [{ attack: "sql_injection", count: 1 }], ...links }),
    ]) {
      expect(m.links[0].href).toBe("https://i.example/forcefield/dashboard");
      expect(m.links.filter((l: { label: string }) => l.label === "Unsubscribe")).toEqual([{ label: "Unsubscribe", href: "https://i.example/forcefield/unsubscribe?token=u%20t" }]);
      expect(m.html).toContain("&lt;acme&gt;.com");
      expect(m.html).not.toContain("<acme>");
      expect(`${m.html}${m.text}`).not.toContain("/admin");
    }
  });

  it("first hour: the four counts, the top agents escaped, and an honest empty state", () => {
    const m = renderFirstHourEmail({ site: "a.com", to: "x@thewolfpack.agency", firstEventAt: "2026-10-26T09:00:00Z", activity: ACT, ...links });
    expect(m.subject).toBe("Your first hour with Forcefield on a.com");
    expect(m.text).toContain("5 automated agents have visited: 2 welcomed, 1 slowed down, 1 blocked.");
    expect(m.text).toContain("sqlmap: 4 requests. Sent an attack payload. blocked.");
    expect(m.html).toContain("&lt;Googlebot&gt;");
    expect(m.html).not.toContain("<Googlebot>");
    const empty = renderFirstHourEmail({ site: "a.com", to: "x@thewolfpack.agency", firstEventAt: "2026-10-26T09:00:00Z", activity: NONE, ...links });
    expect(empty.text).toContain("No automated agents yet, only people.");
  });

  it("withTenantFooter appends manage + unsubscribe to html and text", () => {
    const out = withTenantFooter({ subject: "s", html: "<html><body>x</body></html>", text: "x", links: [] as { label: string; href: string }[] }, "acme.com", "qa@thewolfpack.agency", links);
    expect(out.html).toMatch(/Unsubscribe<\/a>[\s\S]*<\/body>/);
    expect(out.text).toContain("Unsubscribe: https://i.example/forcefield/unsubscribe?token=u%20t");
    expect(out.links.map((l) => l.label)).toEqual(["Manage alerts", "Unsubscribe"]);
  });
});
