/** Who counts as one source (ACTOR_KEY_SQL), against a real Postgres. The edge fingerprint is a
 *  header-order tool shape, and on 2026-11-12 one value held verified Googlebot, ClaudeBot and
 *  Applebot traffic and unidentified traffic from dozens of countries: counted by fingerprint, all of
 *  that was one "source". Skipped unless TEST_DATABASE_URL. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";
import { ACTOR_KEY_SQL } from "@/lib/site-analytics-weight";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "178_site_analytics_events.sql");

describeIfDb("site analytics actor key", () => {
  let db: Client;
  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(readFileSync(MIGRATION, "utf8"));
    await db.query("ALTER TABLE site_analytics_events ADD COLUMN IF NOT EXISTS forcefield_tenant_id uuid");
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE site_analytics_events"); });

  const put = (country: string | null, props: Record<string, unknown>) =>
    db.query("INSERT INTO site_analytics_events (event_type, path, country, props) VALUES ('site.agent_flagged', '/', $1, $2)", [country, JSON.stringify(props)]);
  const actors = async () => (await db.query(`SELECT DISTINCT ${ACTOR_KEY_SQL} AS a FROM site_analytics_events ORDER BY 1`)).rows.map((r) => r.a);

  it("one shared fingerprint: verified agents by name, everyone else by fingerprint, country and network", async () => {
    const fp = "aaaa1111:known_crawler";
    await put("US", { fp, agent: "Googlebot", agent_verification: "verified", hosting: "datacenter" });
    await put("US", { fp, agent: "Googlebot", agent_verification: "verified", hosting: "datacenter" });
    await put("US", { fp, agent: "ClaudeBot", agent_verification: "verified", hosting: "datacenter" });
    await put("BR", { fp, agent: "Googlebot", agent_verification: "impersonation", hosting: "residential" });
    await put("DE", { fp, agent: "unidentified", hosting: "residential" });
    await put("DE", { fp, agent: "unidentified", hosting: "residential" });
    await put("US", { fp, agent: "unidentified", hosting: "datacenter" });
    expect(await actors()).toEqual([
      `${fp}|BR|residential`,
      `${fp}|DE|residential`,
      `${fp}|US|datacenter`,
      "agent:ClaudeBot",
      "agent:Googlebot",
    ].sort());
  });

  it("a signed agent is its own actor; no fingerprint falls back to the session key; missing parts never null the key", async () => {
    await put(null, { fp: "x", signed_agent: "true", agent: "" });
    await put(null, { sig: "sess-1" });
    await put(null, {});
    const got = await actors();
    expect(got).toContain("agent:signed");
    expect(got).toContain("sess-1||");
    expect(got).toContain("||");
    expect(got.every((a) => a !== null)).toBe(true);
  });
});
