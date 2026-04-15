/**
 * audit-log.test.ts — core recordAudit + hash-chain + PII redaction.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockConnect = jest.fn();
const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  pool: { connect: (...args: unknown[]) => mockConnect(...args) },
  query: (...args: unknown[]) => mockQuery(...args),
  safeQuery: (...args: unknown[]) => mockQuery(...args).then((r: any) => ({ rows: r.rows, fromCache: false })),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

import {
  recordAudit,
  redactPII,
  canonicalJSON,
  computeEntryHash,
  GENESIS_HASH,
  _setAuditMetaSampleRateForTests,
} from "@/lib/audit-log";

function buildClient(rows: any[][]) {
  const queries: string[] = [];
  let callIdx = 0;
  return {
    queries,
    client: {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        queries.push(sql);
        const row = rows[callIdx++];
        return { rows: row ?? [] };
      }),
      release: jest.fn(),
    },
  };
}

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://test";
  _setAuditMetaSampleRateForTests(1_000_000); // effectively off so tests don't depend on it
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// redactPII
// ---------------------------------------------------------------------------
describe("redactPII", () => {
  it("redacts top-level ssn", () => {
    const out = redactPII({ name: "Alex", ssn: "123-45-6789" }) as any;
    expect(out.name).toBe("Alex");
    expect(out.ssn).toBe("[REDACTED]");
  });

  it("redacts deeply nested bankAccount", () => {
    const out = redactPII({
      employee: { profile: { payroll: { bankAccount: "ACC-555" } } },
    }) as any;
    expect(out.employee.profile.payroll.bankAccount).toBe("[REDACTED]");
  });

  it("redacts ssn inside an array of employees", () => {
    const out = redactPII([
      { id: "a", ssn: "111" },
      { id: "b", dateOfBirth: "1990-01-01" },
    ]) as any;
    expect(out[0].ssn).toBe("[REDACTED]");
    expect(out[1].dateOfBirth).toBe("[REDACTED]");
  });

  it("handles null / primitives / undefined safely", () => {
    expect(redactPII(null)).toBe(null);
    expect(redactPII(undefined)).toBe(undefined);
    expect(redactPII("hello")).toBe("hello");
    expect(redactPII(42)).toBe(42);
  });

  it("truncates at depth limit", () => {
    // Build a deeply nested object beyond REDACTION_MAX_DEPTH (8)
    let leaf: any = { ssn: "deep" };
    for (let i = 0; i < 12; i++) leaf = { nested: leaf };
    const out = redactPII(leaf) as any;
    // Walk until we hit [TRUNCATED]
    let cur: any = out;
    let hit = false;
    for (let i = 0; i < 20 && cur; i++) {
      if (cur === "[TRUNCATED]") {
        hit = true;
        break;
      }
      cur = cur.nested;
    }
    expect(hit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canonicalJSON
// ---------------------------------------------------------------------------
describe("canonicalJSON", () => {
  it("produces sorted-key output regardless of insertion order", () => {
    const a = canonicalJSON({ b: 1, a: 2 });
    const b = canonicalJSON({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it("recursively sorts nested keys", () => {
    const a = canonicalJSON({ x: { b: 1, a: 2 } });
    expect(a).toBe('{"x":{"a":2,"b":1}}');
  });
});

// ---------------------------------------------------------------------------
// computeEntryHash
// ---------------------------------------------------------------------------
describe("computeEntryHash", () => {
  it("is deterministic for identical inputs", () => {
    const row = {
      seq: 1,
      ts: "2026-04-15T00:00:00.000Z",
      actor_user_id: "u1",
      actor_role: "cto",
      action: "a.b",
      resource_type: "r",
      resource_id: null,
      before_state: null,
      after_state: { x: 1 },
      ip_address: null,
      user_agent: null,
      request_id: null,
    };
    const h1 = computeEntryHash(GENESIS_HASH, row);
    const h2 = computeEntryHash(GENESIS_HASH, row);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("differs when any field changes", () => {
    const baseline = {
      seq: 1,
      ts: "2026-04-15T00:00:00.000Z",
      actor_user_id: "u1",
      actor_role: "cto",
      action: "a.b",
      resource_type: "r",
      resource_id: null,
      before_state: null,
      after_state: null,
      ip_address: null,
      user_agent: null,
      request_id: null,
    };
    const h1 = computeEntryHash(GENESIS_HASH, baseline);
    const h2 = computeEntryHash(GENESIS_HASH, { ...baseline, action: "a.c" });
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// recordAudit — writes row, chains hash, redacts PII, returns id/seq/hash
// ---------------------------------------------------------------------------
describe("recordAudit", () => {
  it("inserts with GENESIS prev hash when table is empty, returns id/seq/hash", async () => {
    const { client } = buildClient([
      [], // BEGIN
      [], // SELECT prev (empty)
      [{ nextval: "1" }], // nextval
      [{ id: "uuid-1" }], // INSERT RETURNING id
      [], // COMMIT
    ]);
    mockConnect.mockResolvedValueOnce(client);

    const result = await recordAudit({
      actor: { user_id: "u1", role: "cto" },
      action: "hr.employee.created",
      resourceType: "employee",
      resourceId: "e1",
      afterState: { name: "Alex" },
    });

    expect(result.id).toBe("uuid-1");
    expect(result.seq).toBe(1);
    expect(result.entryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(client.release).toHaveBeenCalled();
  });

  it("uses previous row's entry_hash as prev_hash for seq > 1", async () => {
    const priorHash = "a".repeat(64);
    const { client } = buildClient([
      [], // BEGIN
      [{ entry_hash: priorHash, seq: "5" }],
      [{ nextval: "6" }],
      [{ id: "uuid-6" }],
      [], // COMMIT
    ]);
    mockConnect.mockResolvedValueOnce(client);

    const result = await recordAudit({
      actor: { user_id: "u1", role: "cto" },
      action: "hr.employee.updated",
      resourceType: "employee",
    });

    expect(result.seq).toBe(6);
    // The INSERT call should have priorHash in the prev_hash param slot (13th param, index 12)
    const insertCall = client.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO instinct_audit_log"));
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[12]).toBe(priorHash);
  });

  it("redacts PII in beforeState and afterState BEFORE inserting", async () => {
    const { client } = buildClient([
      [],
      [],
      [{ nextval: "1" }],
      [{ id: "uuid-x" }],
      [],
    ]);
    mockConnect.mockResolvedValueOnce(client);

    await recordAudit({
      actor: { user_id: "u1", role: "hr" },
      action: "hr.employee.updated",
      resourceType: "employee",
      resourceId: "e1",
      beforeState: { name: "Old", ssn: "OLD-SSN", bankAccount: "OLD-BANK" },
      afterState: { name: "New", ssn: "NEW-SSN", nested: { passport: "X" } },
    });

    const insertCall = client.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO instinct_audit_log"));
    const params = insertCall![1] as unknown[];
    const beforeJson = params[7] as string;
    const afterJson = params[8] as string;
    expect(beforeJson).toContain("[REDACTED]");
    expect(beforeJson).not.toContain("OLD-SSN");
    expect(beforeJson).not.toContain("OLD-BANK");
    expect(afterJson).toContain("[REDACTED]");
    expect(afterJson).not.toContain("NEW-SSN");
    expect(afterJson).not.toContain("\"X\""); // passport redacted
  });

  it("rolls back the transaction on insert failure", async () => {
    const { client } = buildClient([
      [],
      [],
      [{ nextval: "1" }],
    ]);
    // Make INSERT throw
    client.query.mockImplementationOnce(async () => ({ rows: [] })); // BEGIN
    client.query.mockImplementationOnce(async () => ({ rows: [] })); // SELECT prev
    client.query.mockImplementationOnce(async () => ({ rows: [{ nextval: "1" }] }));
    client.query.mockImplementationOnce(async () => {
      throw new Error("unique_violation");
    });
    client.query.mockImplementationOnce(async () => ({ rows: [] })); // ROLLBACK

    mockConnect.mockResolvedValueOnce(client);

    await expect(
      recordAudit({
        actor: { user_id: "u1", role: "cto" },
        action: "x.y",
        resourceType: "r",
      }),
    ).rejects.toThrow("unique_violation");

    // Verify ROLLBACK was issued
    const calls = client.query.mock.calls.map((c) => c[0]);
    expect(calls.some((s) => String(s).includes("ROLLBACK"))).toBe(true);
  });

  it("is a no-op (returns shadow values) when DATABASE_URL is unset", async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const result = await recordAudit({
        actor: { user_id: "u1", role: "cto" },
        action: "x.y",
        resourceType: "r",
      });
      expect(result.id).toBe("shadow");
      expect(result.seq).toBe(0);
      expect(mockConnect).not.toHaveBeenCalled();
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
});
