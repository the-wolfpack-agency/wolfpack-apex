/** @jest-environment node */
/**
 * The shared Forcefield alert email: outcome-first subject, exact times, every
 * field escaped, absolute links only, plain-text parity, the automatic-block
 * decision folded in, clean rendering with missing source facts, and a tenant
 * version with no admin links and no internal ids.
 */
import {
  renderForcefieldAlertEmail,
  alertSubject,
  alertHeadline,
  responseKind,
  formatUtc,
  formatEastern,
  displaySite,
  digestSubject,
  type IncidentDetail,
} from "../alert-email";
import { alertFromSignal, alertFromIncident, digestKey, type ForcefieldAlert, type HostileSignal } from "../alerts";
import { buildIncidents, buildDigest, type HostileEventGroup } from "../incidents";

const BASE = "https://instinct.example.test";

/** The shape of a real contained decoy trip (synthetic identifiers). */
function detail(over: Partial<IncidentDetail> = {}): IncidentDetail {
  return {
    firstAt: "2026-10-26T10:05:37.367Z",
    lastAt: "2026-10-26T10:05:37.367Z",
    count: 1,
    windowStart: "2026-10-26T06:00:00.000Z",
    windowHours: 6,
    paths: ["/_ff/records"],
    pathCount: 1,
    countries: ["IS"],
    hosting: ["residential"],
    clientTypes: ["browser"],
    agents: ["unidentified"],
    networks: [],
    fingerprints: ["aaaa1111:browser"],
    fingerprintCount: 1,
    signatures: ["bbbb2222"],
    signatureCount: 1,
    outcomes: { blocked: 0, contained: 1, recorded: 0 },
    postures: ["enforce"],
    reasonKinds: ["decoy"],
    ...over,
  };
}

function signal(over: Partial<HostileSignal> = {}, d: Partial<IncidentDetail> = {}): HostileSignal {
  return {
    kind: "honeytoken_trip",
    site: "ogiam.com",
    attackClass: "honeytoken_trip",
    windowStart: "2026-10-26T06:00:00.000Z",
    fpCount: 1,
    samplePath: "/_ff/records",
    count: 1,
    detail: detail(d),
    ...over,
  };
}

const op = (a: ForcefieldAlert) => renderForcefieldAlertEmail(a, { audience: "operator", baseUrl: BASE, recipients: ["sec@wolfpack.example"], alertId: "row123" });
const tenant = (a: ForcefieldAlert) => renderForcefieldAlertEmail(a, { audience: "tenant", baseUrl: BASE, recipients: ["owner@client.example"] });

describe("subject and headline say the outcome", () => {
  it("contained decoy trip", () => {
    const a = alertFromSignal(signal());
    expect(a.title).toBe("[Forcefield] ogiam.com: hostile agent contained (decoy)");
    expect(alertHeadline(a)).toBe("A hostile agent took a decoy on ogiam.com and was contained");
  });

  it("blocked, recorded-only and partial", () => {
    expect(alertSubject(alertFromSignal(signal({}, { outcomes: { blocked: 1, contained: 0, recorded: 0 } })))).toBe("[Forcefield] ogiam.com: hostile agent blocked (decoy)");
    expect(alertSubject(alertFromSignal(signal({}, { outcomes: { blocked: 0, contained: 0, recorded: 1 } })))).toBe("[Forcefield] ogiam.com: hostile agent recorded, not blocked (decoy)");
    expect(responseKind(detail({ outcomes: { blocked: 1, contained: 1, recorded: 1 } }))).toBe("partial");
  });

  it("honeytoken wording when the engine says honeytoken", () => {
    expect(alertSubject(alertFromSignal(signal({}, { reasonKinds: ["honeytoken"] })))).toMatch(/\(honeytoken\)$/);
  });

  it("payload attacks name the attack and the attempt count", () => {
    const a = alertFromSignal(signal({ kind: "payload_attack", attackClass: "sql_injection", count: 3 }, { count: 3, outcomes: { blocked: 0, contained: 0, recorded: 3 }, reasonKinds: [] }));
    expect(a.title).toBe("[Forcefield] ogiam.com: SQL injection recorded, not blocked (3 attempts)");
    expect(alertHeadline(a)).toBe("3 SQL injection attempts on ogiam.com were recorded, not blocked");
  });
});

describe("times are exact (never the window start)", () => {
  it("UTC to the second and US Eastern with DST", () => {
    expect(formatUtc("2026-10-26T10:05:37.367Z")).toBe("2026-10-26 10:05:37 UTC");
    expect(formatEastern("2026-10-26T10:05:37.367Z")).toBe("Oct 26, 2026, 6:05:37 AM EDT");
    expect(formatEastern("2026-12-01T10:05:37Z")).toBe("Dec 1, 2026, 5:05:37 AM EST");
  });

  it("a single event shows one When row with the exact time; the window is context only", () => {
    const e = op(alertFromSignal(signal()));
    expect(e.text).toContain("When: 2026-10-26 10:05:37 UTC (Oct 26, 2026, 6:05:37 AM EDT)");
    expect(e.text).toContain("Requests: 1");
    expect(e.text).toMatch(/Alert window: .*06:00:00 to 2026-10-26 12:00:00 UTC \(context only\)/);
    expect(e.text).not.toMatch(/window starting/);
  });

  it("several events show exact first and last times and the count", () => {
    const e = op(alertFromSignal(signal({ count: 4 }, { count: 4, firstAt: "2026-10-26T07:01:02Z", lastAt: "2026-10-26T09:59:58Z", outcomes: { blocked: 4, contained: 0, recorded: 0 } })));
    expect(e.text).toContain("First event: 2026-10-26 07:01:02 UTC");
    expect(e.text).toContain("Last event: 2026-10-26 09:59:58 UTC");
    expect(e.text).toContain("Requests: 4");
  });
});

describe("content", () => {
  it("status, no-action line, source, signal and plain explanation", () => {
    const e = op(alertFromSignal(signal()));
    expect(e.text).toContain("Contained: sent into the decoy maze");
    expect(e.text).toContain("No action needed.");
    expect(e.text).toContain("Source: Iceland (IS) · residential network · browser-like client · agent not identified");
    expect(e.text).toContain("Signal: Decoy taken");
    expect(e.text).toContain("Confidence: High: proven hostile");
    expect(e.text).toMatch(/What this alert means: A decoy is a link or record hidden from people/);
    expect(e.text).toContain("Fingerprint: aaaa1111:browser");
    expect(e.text).toContain("Session signature: bbbb2222");
  });

  it("recorded-only gives a specific recommended action", () => {
    const e = op(alertFromSignal(signal({}, { outcomes: { blocked: 0, contained: 0, recorded: 1 }, postures: ["monitor"] })));
    expect(e.text).toContain("Recorded only: the site is in watch mode");
    expect(e.text).toMatch(/Recommended: review this activity on the board/);
    expect(e.text).toContain("Site mode: Watch (recording only)");
  });

  it("renders cleanly with no country, network, client type, agent, fingerprint or signature", () => {
    const e = op(alertFromSignal(signal({ fpCount: 0 }, { countries: [], hosting: [], clientTypes: [], agents: [], networks: [], fingerprints: [], fingerprintCount: 0, signatures: [], signatureCount: 0, postures: [] })));
    expect(e.text).toContain("Source: Country not recorded · agent not identified");
    expect(e.text).toContain("Fingerprints: not recorded");
    expect(e.text).not.toMatch(/undefined|null|NaN/);
    expect(e.html).not.toMatch(/undefined|NaN/);
  });

  it("shows a network owner and an identified agent when recorded", () => {
    const e = op(alertFromSignal(signal({}, { networks: ["AS64500 Example Hosting"], hosting: ["datacenter"], agents: ["GPTBot"] })));
    expect(e.text).toContain("datacenter / cloud network, AS64500 Example Hosting");
    expect(e.text).toContain("identified as GPTBot");
  });

  it("caps long path lists with an exact remainder", () => {
    const e = op(alertFromSignal(signal({}, { paths: ["/a", "/b", "/c", "/d", "/e"], pathCount: 9 })));
    expect(e.text).toContain("Paths: /a, /b, /c, /d, /e and 4 more");
  });
});

describe("automatic-block decision is folded into the incident email", () => {
  it("withheld: the plain explanation, and still one email", () => {
    const a = alertFromSignal(signal());
    a.incident!.blockDecision = { state: "withheld", fingerprints: ["aaaa1111:browser"], why: "common_client_kind" };
    const e = op(a);
    expect(e.text).toContain("Automatic block not applied: This browser fingerprint is shared by many legitimate visitors, so blocking it everywhere would turn them away. Decoy, payload and attack-tool rules still stop this client's hostile requests.");
    expect(e.html).toContain("Automatic block not applied");
  });

  it("blocked: names the expiry", () => {
    const a = alertFromSignal(signal());
    a.incident!.blockDecision = { state: "blocked", fingerprints: ["aaaa1111:sqlmap"], expiresAt: "2026-11-09T10:05:37Z" };
    expect(op(a).text).toContain("until 2026-11-09 10:05:37 UTC");
  });
});

describe("links are absolute and land on the incident", () => {
  it("operator: incident deep link (session signature), board and the alerts doc", () => {
    const e = op(alertFromSignal(signal()));
    expect(e.links.map((l) => l.href)).toEqual([
      `${BASE}/admin/site-analytics?tab=forcefield&view=operator&find=bbbb2222`,
      `${BASE}/admin/site-analytics?tab=forcefield`,
      `${BASE}/admin/forcefield/docs?doc=alerts`,
    ]);
    for (const l of e.links) expect(l.href.startsWith("https://")).toBe(true);
    const hrefs = Array.from(e.html.matchAll(/href="([^"]+)"/g)).map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).toMatch(/^https:\/\//);
  });

  it("falls back to the path when there is no single session signature", () => {
    const e = op(alertFromSignal(signal({}, { signatures: [], signatureCount: 0 })));
    expect(e.links[0].href).toBe(`${BASE}/admin/site-analytics?tab=forcefield&view=operator&find=%2F_ff%2Frecords`);
  });
});

describe("HTML escaping of every field", () => {
  it("escapes site, paths, source, fingerprints, signatures, recipients and dedupe key", () => {
    const x = `<img src=x onerror=alert(1)>"'&`;
    const a = alertFromSignal(signal({ site: x }, { paths: [x], countries: [x], hosting: [x], clientTypes: [x], agents: [x], networks: [x], fingerprints: [x], signatures: [x], postures: [x] }));
    a.dedupeKey = x;
    const e = renderForcefieldAlertEmail(a, { audience: "operator", baseUrl: BASE, recipients: [x], alertId: x });
    expect(e.html).not.toContain("<img");
    expect(e.html).not.toContain(`"'&<`);
    expect(e.html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;");
    // the deep link carries the value URL-encoded, never raw
    expect(e.html).not.toMatch(/href="[^"]*<img/);
  });

  it("a generic alert's body is escaped too", () => {
    const e = op({ kind: "canary_trip", dedupeKey: "k", title: "Forcefield: decoy touched", body: "<script>x</script>" });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("plain-text parity", () => {
  it("the text carries every detail value and every link the HTML carries", () => {
    const a = alertFromSignal(signal());
    a.incident!.blockDecision = { state: "withheld", fingerprints: ["aaaa1111:browser"], why: "common_client_kind" };
    const e = op(a);
    for (const l of e.links) {
      expect(e.text).toContain(l.href);
      expect(e.html).toContain(l.href.replace(/&/g, "&amp;"));
    }
    for (const fact of ["ogiam.com", "/_ff/records", "Iceland (IS)", "aaaa1111:browser", "bbbb2222", "2026-10-26 10:05:37 UTC", "Contained: sent into the decoy maze", "No action needed.", "Automatic block not applied", "row123", a.dedupeKey, "sec@wolfpack.example"]) {
      expect(e.text).toContain(fact);
      expect(e.html).toContain(fact);
    }
  });

  it("footer: why, who else, ids, how to change", () => {
    const e = op(alertFromSignal(signal()));
    expect(e.text).toContain("You receive this because you are on the Forcefield security alert list");
    expect(e.text).toContain("Sent to: sec@wolfpack.example.");
    expect(e.text).toContain("FORCEFIELD_ALERT_RECIPIENT_EMAIL");
    expect(e.text).toMatch(/Alert id: row123 · Dedupe key: [0-9a-f]{24}/);
  });

  it("no em dashes anywhere", () => {
    const e = op(alertFromSignal(signal()));
    expect(e.html + e.text + e.subject).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("tenant version (template only; not sent in the build phase)", () => {
  it("has no /admin links, no fingerprints, signatures or internal ids", () => {
    const a = alertFromSignal(signal());
    a.incident!.blockDecision = { state: "withheld", fingerprints: ["aaaa1111:browser"], why: "common_client_kind" };
    const e = tenant(a);
    expect(e.html).not.toContain("/admin");
    expect(e.text).not.toContain("/admin");
    for (const internal of ["aaaa1111", "bbbb2222", a.dedupeKey, "Dedupe key", "Alert id", "FORCEFIELD_ALERT_RECIPIENT_EMAIL", "Automatic block"]) {
      expect(e.html).not.toContain(internal);
      expect(e.text).not.toContain(internal);
    }
    expect(e.links.map((l) => l.href)).toEqual([`${BASE}/forcefield/dashboard`, `${BASE}/forcefield/status`]);
  });

  it("is scoped to the alert's own site and carries no other site's data", () => {
    const e = tenant(alertFromSignal(signal({ site: "client-a.example" })));
    expect(e.text).toContain("client-a.example");
    expect(e.text).not.toContain("ogiam.com");
    expect(e.text).toContain("Sent to: owner@client.example.");
    expect(e.text).not.toContain("wolfpack");
  });

  it("recommends turning on blocking in client words", () => {
    const e = tenant(alertFromSignal(signal({}, { outcomes: { blocked: 0, contained: 0, recorded: 1 } })));
    expect(e.text).toContain("Recommended: turn on blocking for your site");
  });
});

/* ------------------- grouped incidents and the daily digest ------------------ */


function grp(over: Partial<HostileEventGroup> = {}): HostileEventGroup {
  const firstAt = over.firstAt ?? "2026-10-26T14:02:44.388Z";
  return {
    kind: "payload_attack", site: "instinct", attackClass: "open_redirect", windowStart: "2026-10-26T12:00:00.000Z",
    fp: "fp-a:browser", sig: "s1", path: "/bitrix/redirect.php", country: "US", hosting: "residential", clientType: "browser",
    agent: "unidentified", network: "", outcome: "blocked", posture: "enforce", reasonKind: "payload", count: 1, firstAt, lastAt: firstAt, ...over,
  };
}

function digestAlert(groups: HostileEventGroup[]): ForcefieldAlert {
  const digest = buildDigest(buildIncidents(groups), { etDate: "2026-10-27", start: new Date("2026-10-26T12:00:00Z"), end: new Date("2026-10-27T12:00:00Z") });
  return { kind: "alert_digest", dedupeKey: digestKey("2026-10-27"), title: "", body: "", windowStart: digest.periodEnd, digest };
}

describe("hostname, never the internal label", () => {
  it("displaySite maps instinct to its host and keeps hostnames", () => {
    expect(displaySite("instinct")).toBe("wolfpack-instinct.vercel.app");
    expect(displaySite("ogiam.com")).toBe("ogiam.com");
    expect(displaySite(undefined)).toBe("");
  });
  it("the subject, headline and Site row of an instinct alert show the host", () => {
    const e = op(alertFromSignal(signal({ kind: "payload_attack", site: "instinct", attackClass: "xss" }, { reasonKinds: ["payload"], outcomes: { blocked: 1, contained: 0, recorded: 0 } })));
    expect(e.subject).toBe("[Forcefield] wolfpack-instinct.vercel.app: Cross-site scripting blocked (1 attempt)");
    expect(e.text).toContain("Site: wolfpack-instinct.vercel.app");
    expect(e.text).not.toMatch(/\binstinct:/);
  });
});

describe("grouped incident email (hostile_incident)", () => {
  const mixed = () => buildIncidents([
    grp({ attackClass: "open_redirect", count: 14 }),
    grp({ attackClass: "sql_injection", sig: "s2", count: 4, path: "/wp-admin/admin-ajax.php" }),
    grp({ attackClass: "xss", sig: "s3", outcome: "recorded", posture: "monitor", path: "/<b>x</b>", firstAt: "2026-10-26T14:02:46.000Z" }),
  ])[0];

  it("one email lists every class with its count, outcome, times and paths", () => {
    const e = op(alertFromIncident(mixed()));
    expect(e.subject).toBe("[Forcefield] wolfpack-instinct.vercel.app: 3 attack types partly stopped (19 attempts)");
    expect(e.text).toContain("19 attack attempts across 3 attack types on wolfpack-instinct.vercel.app: some were blocked, some only recorded");
    expect(e.text).toContain("3 ATTACK TYPES IN THIS INCIDENT");
    expect(e.text).toContain("- Open redirect: 14 attempts, sources 1, 14 blocked");
    expect(e.text).toContain("- SQL injection: 4 attempts, sources 1, 4 blocked");
    expect(e.text).toContain("- Cross-site scripting: 1 attempt, sources 1, 1 not blocked");
    expect(e.text).toContain("Partly stopped: 18 blocked, 0 sent into the decoy maze, 1 recorded only");
    expect(e.html).toContain("3 attack types in this incident");
    expect(e.html).not.toContain("<b>x</b>");
    expect(e.html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("links land on the site's board, absolute", () => {
    const e = op(alertFromIncident(mixed()));
    expect(e.links[0].href).toBe(`${BASE}/admin/site-analytics?tab=forcefield&view=operator&days=7&site=instinct`);
    for (const l of e.links) expect(l.href.startsWith(BASE)).toBe(true);
    expect(e.html).not.toMatch(/href="\//);
  });

  it("a burst with a decoy trip reads as the trap trip, plus the other classes", () => {
    const [inc] = buildIncidents([
      grp({ kind: "honeytoken_trip", attackClass: "honeytoken_trip", outcome: "contained", reasonKind: "decoy", site: "ogiam.com" }),
      grp({ site: "ogiam.com", attackClass: "path_traversal" }),
    ]);
    expect(op(alertFromIncident(inc)).subject).toBe("[Forcefield] ogiam.com: hostile agent contained (decoy, plus 1 attack type)");
  });

  it("no em dashes", () => {
    const e = op(alertFromIncident(mixed()));
    expect(e.html + e.text + e.subject).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("daily digest email", () => {
  const groups = () => [
    grp({ attackClass: "open_redirect", count: 14, lastAt: "2026-10-26T14:02:46.000Z" }),
    grp({ attackClass: "path_traversal", fp: "fp-c:unknown", sig: "s9", count: 6, path: "/vpn/user/download/client" }),
    grp({ site: "ogiam.com", attackClass: "sql_injection", fp: "fp-z", sig: "z", windowStart: "2026-10-27T06:00:00.000Z", firstAt: "2026-10-27T07:00:00.000Z", path: "/?q=<script>" }),
  ];

  it("subject and headline carry exact totals; the status says no action needed", () => {
    const a = digestAlert(groups());
    const e = op(a);
    expect(e.subject).toBe("[Forcefield] Daily digest Oct 27, 2026: 2 blocked incidents on 2 sites (21 attempts)");
    expect(digestSubject(a.digest!)).toBe(e.subject);
    expect(e.text).toContain("21 attack attempts in 2 incidents on 2 sites, all stopped at the edge");
    expect(e.text).toContain("Blocked at the edge (21 requests)");
    expect(e.text).toContain("No action needed.");
    expect(e.text).toContain("Period: 2026-10-26 12:00:00 UTC (Oct 26, 2026, 8:00:00 AM EDT) to 2026-10-27 12:00:00 UTC (Oct 27, 2026, 8:00:00 AM EDT)");
  });

  it("one table per site (hostname), one row per attack type with attempts, sources, first/last, top paths, outcome", () => {
    const e = op(digestAlert(groups()));
    expect(e.text).toContain("WOLFPACK-INSTINCT.VERCEL.APP");
    expect(e.text).toContain("1 incident · 20 attempts · 2 sources · 20 blocked");
    expect(e.text).toContain("- Open redirect: 14 attempts, sources 1, 14 blocked");
    expect(e.text).toContain("  First 2026-10-26 14:02:44 UTC (Oct 26, 2026, 10:02:44 AM EDT); last 2026-10-26 14:02:46 UTC (Oct 26, 2026, 10:02:46 AM EDT)");
    expect(e.text).toContain("  Path: /vpn/user/download/client");
    expect(e.text).toContain("OGIAM.COM");
    expect(e.html).toContain("Attack type</td>");
    expect(e.html).toContain("Sources</td>");
  });

  it("per-site links are absolute and filtered to the site", () => {
    const e = op(digestAlert(groups()));
    const hrefs = e.links.map((l) => l.href);
    expect(hrefs).toContain(`${BASE}/admin/site-analytics?tab=forcefield&view=operator&days=7&site=instinct`);
    expect(hrefs).toContain(`${BASE}/admin/site-analytics?tab=forcefield&view=operator&days=7&site=ogiam.com`);
    for (const h of hrefs) {
      expect(h.startsWith(BASE)).toBe(true);
      expect(e.text).toContain(h);
      expect(e.html).toContain(h.replace(/&/g, "&amp;"));
    }
    expect(e.html).not.toMatch(/href="\//);
  });

  it("escapes every field and has no em dashes", () => {
    const e = op(digestAlert(groups()));
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("/?q=&lt;script&gt;");
    expect(e.html + e.text + e.subject).not.toContain(String.fromCharCode(0x2014));
  });

  it("counts incidents emailed immediately without repeating them", () => {
    const a = digestAlert([...groups(), grp({ kind: "honeytoken_trip", attackClass: "honeytoken_trip", outcome: "contained", fp: "t", sig: "t", firstAt: "2026-10-26T20:00:00.000Z", windowStart: "2026-10-26T18:00:00.000Z" })]);
    const e = op(a);
    expect(a.digest!.totals.incidents).toBe(2);
    expect(e.text).toContain("Sent immediately: 1 incident (decoy trips or requests not blocked), emailed when they happened");
  });
});
