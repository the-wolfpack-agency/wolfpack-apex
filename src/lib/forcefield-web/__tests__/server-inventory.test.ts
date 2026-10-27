/** @jest-environment node */
/**
 * Server inventory: strict validation (versions only, nothing else rides along),
 * the latest-per-tenant upsert, and the new-exposure alert: sent once to a
 * CONFIRMED address only, claimed before sending, released when not delivered,
 * and rendered in plain words. The real-Postgres proof of the SQL is
 * src/db/__tests__/forcefield-server-inventory.db.test.ts.
 */
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));

import {
  validateInventory,
  receiveServerInventory,
  getServerExposure,
  UPSERT_INVENTORY_SQL,
  CLAIM_ALERT_SQL,
  RELEASE_ALERT_SQL,
  MAX_PLUGINS,
  type InventoryDeps,
} from "../server-inventory";
import { renderExposureEmail } from "../tenant-email";
import type { TenantQuery } from "../tenants";

const TENANT = { id: "11111111-1111-4111-8111-111111111111", siteLabel: "acme.example" };
const GOOD = { phpVersion: "8.3.10", wordpressVersion: "6.8.3", serverSoftware: "Apache/2.4.62", plugins: [{ slug: "akismet", version: "5.3" }], pluginVersion: "0.4.0" };

describe("validateInventory", () => {
  it("accepts the plugin's payload and normalizes plugins (lowercase, deduped, sorted)", () => {
    const v = validateInventory({ ...GOOD, plugins: [{ slug: "Zeta", version: "1.0" }, { slug: "akismet", version: "5.3" }, { slug: "zeta", version: "2.0" }] });
    expect(v).toEqual({ ok: true, inventory: { ...GOOD, plugins: [{ slug: "akismet", version: "5.3" }, { slug: "zeta", version: "1.0" }] } });
  });

  it("treats empty optional strings as unknown (null)", () => {
    const v = validateInventory({ phpVersion: "8.4.1", wordpressVersion: "", serverSoftware: "", plugins: [] });
    expect(v).toMatchObject({ ok: true, inventory: { wordpressVersion: null, serverSoftware: null, pluginVersion: null } });
  });

  it.each([
    ["not an object", "nope", "not_an_object"],
    ["an array", [GOOD], "not_an_object"],
    ["null", null, "not_an_object"],
    ["an extra field (no other site data)", { ...GOOD, adminEmail: "a@b.c" }, "unknown_field"],
    ["a non-string PHP version", { ...GOOD, phpVersion: 8.3 }, "bad_php_version"],
    ["an oversize PHP version", { ...GOOD, phpVersion: "8".repeat(41) }, "bad_php_version"],
    ["a control character", { ...GOOD, wordpressVersion: "6.8\n" + "x" }, "bad_wordpress_version"],
    ["an oversize server string", { ...GOOD, serverSoftware: "A".repeat(121) }, "bad_server_software"],
    ["no versions at all", { plugins: [] }, "empty_inventory"],
    ["plugins not an array", { ...GOOD, plugins: { akismet: "5.3" } }, "bad_plugins"],
    ["a plugin with an extra field", { ...GOOD, plugins: [{ slug: "a", version: "1", path: "/var/www" }] }, "bad_plugins"],
    ["a bad slug", { ...GOOD, plugins: [{ slug: "../etc", version: "1" }] }, "bad_plugins"],
    ["too many plugins", { ...GOOD, plugins: Array.from({ length: MAX_PLUGINS + 1 }, (_, i) => ({ slug: `p${i}`, version: "1" })) }, "bad_plugins"],
  ])("refuses %s", (_label, raw, error) => {
    expect(validateInventory(raw)).toEqual({ ok: false, error });
  });
});

function fakeDb(alerted: string[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let keys = [...alerted];
  const q: TenantQuery = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql === UPSERT_INVENTORY_SQL) {
      const current = params[6] as string[];
      keys = keys.filter((k) => current.includes(k));
      return [{ alerted_keys: keys, reports: 1 }] as never;
    }
    if (sql === CLAIM_ALERT_SQL) {
      const want = params[1] as string[];
      if (want.some((k) => keys.includes(k))) return [] as never;
      keys = [...new Set([...keys, ...want])].sort();
      return [{ tenant_id: TENANT.id }] as never;
    }
    if (sql === RELEASE_ALERT_SQL) {
      const drop = params[1] as string[];
      keys = keys.filter((k) => !drop.includes(k));
      return [] as never;
    }
    return [] as never;
  };
  return { q, calls, keys: () => keys };
}

const confirmed = async () => ({ email: "owner@thewolfpack.agency", status: "confirmed" as const, confirmedAt: "2026-10-27T00:00:00Z" });
const deps = (over: Partial<InventoryDeps> & { q: TenantQuery }): InventoryDeps => ({
  notifyState: confirmed,
  send: jest.fn(async () => ({ delivered: true, reason: "ok" })),
  baseUrl: "https://ff.example",
  unsubscribeToken: () => "unsub-token",
  ...over,
});

describe("receiveServerInventory", () => {
  it("stores the inventory and reports up to date without an email", async () => {
    const db = fakeDb();
    const d = deps({ q: db.q });
    const r = await receiveServerInventory(TENANT, { ...GOOD, phpVersion: "8.3.36" }, d);
    expect(r).toMatchObject({ ok: true, reason: "ok", alert: "none", newExposures: [] });
    expect(r.report!.status).toBe("ok");
    const up = db.calls.find((c) => c.sql === UPSERT_INVENTORY_SQL)!;
    expect(up.params.slice(0, 6)).toEqual([TENANT.id, "8.3.36", "6.8.3", "Apache/2.4.62", JSON.stringify([{ slug: "akismet", version: "5.3" }]), "0.4.0"]);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a new exposure emails the confirmed address once, in plain words", async () => {
    const db = fakeDb();
    const send = jest.fn(async () => ({ delivered: true, reason: "ok" }));
    const r = await receiveServerInventory(TENANT, GOOD, deps({ q: db.q, send }));
    expect(r.alert).toBe("sent");
    expect(r.newExposures!.map((f) => f.key)).toEqual(["php2shell:php"]);
    expect(send).toHaveBeenCalledTimes(1);
    const mail = (send.mock.calls[0] as unknown[])[0] as { to: string; subject: string; text: string; purpose: string };
    expect(mail.to).toBe("owner@thewolfpack.agency");
    expect(mail.purpose).toBe("exposure");
    expect(mail.subject).toBe("Your server for acme.example runs PHP 8.3.10, which is open to PHP2Shell, PHP server takeover");
    expect(mail.text).toContain("Ask them to move this site to PHP 8.3.36 or later");
    expect(db.keys()).toEqual(["php2shell:php"]);

    // The next daily report with the same exposure does not email again.
    const again = await receiveServerInventory(TENANT, GOOD, deps({ q: db.q, send }));
    expect(again.alert).toBe("none");
    expect(again.report!.status).toBe("exposed");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("once fixed the key is pruned, so a later regression alerts again", async () => {
    const db = fakeDb(["php2shell:php"]);
    const send = jest.fn(async () => ({ delivered: true, reason: "ok" }));
    await receiveServerInventory(TENANT, { ...GOOD, phpVersion: "8.3.36" }, deps({ q: db.q, send }));
    expect(db.keys()).toEqual([]);
    const back = await receiveServerInventory(TENANT, GOOD, deps({ q: db.q, send }));
    expect(back.alert).toBe("sent");
  });

  it("no confirmed address: no email, nothing claimed (a later report can still alert)", async () => {
    const db = fakeDb();
    const send = jest.fn();
    const r = await receiveServerInventory(TENANT, GOOD, deps({ q: db.q, send, notifyState: async () => ({ email: "owner@thewolfpack.agency", status: "pending", confirmedAt: null }) }));
    expect(r.alert).toBe("not_confirmed");
    expect(send).not.toHaveBeenCalled();
    expect(db.keys()).toEqual([]);
  });

  it("a refused or failed send releases the claim", async () => {
    const db = fakeDb();
    const r = await receiveServerInventory(TENANT, GOOD, deps({ q: db.q, send: async () => ({ delivered: false, reason: "recipient_not_allowlisted" }) }));
    expect(r.alert).toBe("not_delivered:recipient_not_allowlisted");
    expect(db.keys()).toEqual([]);
  });

  it("a concurrent report that already claimed the key does not send twice", async () => {
    const db = fakeDb();
    const q: TenantQuery = async (sql, params) => (sql === CLAIM_ALERT_SQL ? ([] as never) : db.q(sql, params));
    const send = jest.fn();
    const r = await receiveServerInventory(TENANT, GOOD, deps({ q, send }));
    expect(r.alert).toBe("already_claimed");
    expect(send).not.toHaveBeenCalled();
  });

  it("invalid payload never touches the database; a database failure is an error, not a throw", async () => {
    const db = fakeDb();
    expect(await receiveServerInventory(TENANT, { nope: 1 }, deps({ q: db.q }))).toEqual({ ok: false, reason: "invalid", error: "unknown_field" });
    expect(db.calls).toHaveLength(0);
    const boom: TenantQuery = async () => { throw new Error("down"); };
    expect(await receiveServerInventory(TENANT, GOOD, deps({ q: boom }))).toEqual({ ok: false, reason: "error" });
  });
});

describe("getServerExposure", () => {
  it("null report before the first inventory; computed findings after", async () => {
    expect(await getServerExposure(TENANT.id, { q: async () => [] as never })).toEqual({ report: null });
    const row = { php_version: "7.4.33", wordpress_version: "6.8.3", server_software: "nginx/1.27", plugins: JSON.stringify([{ slug: "wp-file-manager", version: "6.8" }]), plugin_version: "0.4.0", alerted_keys: [], reports: 3, first_received_at: "2026-10-20 00:00:00+00", received_at: "2026-10-27 00:00:00+00" };
    const v = await getServerExposure(TENANT.id, { q: async () => [row] as never });
    expect(v!.report).toMatchObject({ status: "exposed", phpVersion: "7.4.33", wordpressVersion: "6.8.3", receivedAt: "2026-10-27 00:00:00+00" });
    expect(v!.report!.findings.filter((f) => f.state === "exposed").map((f) => f.key)).toEqual(["php2shell:php", "wp_file_manager_rce:wp-file-manager"]);
  });

  it("a failed read is null (the route answers 503)", async () => {
    expect(await getServerExposure(TENANT.id, { q: async () => { throw new Error("x"); } })).toBeNull();
  });
});

describe("renderExposureEmail", () => {
  const finding = { productName: "PHP", installed: "8.1.2", flaw: "PHP2Shell, PHP server takeover", impact: "a single crafted request can take over the server", fixedVersion: "8.2.35", howToFix: "Ask your host <b>now</b>.", cves: ["CVE-2026-109618"] };

  it("escapes every field and links to the dashboard and unsubscribe", () => {
    const m = renderExposureEmail({ site: "acme.example", to: "o@thewolfpack.agency", findings: [finding], baseUrl: "https://ff.example", unsubscribeToken: "tok" });
    expect(m.html).not.toContain("<b>now</b>");
    expect(m.html).toContain("&lt;b&gt;now&lt;/b&gt;");
    expect(m.links.map((l) => l.href)).toEqual(["https://ff.example/forcefield/dashboard", "https://ff.example/forcefield/dashboard", "https://ff.example/forcefield/unsubscribe?token=tok"]);
    expect(m.text).toContain("Fixed in: PHP 8.2.35 or later");
    expect(m.text).toContain("no WordPress plugin can block them");
    expect(`${m.subject}${m.text}`).not.toMatch(/—/);
  });

  it("several findings get a count subject", () => {
    const m = renderExposureEmail({ site: "acme.example", to: "o@thewolfpack.agency", findings: [finding, { ...finding, productName: "File Manager plugin" }], baseUrl: "https://ff.example", unsubscribeToken: "tok" });
    expect(m.subject).toBe("2 actively exploited flaws affect the server for acme.example");
  });
});
