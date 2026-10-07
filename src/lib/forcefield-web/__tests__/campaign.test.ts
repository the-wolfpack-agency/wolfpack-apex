/**
 * Campaign detection is the multi-step layer, so it is tested where the risk is:
 * each kill-chain SHAPE fires deterministically, and (the harder, more important
 * half) a normal browsing session NEVER trips it. A false campaign flag on a real
 * user is worse than a miss, same posture as the per-request engine.
 */
import { categorizeStep, detectCampaign, type OperatorStep } from "../campaign";

let clock = 1_000_000;
const steps = (paths: Array<string | [string, number]>): OperatorStep[] =>
  paths.map((p) => {
    const [path, gap] = Array.isArray(p) ? p : [p, 1000];
    clock += gap;
    return { path, method: "GET", ts: clock };
  });

describe("categorizeStep", () => {
  it("classifies the surface deterministically", () => {
    expect(categorizeStep("/_ff/records")).toBe("decoy");
    expect(categorizeStep("/admin/users")).toBe("sensitive");
    expect(categorizeStep("/api/internal/flags")).toBe("sensitive");
    expect(categorizeStep("/export/customers")).toBe("export");
    expect(categorizeStep("/reports/q3.csv")).toBe("export");
    expect(categorizeStep("/login")).toBe("auth");
    expect(categorizeStep("/pricing")).toBe("benign");
    expect(categorizeStep("/blog/how-we-handle-admin-access")).toBe("benign"); // word, not a path
  });
});

describe("detectCampaign signatures", () => {
  it("recon_breadth: enumerating many distinct sensitive paths fires", () => {
    const v = detectCampaign(steps(["/admin", "/api/internal/x", "/.env", "/actuator", "/config.json"]));
    expect(v.campaign).toBe(true);
    expect(v.signatures.map((s) => s.id)).toContain("recon_breadth");
  });

  it("kill_chain: a sensitive access THEN a bulk export fires (high severity)", () => {
    const v = detectCampaign(steps(["/admin/users", "/export/users?format=csv"]));
    expect(v.campaign).toBe(true);
    const kc = v.signatures.find((s) => s.id === "kill_chain");
    expect(kc?.severity).toBe("high");
    expect(kc?.stepIndexes).toEqual([0, 1]);
  });

  it("kill_chain respects ORDER: an export BEFORE any recon does not fire the chain", () => {
    const v = detectCampaign(steps(["/export/report?format=csv", "/pricing", "/blog/x"]));
    expect(v.signatures.find((s) => s.id === "kill_chain")).toBeUndefined();
  });

  it("id_enumeration: walking distinct ids on one endpoint fires", () => {
    const v = detectCampaign(steps(["/api/orders/1", "/api/orders/2", "/api/orders/3", "/api/orders/4", "/api/orders/5"]));
    expect(v.campaign).toBe(true);
    expect(v.signatures.find((s) => s.id === "id_enumeration")?.severity).toBe("high");
  });

  it("id_enumeration also catches an id in the query string", () => {
    const v = detectCampaign(steps(["/account?id=10", "/account?id=11", "/account?id=12", "/account?id=13", "/account?id=14"]));
    expect(v.signatures.find((s) => s.id === "id_enumeration")).toBeDefined();
  });

  it("windowing: recon spread beyond the window does not accumulate into breadth", () => {
    // five sensitive paths but each 60s apart -> outside a 120s window from the last
    const v = detectCampaign(steps([["/admin", 0], ["/.env", 60_000], ["/actuator", 60_000], ["/config", 60_000], ["/api/internal/x", 60_000]]), { windowMs: 120_000 });
    expect(v.signatures.find((s) => s.id === "recon_breadth")).toBeUndefined();
  });
});

describe("payload_chain (the combo): payload + recon/exfil in one session", () => {
  it("fires when an injection payload is chained with sensitive recon", () => {
    const v = detectCampaign([
      { path: "/admin", method: "GET", ts: 1 },
      { path: "/search", rawUrl: "/search?q=<script>alert(1)</script>", method: "GET", ts: 2 },
    ]);
    expect(v.campaign).toBe(true);
    const pc = v.signatures.find((s) => s.id === "payload_chain");
    expect(pc?.severity).toBe("high");
  });

  it("fires when a payload is chained with an export (inject then exfil)", () => {
    const v = detectCampaign([
      { path: "/items", rawUrl: "/items?id=1%20UNION%20SELECT%20password%20FROM%20users", method: "GET", ts: 1 },
      { path: "/export/users?format=csv", method: "GET", ts: 2 },
    ]);
    expect(v.signatures.find((s) => s.id === "payload_chain")?.reason).toMatch(/export/);
  });

  it("does NOT fire on a LONE payload with no recon/exfil partner (per-request engine handles that)", () => {
    const v = detectCampaign([
      { path: "/search", rawUrl: "/search?q=<script>alert(1)</script>", method: "GET", ts: 1 },
      { path: "/", method: "GET", ts: 2 },
    ]);
    expect(v.signatures.find((s) => s.id === "payload_chain")).toBeUndefined();
  });

  it("categorizeStep sees a payload in the query string", () => {
    expect(categorizeStep("/x?p=../../../../etc/passwd")).toBe("payload");
    expect(categorizeStep("/x?q=normal+search")).toBe("benign");
  });
});

describe("auth_abuse + payload_fuzzing (more agent combos)", () => {
  it("auth_abuse: a burst of auth-surface hits fires (credential stuffing)", () => {
    const v = detectCampaign(steps(["/login", "/login", "/login", "/login", "/login"]));
    expect(v.signatures.find((s) => s.id === "auth_abuse")?.severity).toBe("high");
  });

  it("auth_abuse does NOT fire on a normal login (one or two hits)", () => {
    const v = detectCampaign(steps(["/", "/login", "/account"]));
    expect(v.signatures.find((s) => s.id === "auth_abuse")).toBeUndefined();
  });

  it("payload_fuzzing: several distinct injection payloads in one window fire", () => {
    const v = detectCampaign([
      { path: "/s", rawUrl: "/s?q=<script>alert(1)</script>", method: "GET", ts: 1 },
      { path: "/s", rawUrl: "/s?q=../../../../etc/passwd", method: "GET", ts: 2 },
      { path: "/s", rawUrl: "/s?q=1 UNION SELECT password FROM users", method: "GET", ts: 3 },
    ]);
    expect(v.signatures.find((s) => s.id === "payload_fuzzing")?.severity).toBe("high");
  });

  it("payload_fuzzing does NOT fire on a single payload (per-request engine handles it)", () => {
    const v = detectCampaign([
      { path: "/s", rawUrl: "/s?q=<script>alert(1)</script>", method: "GET", ts: 1 },
      { path: "/pricing", method: "GET", ts: 2 },
    ]);
    expect(v.signatures.find((s) => s.id === "payload_fuzzing")).toBeUndefined();
  });
});

describe("no false campaign on benign sessions (the worst outcome)", () => {
  const benignSessions: Array<[string, string[]]> = [
    ["normal browsing", ["/", "/pricing", "/features", "/blog/post-1", "/contact"]],
    ["a real login flow", ["/", "/login", "/account", "/account/settings"]],
    ["one admin page view by a legit admin", ["/admin", "/admin/dashboard"]],
    ["reading two docs that mention admin and export", ["/docs/admin-guide-article", "/docs/exporting-data-guide"]],
  ];
  it.each(benignSessions)("%s is not a campaign", (_name, paths) => {
    expect(detectCampaign(steps(paths)).campaign).toBe(false);
  });
});

describe("regression corpus: hostile campaigns stay caught, benign stay clear", () => {
  const hostile: Array<[string, string[]]> = [
    ["surface recon sweep", ["/admin", "/wp-admin", "/.env", "/actuator", "/phpmyadmin"]],
    ["recon then exfil", ["/api/internal/customers", "/export/customers?format=csv"]],
    ["decoy trip then export", ["/_ff/records", "/download/backup.sql"]],
    ["IDOR id walk", ["/api/invoices/100", "/api/invoices/101", "/api/invoices/102", "/api/invoices/103", "/api/invoices/104", "/api/invoices/105"]],
  ];
  it("every hostile campaign is detected", () => {
    const missed = hostile.filter(([, p]) => !detectCampaign(steps(p)).campaign).map(([n]) => n);
    expect(missed).toEqual([]);
  });
});
