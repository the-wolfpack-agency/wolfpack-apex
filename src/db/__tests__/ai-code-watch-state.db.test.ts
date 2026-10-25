/**
 * The watcher's memory, run against a REAL Postgres built from the REAL
 * migration 293, with the REAL statements from src/lib/ai-code/watch.ts
 * (WATCH_SQL, through dbWatchMemory). Proves the migration is idempotent, a
 * terminal SHA stays terminal, attempts and the daily count accumulate, "wait"
 * does not count, and workspaces are isolated.
 *
 * Skipped unless TEST_DATABASE_URL is set, like every *.db.test.ts here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireLocalTestDatabase } from "./db-test-safety";

jest.mock("@/lib/db", () => ({ query: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { dbWatchMemory } from "@/lib/ai-code/watch";

const URL = process.env.TEST_DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;
const UP = join(__dirname, "..", "migrations", "293_ai_code_watch_state.sql");
const DOWN = join(__dirname, "..", "migrations", "293_ai_code_watch_state.down.sql");

describeIfDb("ai-code watch memory (migration 293)", () => {
  let db: Client;
  const mem = () => dbWatchMemory((t, p) => db.query(t, p as unknown[]));
  const key = { workspaceId: "w1", repo: "o/r", pr: 6, headSha: "abc" };
  const DAY = "2026-10-08";

  beforeAll(async () => {
    db = new Client({ connectionString: requireLocalTestDatabase(URL) });
    await db.connect();
    await db.query(readFileSync(DOWN, "utf8"));
    const sql = readFileSync(UP, "utf8");
    await db.query(sql);
    await db.query(sql); // idempotent
  });
  afterAll(async () => {
    await db?.end();
  });
  beforeEach(async () => {
    await db.query(`TRUNCATE instinct_ai_code_watch_state, instinct_ai_code_watch_daily`);
  });

  it("an unseen SHA has no state and zero daily attempts", async () => {
    expect(await mem().get(key)).toBeNull();
    expect(await mem().dailyAttempts(key, DAY)).toBe(0);
  });

  it("accumulates attempts and the daily count; wait is free", async () => {
    const m = mem();
    await m.record(key, DAY, { action: "escalate", terminal: false, counts: true });
    await m.record(key, DAY, { action: "wait", terminal: false, counts: false });
    const r = await m.record(key, DAY, { action: "escalate", terminal: false, counts: true });
    expect(r.state.attempts).toBe(2);
    expect(r.dailyAttempts).toBe(2);
    expect(await m.dailyAttempts(key, DAY)).toBe(2);
  });

  it("terminal is sticky", async () => {
    const m = mem();
    await m.record(key, DAY, { action: "escalate", terminal: true, counts: true });
    await m.record(key, DAY, { action: "wait", terminal: false, counts: false });
    expect((await m.get(key))?.terminal).toBe(true);
  });

  it("a new SHA starts fresh but shares the PR's daily count", async () => {
    const m = mem();
    await m.record(key, DAY, { action: "escalate", terminal: true, counts: true });
    const next = { ...key, headSha: "def" };
    expect(await m.get(next)).toBeNull();
    const r = await m.record(next, DAY, { action: "fix_committed", terminal: false, counts: true });
    expect(r.dailyAttempts).toBe(2);
  });

  it("is workspace-isolated", async () => {
    await mem().record(key, DAY, { action: "escalate", terminal: true, counts: true });
    expect(await mem().get({ ...key, workspaceId: "w2" })).toBeNull();
  });

  it("rejects a negative attempt count", async () => {
    await expect(
      db.query(`INSERT INTO instinct_ai_code_watch_daily (workspace_id, repo, pr_number, day, attempts) VALUES ('w','r',1,'2026-10-08',-1)`),
    ).rejects.toThrow();
  });
});
