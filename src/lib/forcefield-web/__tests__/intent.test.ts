/** @jest-environment node */
import {
  IntentLedger,
  INTENT_THRESHOLDS,
  INTENT_WEIGHTS,
  INTENT_WINDOW_MS,
  PROOF_WEIGHTS,
  RAPID_DISTINCT_PATHS,
  TARPIT_DELAY_MS,
  TARPIT_MAX_DELAY_MS,
  carriesOver,
  coerceCarryover,
  decideIntent,
  intentEventProps,
  intentSessionKey,
  payloadShaped,
  productForPath,
  reconSignal,
  intentSignalsFor,
  resolveStackProfile,
  runtimeForPath,
  type IntentSignal,
} from "@/lib/forcefield-web/intent";
import { DEFAULT_RULESET, coerceRuleset } from "@/lib/forcefield-web/ruleset";

const NEXT = resolveStackProfile({ stack: ["nextjs"] });
const WP = resolveStackProfile({ platform: "wordpress" });
const T0 = 1_800_000_000_000;

function sig(path: string, clientType = "unknown", profile = NEXT, extra: Partial<Parameters<typeof intentSignalsFor>[0]> = {}): IntentSignal[] {
  return intentSignalsFor({ path, clientType, ...extra }, profile, DEFAULT_RULESET);
}

/** Feed a sequence of requests through one session; return the last decision. */
function run(paths: string[], opts: { clientType?: string; profile?: ReturnType<typeof resolveStackProfile>; proofAt?: number; scope?: "client" | "sig"; posture?: "watch" | "enforce"; stepMs?: number } = {}) {
  const ledger = new IntentLedger();
  const ct = opts.clientType ?? "unknown";
  let last = decideIntent({ score: 0, reasons: [], details: [] }, { posture: opts.posture ?? "enforce", keyScope: opts.scope ?? "client", clientType: ct });
  const actions: string[] = [];
  paths.forEach((p, i) => {
    const intent = ledger.note("k", T0 + i * (opts.stepMs ?? 1000), {
      path: p,
      signals: sig(p, ct, opts.profile ?? NEXT),
      proof: opts.proofAt === i ? "decoy" : undefined,
      nonBrowser: ct !== "browser",
    });
    last = decideIntent(intent, { posture: opts.posture ?? "enforce", keyScope: opts.scope ?? "client", clientType: ct });
    actions.push(last.action);
  });
  return { last, actions, ledger };
}

describe("stack profile", () => {
  it("resolves a declared stack to runtimes + products", () => {
    expect(NEXT).toMatchObject({ known: true, runtimes: ["node"], products: ["nextjs"], source: "declared" });
    expect(WP).toMatchObject({ known: true, runtimes: ["php"], products: ["wordpress"] });
  });
  it("is UNKNOWN with no declaration or an unrecognized token (recon scoring off, never guessed)", () => {
    expect(resolveStackProfile({}).known).toBe(false);
    expect(resolveStackProfile({ platform: "generic" }).known).toBe(false);
    expect(resolveStackProfile({ stack: ["nextjs", "mystery-cms"] }).known).toBe(false);
  });
  it("an explicit stack wins over the platform", () => {
    expect(resolveStackProfile({ stack: ["wordpress"], platform: "vercel" }).products).toEqual(["wordpress"]);
  });
  it("accepts centrally distributed stack components", () => {
    const p = resolveStackProfile({ stack: ["joomla"] }, { stackComponents: { joomla: { runtimes: ["php"], products: ["joomla"] } } });
    expect(p).toMatchObject({ known: true, products: ["joomla"] });
  });
});

describe("reconnaissance signal", () => {
  it("names the foreign product a Next.js site was asked for", () => {
    expect(reconSignal("/bitrix/admin/index.php", NEXT)).toEqual({ id: "recon_foreign_product", detail: "bitrix" });
    expect(reconSignal("/reports/rwservlet", NEXT)?.detail).toBe("oracle_reports");
    expect(reconSignal("/remote/fgt_lang", NEXT)?.detail).toBe("fortinet_sslvpn");
    expect(reconSignal("/dana-na/auth/url_default/welcome.cgi", NEXT)?.detail).toBe("ivanti_connect_secure");
    expect(reconSignal("/global-protect/login.esp", NEXT)?.detail).toBe("paloalto_globalprotect");
    expect(reconSignal("/+CSCOE+/logon.html", NEXT)?.detail).toBe("cisco_asa");
    expect(reconSignal("/___proxy_subdomain_whm/login", NEXT)?.detail).toBe("cpanel");
    expect(reconSignal("/wp-login.php", NEXT, DEFAULT_RULESET)?.detail).toBe("wordpress");
  });
  it("a WordPress site requesting its own wp-admin is NOT recon", () => {
    expect(reconSignal("/wp-admin/", WP, DEFAULT_RULESET)).toBeNull();
    expect(reconSignal("/wp-login.php", WP, DEFAULT_RULESET)).toBeNull();
    expect(sig("/wp-admin/", "browser", WP, { probe: "/wp-admin" })).toEqual([]);
    expect(reconSignal("/index.php", WP)).toBeNull();
  });
  it("a WordPress site asked for a foreign product still is", () => {
    expect(reconSignal("/bitrix/rk.php", WP)?.detail).toBe("bitrix");
    expect(reconSignal("/login.action", WP)).toEqual({ id: "recon_foreign_runtime", detail: "java" });
  });
  it("server-side extensions the runtime never serves are recon on a Node site", () => {
    expect(reconSignal("/phpinfo.php", NEXT)).toEqual({ id: "recon_foreign_runtime", detail: "php" });
    expect(reconSignal("/RDWeb/Pages/en-US/login.aspx", NEXT)?.id).toBe("recon_foreign_product");
    expect(reconSignal("/index.action", NEXT)?.detail).toBe("java");
    expect(runtimeForPath("/a/b.JSP")).toBe("java");
  });
  it("ordinary paths of a Next.js site are never recon", () => {
    for (const p of ["/", "/pricing", "/admin", "/admin/login", "/api/analytics", "/_next/static/x.js", "/sitemap.xml", "/robots.txt", "/blog/php-tips", "/administration", "/solrs", "/owa-guide"]) {
      expect(reconSignal(p, NEXT)).toBeNull();
    }
  });
  it("an unknown profile never produces recon", () => {
    expect(reconSignal("/bitrix/rk.php", resolveStackProfile({}))).toBeNull();
  });
  it("product catalog is extensible from the ruleset", () => {
    expect(productForPath("/newvpn/login", { productPaths: { newvpn: ["/newvpn"] } })).toBe("newvpn");
  });
});

describe("per-request signals", () => {
  it("welcomed agents and authenticated requests score nothing", () => {
    expect(sig("/old-page.php", "known_crawler", NEXT, { welcomed: true })).toEqual([]);
    expect(sig("/bitrix/x", "headless", NEXT, { authenticated: true })).toEqual([]);
  });
  it("a sensitive probe counts only when not already a recon hit (no double count)", () => {
    expect(sig("/.env", "unknown", NEXT, { probe: "/.env" }).map((s) => s.id)).toEqual(["sensitive_probe", "automation_client"]);
    expect(sig("/wp-login.php", "unknown", NEXT, { probe: "/wp-login.php" }).map((s) => s.id)).toEqual(["recon_foreign_product", "automation_client"]);
  });
  it("decoy proximity fires near the decoy namespace but not on the decoy itself", () => {
    expect(sig("/_ff/other", "browser").map((s) => s.id)).toEqual(["decoy_proximity"]);
    expect(sig("/_ff/records", "browser")).toEqual([]);
  });
  it("payload-shaped parameters: true positives", () => {
    for (const u of ["/item?id=12'", "/item?id=12%27", "/s?q=%22%3E%3Cx", "/p?name=${7", "/p?t={{x", "/f?file=a%00.png"]) {
      expect(payloadShaped(u)).toBe(true);
    }
  });
  it("payload-shaped parameters: true negatives (real inputs)", () => {
    for (const u of ["/search?q=O'Brien", "/p?id=12", "/p?a=1&b=2", "/no-query", "/search?q=it's+fine", "/r?x=price+%3E+5"]) {
      expect(payloadShaped(u)).toBe(false);
    }
  });
  it("browser and crawler clients never carry the automation tell", () => {
    expect(sig("/", "browser")).toEqual([]);
    expect(sig("/", "known_crawler")).toEqual([]);
    expect(sig("/x.js", "headless", NEXT, { staticAsset: true })).toEqual([]);
  });
});

describe("scoring, thresholds and step-up", () => {
  it("documents the weights and thresholds", () => {
    expect(INTENT_THRESHOLDS).toEqual({ watch: 2, tarpit: 6, block: 6 });
    expect(INTENT_WEIGHTS.recon_foreign_product).toBe(3);
    expect(PROOF_WEIGHTS.decoy).toBeGreaterThanOrEqual(INTENT_THRESHOLDS.block);
    expect(PROOF_WEIGHTS.payload).toBeLessThan(INTENT_THRESHOLDS.block);
  });
  it("one stray recon hit only WATCHES", () => {
    expect(run(["/wp-login.php"]).last.action).toBe("watch");
  });
  it("TRUE POSITIVE: a WordPress plugin sweep on a Next.js site steps up to tarpit before any payload", () => {
    const r = run(["/wp-content/plugins/pods/readme.txt", "/wp-content/plugins/pods/init.php"]);
    expect(r.actions).toEqual(["watch", "tarpit"]);
    expect(r.last.applied).toBe(true);
    expect(r.last.delayMs).toBe(TARPIT_DELAY_MS + 250);
    expect(r.last.decoy).toBe(true);
    expect(r.last.summary).toMatch(/^held back early because the session asked for a product this site does not run/);
  });
  it("TRUE POSITIVE: an appliance VPN portal tour (Fortinet, Pulse, GlobalProtect) tarpits by the second portal", () => {
    expect(run(["/remote/login", "/dana-na/", "/global-protect/login.esp"], { clientType: "browser" }).actions).toEqual(["watch", "tarpit", "tarpit"]);
  });
  it("TRUE POSITIVE: PHP webshell hunting on a Node site", () => {
    expect(run(["/000.php", "/chosen.php", "/gifclass.php"], { clientType: "scripted_library" }).actions).toEqual(["watch", "tarpit", "tarpit"]);
  });
  it("the tarpit delay is bounded", () => {
    const many = Array.from({ length: 30 }, (_, i) => `/x${i}.php`);
    expect(run(many).last.delayMs).toBe(TARPIT_MAX_DELAY_MS);
  });
  it("TRUE NEGATIVE: normal browsing of a Next.js site never steps up", () => {
    const r = run(["/", "/pricing", "/about", "/blog", "/blog/a", "/contact", "/api/analytics", "/admin/login"], { clientType: "browser" });
    expect(r.actions.every((a) => a === "none")).toBe(true);
  });
  it("TRUE NEGATIVE: a WordPress site's own admin traffic never steps up", () => {
    const r = run(["/wp-admin/", "/wp-login.php", "/wp-admin/post.php", "/wp-json/wp/v2/posts", "/xmlrpc.php"], { profile: WP, clientType: "browser" });
    expect(r.actions.every((a) => a === "none")).toBe(true);
  });
  it("the same recon path repeated counts once", () => {
    expect(run(["/wp-login.php", "/wp-login.php", "/wp-login.php"], { clientType: "browser" }).last.score).toBe(3);
  });
  it("signals expire after the window", () => {
    const ledger = new IntentLedger();
    ledger.note("k", T0, { path: "/bitrix/a", signals: sig("/bitrix/a", "browser") });
    const later = ledger.note("k", T0 + INTENT_WINDOW_MS + 1, { path: "/bitrix/b", signals: sig("/bitrix/b", "browser") });
    expect(later.score).toBe(3);
  });
  it("rapid enumeration by a non-browser client adds once", () => {
    const paths = Array.from({ length: RAPID_DISTINCT_PATHS }, (_, i) => `/p${i}`);
    const r = run(paths, { clientType: "scripted_library", stepMs: 100 });
    expect(r.last.reasons).toContain("rapid_enumeration");
    expect(r.last.score).toBe(INTENT_WEIGHTS.automation_client + INTENT_WEIGHTS.rapid_enumeration);
    expect(r.last.action).toBe("watch");
  });
  it("posture watch records the decision without applying it", () => {
    const r = run(["/bitrix/a", "/bitrix/b"], { posture: "watch" });
    expect(r.last.action).toBe("tarpit");
    expect(r.last.applied).toBe(false);
  });
  it("shouldReport fires once per step-up, not per request", () => {
    const ledger = new IntentLedger();
    ledger.note("k", T0, { path: "/bitrix/a", signals: sig("/bitrix/a") });
    expect(ledger.shouldReport("k", "watch")).toBe(true);
    expect(ledger.shouldReport("k", "watch")).toBe(false);
    expect(ledger.shouldReport("k", "tarpit")).toBe(true);
    expect(ledger.shouldReport("k", "watch")).toBe(false);
    expect(ledger.shouldReport("missing", "block")).toBe(false);
  });
  it("is bounded in memory (oldest session evicted)", () => {
    const ledger = new IntentLedger(3);
    for (let i = 0; i < 10; i++) ledger.note(`k${i}`, T0, { path: "/", signals: [] });
    expect(ledger.size).toBe(3);
  });
});

describe("generic-fingerprint safeguard: intent alone never blocks", () => {
  it("any amount of intent without proof stops at tarpit", () => {
    const many = Array.from({ length: 40 }, (_, i) => `/bitrix/p${i}`);
    expect(run(many).last.action).toBe("tarpit");
  });
  it("a decoy taken blocks the session's FOLLOW-ON requests (client-scoped key)", () => {
    const r = run(["/_ff/records", "/", "/contact"], { proofAt: 0 });
    expect(r.actions).toEqual(["block", "block", "block"]);
    expect(r.last.summary).toMatch(/then proved hostile \(decoy\)/);
  });
  it("one payload alone does not make a sticky block (payload signatures can, rarely, match a real input)", () => {
    const ledger = new IntentLedger();
    const i = ledger.note("k", T0, { path: "/s", signals: [], proof: "payload" });
    expect(decideIntent(i, { posture: "enforce", keyScope: "client", clientType: "browser" }).action).toBe("watch");
    const j = ledger.note("k", T0 + 1, { path: "/wp-login.php", signals: sig("/wp-login.php", "browser"), proof: undefined });
    expect(decideIntent(j, { posture: "enforce", keyScope: "client", clientType: "browser" }).action).toBe("block");
  });
  it("never blocks on a shared hourly sig, and caps a browser on a sig key at watch", () => {
    expect(run(["/_ff/records", "/"], { proofAt: 0, scope: "sig" }).last.action).toBe("tarpit");
    expect(run(["/bitrix/a", "/bitrix/b"], { scope: "sig", clientType: "browser" }).last.action).toBe("watch");
  });
});

describe("cross-site carryover", () => {
  const entries = [{ fp: "abcd1234:nuclei", expiresAt: new Date(T0 + 60_000).toISOString() }];
  it("a distributed hostile fingerprint carries over until it expires", () => {
    expect(carriesOver("abcd1234:nuclei", "unknown", entries, T0)).toBe(true);
    expect(carriesOver("abcd1234:nuclei", "unknown", entries, T0 + 60_001)).toBe(false);
    expect(carriesOver("other:nuclei", "unknown", entries, T0)).toBe(false);
  });
  it("never carries over a browser client (defense in depth)", () => {
    expect(carriesOver("abcd1234:nuclei", "browser", entries, T0)).toBe(false);
  });
  it("carryover tarpits from the first request but never blocks", () => {
    const ledger = new IntentLedger();
    const i = ledger.note("k", T0, { path: "/", signals: [], carryover: true });
    const d = decideIntent(i, { posture: "enforce", keyScope: "client", clientType: "unknown" });
    expect(d.action).toBe("tarpit");
    expect(d.reasons).toEqual(["carryover_hostile"]);
  });
  it("validates the distributed list strictly", () => {
    expect(coerceCarryover(entries)).toEqual(entries);
    expect(coerceCarryover([{ fp: "x", expiresAt: "not a date" }])).toEqual([]);
    expect(coerceCarryover("nope")).toEqual([]);
    const rs = coerceRuleset({ ...DEFAULT_RULESET, intentCarryover: entries });
    expect(rs?.intentCarryover).toEqual(entries);
    expect(coerceRuleset({ ...DEFAULT_RULESET, intentCarryover: [{ bad: 1 }] })?.intentCarryover).toEqual([]);
  });
});

describe("session key + event props (no PII)", () => {
  it("hashes the client IP and never returns it", () => {
    const k = intentSessionKey({ ip: "203.0.113.9", userAgent: "ua", headerShape: "h", sig: "s1" });
    expect(k.scope).toBe("client");
    expect(k.key).not.toContain("203.0.113.9");
    expect(intentSessionKey({ userAgent: "ua", headerShape: "h", sig: "s1" })).toEqual({ key: "s:s1", scope: "sig" });
  });
  it("event props fit the ingest 12-key cap and carry ids only", () => {
    const d = run(["/bitrix/a", "/bitrix/b"]).last;
    const props = intentEventProps(d, { site: "instinct", sig: "s", fp: "f:unknown", clientType: "unknown" });
    expect(Object.keys(props).length).toBeLessThanOrEqual(12);
    expect(props).toMatchObject({ intent_action: "tarpit", intent_applied: true, intent_details: "bitrix" });
  });
});
