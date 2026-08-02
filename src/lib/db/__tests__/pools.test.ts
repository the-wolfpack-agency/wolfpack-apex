/**
 * One pool per tenant, lazily created and bounded.
 *
 * The cap is the point. A serverless function that opens a pool per tenant and
 * never closes one exhausts Neon's per-project connection limit, and the
 * failure lands as intermittent "too many connections" on whichever client
 * happens to be next — an outage that looks random and is not.
 */
import { closeAllTenantPools, getTenantPool, openTenantPools, poolConfigFor, MAX_TENANT_POOLS } from "../pools";
import type { Pool, PoolConfig } from "pg";

/** A pool that never opens a socket, and records whether it was drained. */
function fakePool(): Pool & { ended: boolean } {
  const p = {
    ended: false,
    end: jest.fn(async function (this: { ended: boolean }) {
      this.ended = true;
    }),
    on: jest.fn(),
    query: jest.fn(),
    connect: jest.fn(),
  };
  return p as unknown as Pool & { ended: boolean };
}

let created: { config: PoolConfig; pool: Pool & { ended: boolean } }[] = [];
const factory = (config: PoolConfig) => {
  const p = fakePool();
  created.push({ config, pool: p });
  return p;
};

let clock = 0;
const now = () => ++clock;

beforeEach(async () => {
  await closeAllTenantPools();
  created = [];
  clock = 0;
});

afterAll(async () => {
  await closeAllTenantPools();
});

describe("pools are created lazily and reused", () => {
  it("creates one pool per tenant, not one per call", () => {
    getTenantPool("acme", "postgres://a", { factory, now });
    getTenantPool("acme", "postgres://a", { factory, now });
    getTenantPool("acme", "postgres://a", { factory, now });
    expect(created).toHaveLength(1);
  });

  it("returns the SAME pool for the same tenant", () => {
    const first = getTenantPool("acme", "postgres://a", { factory, now });
    expect(getTenantPool("acme", "postgres://a", { factory, now })).toBe(first);
  });

  it("keeps different tenants on different pools", () => {
    const a = getTenantPool("acme", "postgres://a", { factory, now });
    const b = getTenantPool("beta", "postgres://b", { factory, now });
    expect(a).not.toBe(b);
    expect(openTenantPools()).toEqual(["acme", "beta"]);
  });

  it("does not connect to a tenant it has not served", () => {
    // A deployment configured for twenty clients may serve one in a given
    // instance; connecting to all twenty at boot would stall the cold start.
    getTenantPool("acme", "postgres://a", { factory, now });
    expect(openTenantPools()).toEqual(["acme"]);
  });
});

describe("the cap is a cap", () => {
  it("never holds more than MAX_TENANT_POOLS at once", () => {
    for (let i = 0; i < MAX_TENANT_POOLS + 3; i++) {
      getTenantPool(`tenant-${i}`, `postgres://${i}`, { factory, now });
    }
    expect(openTenantPools().length).toBeLessThanOrEqual(MAX_TENANT_POOLS);
  });

  it("evicts the LEAST RECENTLY USED, not the oldest created", () => {
    // Touching a pool has to keep it alive, or a steadily-used tenant gets
    // evicted by a burst of one-off requests and reconnects constantly.
    for (let i = 0; i < MAX_TENANT_POOLS; i++) getTenantPool(`t${i}`, "postgres://x", { factory, now });
    getTenantPool("t0", "postgres://x", { factory, now }); // t0 is now newest
    getTenantPool("new", "postgres://x", { factory, now }); // forces an eviction

    const open = openTenantPools();
    expect(open).toContain("t0");
    expect(open).toContain("new");
    expect(open).not.toContain("t1"); // the actual least-recently-used
  });

  it("DRAINS an evicted pool rather than destroying it under a caller", async () => {
    // end() resolves once checked-out clients are released, so a request that
    // is mid-query finishes instead of losing its connection.
    for (let i = 0; i < MAX_TENANT_POOLS; i++) getTenantPool(`t${i}`, "postgres://x", { factory, now });
    const victim = created[0].pool;
    getTenantPool("overflow", "postgres://x", { factory, now });
    await Promise.resolve();
    expect(victim.end).toHaveBeenCalled();
  });
});

describe("the per-tenant path is not weaker than the single-database path", () => {
  it("requests verify-full TLS, same as src/lib/db.ts", () => {
    // An asymmetry here would only show up in an incident.
    const config = poolConfigFor("postgres://host/db", {} as unknown as NodeJS.ProcessEnv);
    expect(String(config.connectionString)).toContain("sslmode=verify-full");
    expect(config.ssl).toBeUndefined(); // undefined = verify against system CAs
  });

  it("honours the same break-glass variable, and only that", () => {
    const insecure = poolConfigFor("postgres://h/d", { INSTINCT_DB_ALLOW_INSECURE: "true" } as unknown as NodeJS.ProcessEnv);
    expect(insecure.ssl).toEqual({ rejectUnauthorized: false });
    const notTrue = poolConfigFor("postgres://h/d", { INSTINCT_DB_ALLOW_INSECURE: "yes" } as unknown as NodeJS.ProcessEnv);
    expect(notTrue.ssl).toBeUndefined();
  });

  it("carries the same timeouts and size limits", () => {
    const config = poolConfigFor("postgres://h/d", {} as unknown as NodeJS.ProcessEnv);
    expect(config).toMatchObject({
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
    });
  });
});

describe("closeAllTenantPools", () => {
  it("drains everything and forgets them", async () => {
    getTenantPool("acme", "postgres://a", { factory, now });
    getTenantPool("beta", "postgres://b", { factory, now });
    await closeAllTenantPools();
    expect(openTenantPools()).toEqual([]);
    for (const c of created) expect(c.pool.end).toHaveBeenCalled();
  });
});
