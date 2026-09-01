/**
 * Reading a client's database without reading their data.
 *
 * Two things have to hold for any of this to be sellable, and the
 * suite is built around them:
 *
 *   1. It never reads a record, and it cannot be made to. A client
 *      hands over a production role on the strength of that sentence.
 *   2. It says "we could not look" rather than staying quiet when it
 *      could not look. A silent generator reads as a clean bill of
 *      health, which is the one wrong answer.
 */

export {};

const CTX = { userId: "u1", userRole: "admin" };

/** A pool that records every statement and returns canned rows. */
function fakePool(handler: (sql: string) => unknown[]) {
  const statements: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      statements.push(sql.trim());
      return { rows: handler(sql) };
    }),
    release: jest.fn(),
  };
  return {
    statements,
    client,
    pool: { connect: jest.fn(async () => client) } as any,
  };
}

const TABLE_ROWS = [
  { table: "archive_2011", live_rows: 4_000_000, seq_scans: 0, idx_scans: 0, writes: 0, analyses: 0 },
  { table: "audit_shadow", live_rows: 900_000, seq_scans: 0, idx_scans: 0, writes: 41_000, analyses: 0 },
  { table: "customers", live_rows: 120_000, seq_scans: 900_000, idx_scans: 100_000, writes: 12, analyses: 3 },
  { table: "orders", live_rows: 80_000, seq_scans: 10, idx_scans: 400_000, writes: 90, analyses: 3 },
  { table: "line_items", live_rows: 400_000, seq_scans: 5, idx_scans: 200_000, writes: 30, analyses: 3 },
  { table: "regions", live_rows: 40, seq_scans: 900, idx_scans: 10, writes: 0, analyses: 3 },
  { table: "staff", live_rows: 300, seq_scans: 500, idx_scans: 20, writes: 1, analyses: 3 },
];

function route(sql: string): unknown[] {
  if (sql.includes("pg_stat_user_tables")) return TABLE_ROWS;
  if (sql.includes("information_schema.columns")) return [];
  if (sql.includes("pg_stat_statements")) {
    return [
      /* 1.8ms a call and two hours in total: the shape of something in a
         loop that should have been one query. */
      { shape: "SELECT * FROM customers WHERE id = $1", calls: 4_000_000, total_ms: 7_200_000 },
      { shape: "UPDATE staff SET seen_at = $1 WHERE id = $2", calls: 5_000, total_ms: 60_000 },
      { shape: "SELECT 1", calls: 12, total_ms: 3 },
    ];
  }
  return [];
}

const ORIGINAL = process.env.INSTINCT_LEGACY_DB_URL;
beforeEach(() => {
  jest.resetModules();
  process.env.INSTINCT_LEGACY_DB_URL = "postgres://legacy/db";
  process.env.INSTINCT_LEGACY_DB_NAME = "the DMS";
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.INSTINCT_LEGACY_DB_URL;
  else process.env.INSTINCT_LEGACY_DB_URL = ORIGINAL;
  delete process.env.INSTINCT_LEGACY_DB_NAME;
});

describe("the scan cannot read a record", () => {
  it("issues only fixed catalog queries", async () => {
    const { pool, statements } = fakePool(route);
    const { scanLegacyDatabase } = await import("@/lib/sources/legacy-postgres");
    await scanLegacyDatabase({ pool });

    const reads = statements.filter((s) => s.startsWith("SELECT"));
    expect(reads.length).toBeGreaterThan(0);
    for (const sql of reads) {
      /* Every SELECT targets a catalog or statistics view, never a
         client table. The list is written out rather than loosened to
         a pattern: adding to it should be a deliberate line in a diff
         that a reviewer sees, which is how the dark-data column scan
         arrived here. */
      expect(sql).toMatch(
        /pg_stat_user_tables|pg_stat_statements|information_schema\.columns|pg_stats/,
      );
    }
  });

  it("runs inside a read-only transaction, so the guarantee is the server's", async () => {
    const { pool, statements } = fakePool(route);
    const { scanLegacyDatabase } = await import("@/lib/sources/legacy-postgres");
    await scanLegacyDatabase({ pool });
    expect(statements).toContain("BEGIN READ ONLY");
    expect(statements.some((s) => s.includes("statement_timeout"))).toBe(true);
  });

  it("releases the connection even when the query fails", async () => {
    const { pool, client } = fakePool(() => {
      throw new Error("permission denied for view pg_stat_user_tables");
    });
    const { scanLegacyDatabase } = await import("@/lib/sources/legacy-postgres");
    await expect(scanLegacyDatabase({ pool })).rejects.toThrow(/permission denied/);
    expect(client.release).toHaveBeenCalled();
  });

  it("returns null rather than guessing when no database is configured", async () => {
    delete process.env.INSTINCT_LEGACY_DB_URL;
    const { scanLegacyDatabase } = await import("@/lib/sources/legacy-postgres");
    expect(await scanLegacyDatabase({})).toBeNull();
  });

  it("strips quoted literals out of a statement shape before it is displayed", async () => {
    /* Normalization is Postgres's job and it is not a guarantee. A
       shape ends up in screenshots and tickets, so anything still
       quoted is somebody's data. */
    const { scrubShape } = await import("@/lib/sources/legacy-postgres");
    const out = scrubShape("SELECT * FROM dealers WHERE name = 'Ackerman Motor Group'");
    expect(out).not.toMatch(/Ackerman/);
    expect(out).toContain("dealers");
  });
});

describe("what the counters say", () => {
  async function withScan() {
    const { pool } = fakePool(route);
    jest.doMock("@/lib/sources/legacy-postgres", () => {
      const actual = jest.requireActual("@/lib/sources/legacy-postgres");
      return { ...actual, scanLegacyDatabase: () => actual.scanLegacyDatabase({ pool }) };
    });
    return import("../legacy-db-insights");
  }

  it("names the large tables nothing reads, and flags the ones still being written", async () => {
    const { generateColdTables } = await withScan();
    const [i] = await generateColdTables(CTX);
    expect(i.title).toContain("2 large tables");
    expect(i.detail).toContain("archive_2011");
    /* audit_shadow takes 41k writes and zero reads. Something fills it
       and nothing reads it — the more interesting half. */
    expect(i.detail).toContain("still being written to");
  });

  it("leaves small tables alone, however cold", async () => {
    const { generateColdTables } = await withScan();
    const [i] = await generateColdTables(CTX);
    expect(i.detail).not.toContain("regions");
  });

  it("states where the reads actually go, and that the top table is scanning", async () => {
    const { generateReadConcentration } = await withScan();
    const [i] = await generateReadConcentration(CTX);
    expect(i.title).toMatch(/% of all reads in the DMS hit 3 tables/);
    expect(i.detail).toContain("customers");
    /* customers takes 900k sequential scans against 100k index scans:
       busy the expensive way, which is the finding inside the finding. */
    expect(i.severity).toBe("high");
    expect(i.detail).toContain("sequential scan");
  });

  it("reports the statement whose cost is entirely in its call count", async () => {
    const { generateRepeatedQueryShapes } = await withScan();
    const out = await generateRepeatedQueryShapes(CTX);
    expect(out[0].title).toContain("4,000,000 calls");
    expect(out[0].severity).toBe("high");
    expect(out[0].detail).toContain("Individually trivial");
    /* 12 calls is not a pattern. */
    expect(out.some((i) => i.detail?.includes("SELECT 1"))).toBe(false);
  });
});

describe("when it could not look", () => {
  it("says so, instead of returning nothing", async () => {
    /* A silent generator reads as a clean bill of health. The one
       wrong answer available here. */
    const { pool } = fakePool((sql) => {
      if (sql.includes("pg_stat_statements")) {
        throw new Error('relation "pg_stat_statements" does not exist');
      }
      return TABLE_ROWS;
    });
    jest.doMock("@/lib/sources/legacy-postgres", () => {
      const actual = jest.requireActual("@/lib/sources/legacy-postgres");
      return { ...actual, scanLegacyDatabase: () => actual.scanLegacyDatabase({ pool }) };
    });
    const { generateRepeatedQueryShapes } = await import("../legacy-db-insights");
    const [i] = await generateRepeatedQueryShapes(CTX);
    expect(i.id).toBe("legacy_statement_stats_unavailable");
    expect(i.detail).toContain("pg_stat_statements is not installed");
  });

  it("still reports table-level findings when statement stats are missing", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("pg_stat_statements")) throw new Error("not installed");
      return TABLE_ROWS;
    });
    const { scanLegacyDatabase } = await import("@/lib/sources/legacy-postgres");
    const s = await scanLegacyDatabase({ pool });
    expect(s!.statementStatsAvailable).toBe(false);
    expect(s!.tables.length).toBe(TABLE_ROWS.length);
  });

  it("an unreachable client database does not take the insight panel down", async () => {
    jest.doMock("@/lib/sources/legacy-postgres", () => {
      const actual = jest.requireActual("@/lib/sources/legacy-postgres");
      return {
        ...actual,
        scanLegacyDatabase: () => Promise.reject(new Error("ECONNREFUSED")),
      };
    });
    const m = await import("../legacy-db-insights");
    expect(await m.generateColdTables(CTX)).toEqual([]);
    expect(await m.generateReadConcentration(CTX)).toEqual([]);
    expect(await m.generateRepeatedQueryShapes(CTX)).toEqual([]);
  });
});

/**
 * Everything below was found by running the scan against a real
 * Postgres rather than a fake pool. Each one passed the fixture suite
 * and was wrong against a server.
 */
describe("what a real database taught this", () => {
  function scanWith(over: Partial<any>): any {
    return {
      tables: [],
      columns: [],
      shapes: [],
      statementStatsAvailable: true,
      statementTracking: "all",
      ...over,
    };
  }

  it("does not require zero scans, because maintenance scans every table", async () => {
    /* ANALYZE reads the table and autovacuum runs it on a schedule, so
       a table nothing has ever queried still reports scans. The real
       probe had a never-queried table sitting at seq_scan = 1, and the
       "zero scans" rule would have fired on nothing in production. */
    const { pool } = fakePool((sql) =>
      sql.includes("pg_stat_user_tables")
        ? [{ table: "archive_2011", live_rows: 3000, seq_scans: 2, idx_scans: 0, writes: 3000, analyses: 2 }]
        : [],
    );
    jest.doMock("@/lib/sources/legacy-postgres", () => {
      const actual = jest.requireActual("@/lib/sources/legacy-postgres");
      return { ...actual, scanLegacyDatabase: () => actual.scanLegacyDatabase({ pool }) };
    });
    const { generateColdTables } = await import("../legacy-db-insights");
    const [i] = await generateColdTables(CTX);
    expect(i.title).toContain("A large table");
    expect(i.detail).toContain("beyond routine maintenance");
  });

  it("still ignores a table with scans that maintenance cannot explain", async () => {
    const { pool } = fakePool((sql) =>
      sql.includes("pg_stat_user_tables")
        ? [{ table: "orders", live_rows: 20000, seq_scans: 303, idx_scans: 0, writes: 10, analyses: 2 }]
        : [],
    );
    jest.doMock("@/lib/sources/legacy-postgres", () => {
      const actual = jest.requireActual("@/lib/sources/legacy-postgres");
      return { ...actual, scanLegacyDatabase: () => actual.scanLegacyDatabase({ pool }) };
    });
    const { generateColdTables } = await import("../legacy-db-insights");
    expect(await generateColdTables(CTX)).toEqual([]);
  });

  it("reads as English when exactly one table is cold", async () => {
    /* "1 large tables have not been read" is the sort of thing that
       makes a report look automated, which is the one impression a
       finding like this cannot afford. */
    const { pool } = fakePool((sql) =>
      sql.includes("pg_stat_user_tables")
        ? [{ table: "archive_2011", live_rows: 3000, seq_scans: 0, idx_scans: 0, writes: 0, analyses: 0 }]
        : [],
    );
    jest.doMock("@/lib/sources/legacy-postgres", () => {
      const actual = jest.requireActual("@/lib/sources/legacy-postgres");
      return { ...actual, scanLegacyDatabase: () => actual.scanLegacyDatabase({ pool }) };
    });
    const { generateColdTables } = await import("../legacy-db-insights");
    const [i] = await generateColdTables(CTX);
    expect(i.title).not.toMatch(/\d+ large tables/);
    expect(i.detail).toContain("holds about 3,000 rows");
  });

  it("declares the blind spot when tracking covers only direct queries", async () => {
    /* The default is "top", which records nothing inside a function or
       a stored procedure. On the probe that hid 3,000 calls entirely.
       A legacy system is frequently almost all stored procedures, and
       finding nothing under that setting is not the same as there
       being nothing. */
    jest.doMock("@/lib/sources/legacy-postgres", () => {
      const actual = jest.requireActual("@/lib/sources/legacy-postgres");
      return { ...actual, scanLegacyDatabase: async () => scanWith({ statementTracking: "top" }) };
    });
    const { generateRepeatedQueryShapes } = await import("../legacy-db-insights");
    const [i] = await generateRepeatedQueryShapes(CTX);
    expect(i.id).toBe("legacy_statement_tracking_top_only");
  });

  it("stays quiet when full tracking genuinely found nothing repeated", async () => {
    jest.doMock("@/lib/sources/legacy-postgres", () => {
      const actual = jest.requireActual("@/lib/sources/legacy-postgres");
      return { ...actual, scanLegacyDatabase: async () => scanWith({ statementTracking: "all" }) };
    });
    const { generateRepeatedQueryShapes } = await import("../legacy-db-insights");
    expect(await generateRepeatedQueryShapes(CTX)).toEqual([]);
  });

  it("leads with the count when the total time rounds to nothing", async () => {
    jest.doMock("@/lib/sources/legacy-postgres", () => {
      const actual = jest.requireActual("@/lib/sources/legacy-postgres");
      return {
        ...actual,
        scanLegacyDatabase: async () =>
          scanWith({ shapes: [{ shape: "SELECT full_name FROM customers WHERE id = $1", calls: 3000, totalMs: 400 }] }),
      };
    });
    const { generateRepeatedQueryShapes } = await import("../legacy-db-insights");
    const [i] = await generateRepeatedQueryShapes(CTX);
    expect(i.title).toContain("has run 3,000 times");
    expect(i.title).not.toContain("0s");
  });

  it("never reports our own catalog queries back as the client's load", async () => {
    /* On an idle database the busiest statements recorded were OUR
       scan: the read-only transaction, the timeout, and the catalog
       selects. */
    const { pool } = fakePool((sql) => {
      if (sql.includes("pg_stat_statements") && sql.includes("total_exec_time")) {
        return [
          { shape: "BEGIN READ ONLY", calls: 5000, total_ms: 10 },
          { shape: "SET LOCAL statement_timeout = 8000", calls: 5000, total_ms: 10 },
          { shape: "SELECT relname AS table FROM pg_stat_user_tables", calls: 5000, total_ms: 10 },
          { shape: "SELECT full_name FROM customers WHERE id = $1", calls: 3000, total_ms: 9000 },
        ];
      }
      return [];
    });
    jest.dontMock("@/lib/sources/legacy-postgres");
    jest.resetModules();
    const { scanLegacyDatabase } = await import("@/lib/sources/legacy-postgres");
    const s = await scanLegacyDatabase({ pool });
    expect(s!.shapes.map((q) => q.shape)).toEqual([
      "SELECT full_name FROM customers WHERE id = $1",
    ]);
  });

  it("analyses base tables only, never a monitoring view's own columns", async () => {
    /* The column query returned the columns of pg_stat_statements'
       views, so the analysis was reporting on the extension we had just
       asked them to install. */
    /* Earlier tests in this file replace the module; this one needs the
       real query text. */
    jest.dontMock("@/lib/sources/legacy-postgres");
    jest.resetModules();
    const { pool, statements } = fakePool(() => []);
    const { scanLegacyDatabase } = await import("@/lib/sources/legacy-postgres");
    await scanLegacyDatabase({ pool });
    const columnQuery = statements.find((s) => s.includes("information_schema.columns"))!;
    expect(columnQuery).toContain("'BASE TABLE'");
  });
});
