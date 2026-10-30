/** Repeat decoy / honeytoken trips collapse into one row per source per 10 minutes, against a real
 *  Postgres (the UPDATE ... WHERE id = (subselect) SQL in recordSiteEvent). A looping scraper
 *  in the decoy maze would otherwise write one row per maze page. Skipped unless TEST_DATABASE_URL. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const MIGRATION = join(__dirname, "..", "migrations", "178_site_analytics_events.sql");

describeIfDb("site analytics repeat collapse (recordSiteEvent)", () => {
  let db: Client;
  let recordSiteEvent: (input: Parameters<typeof import("@/lib/site-analytics").recordSiteEventWith>[1]) => Promise<void>;
  const maze = (fp: string, extra: Record<string, unknown> = {}) => ({
    eventType: "site.agent_trap_tripped" as const,
    path: "/_ff/index-abc123",
    props: { site: "ogiam.com", fp, reason_kind: "decoy", tarpit: true, ...extra },
  });

  beforeAll(async () => {
    const url = requireLocalTestDatabase(URL);
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(readFileSync(MIGRATION, "utf8"));
    // Column added by migration 284 (which also builds the tenant registry this test does not need).
    await db.query("ALTER TABLE site_analytics_events ADD COLUMN IF NOT EXISTS forcefield_tenant_id uuid");
    // The app's pool requires SSL, which a local test database has not; the same write runs on this
    // client through recordSiteEventWith, so the SQL under test is exactly the production SQL.
    const { recordSiteEventWith } = await import("@/lib/site-analytics");
    recordSiteEvent = (input) => recordSiteEventWith((text, params) => db.query(text, params), input);
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => { await db.query("TRUNCATE site_analytics_events"); });

  const rows = async () => (await db.query("SELECT event_type, props FROM site_analytics_events ORDER BY id")).rows;

  it("50 maze pages from one source are one row with repeat_count 50", async () => {
    for (let i = 0; i < 50; i++) await recordSiteEvent(maze("fpA"));
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(Number(r[0].props.repeat_count)).toBe(50);
    expect(typeof r[0].props.last_seen).toBe("string");
  });

  it("different sources, kinds and sites stay separate", async () => {
    await recordSiteEvent(maze("fpA"));
    await recordSiteEvent(maze("fpB"));
    await recordSiteEvent(maze("fpA", { reason_kind: "honeytoken" }));
    await recordSiteEvent(maze("fpA", { site: "weekendwithporsche" }));
    await recordSiteEvent(maze("fpA"));
    expect(await rows()).toHaveLength(4);
  });

  it("a row older than the window is not extended; a new row starts", async () => {
    await recordSiteEvent(maze("fpA"));
    await db.query("UPDATE site_analytics_events SET created_at = now() - interval '11 minutes'");
    await recordSiteEvent(maze("fpA"));
    expect(await rows()).toHaveLength(2);
  });

  it("synthetic probes are never folded (each is its own exact row)", async () => {
    for (let i = 0; i < 3; i++) await recordSiteEvent(maze("fpA", { synthetic: true }));
    await recordSiteEvent(maze("fpA"));
    await recordSiteEvent(maze("fpA"));
    const r = await rows();
    expect(r.filter((x) => x.props.synthetic === true)).toHaveLength(3);
    expect(r.filter((x) => x.props.synthetic !== true)).toHaveLength(1);
  });

  it("other event types are never folded", async () => {
    for (let i = 0; i < 3; i++) await recordSiteEvent({ eventType: "site.agent_payload_attack", path: "/", props: { site: "ogiam.com", fp: "fpA" } });
    expect(await rows()).toHaveLength(3);
  });

  it("the attempt count sums repeat_count (EVENT_WEIGHT_SQL)", async () => {
    const { EVENT_WEIGHT_SQL } = await import("@/lib/site-analytics-weight");
    for (let i = 0; i < 7; i++) await recordSiteEvent(maze("fpA"));
    await recordSiteEvent(maze("fpB"));
    const r = await db.query(`SELECT count(*)::int AS n_rows, sum(${EVENT_WEIGHT_SQL})::int AS attempts FROM site_analytics_events`);
    expect(r.rows[0]).toEqual({ n_rows: 2, attempts: 8 });
  });
});
