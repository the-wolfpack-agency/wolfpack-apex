/**
 * age-graph.test.ts
 *
 * Unit tests for the Apache AGE GraphStore adapter. All DB I/O is mocked
 * at the `@/lib/db` boundary — we assert on the SQL text + params passed
 * to safeQuery, NOT on a running Postgres. (Integration against real AGE
 * lives in a separate pipeline job.)
 *
 * The analytics shim (@/lib/rag-providers/analytics-shim) is mocked too:
 *  - it may not yet exist on disk (written in parallel);
 *  - we want to assert the exact event names + payloads emitted.
 *
 * Invariants covered:
 *   1. upsertNode builds a MERGE (v:Label {id: ...}) with multi-label
 *      joined by `:`.
 *   2. upsertNode ALWAYS injects tenant_id into the props bag — even if
 *      the caller forgot to add it themselves. CRITICAL.
 *   3. upsertEdge builds MATCH/MATCH/MERGE (…)-[r:TYPE]->(…).
 *   4. upsertEdge ALWAYS injects tenant_id into edge props. CRITICAL.
 *   5. query() wraps the caller's Cypher verbatim inside the
 *      `SELECT * FROM cypher(...)` shell and returns deserialized rows.
 *   6. query() failures resolve to [] and emit rag.graph_query_failed.
 *   7. health() returns ok on a non-empty result and failed otherwise,
 *      emitting the correct ok/failed event.
 *   8. deserializeAgtype strips trailing ::vertex / ::edge tags.
 */

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE the SUT import so jest hoisting picks them up.
// ---------------------------------------------------------------------------

jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(),
}));

jest.mock("@/lib/rag-providers/analytics-shim", () => ({
  emitRagEvent: jest.fn(),
}));

import { safeQuery } from "@/lib/db";
import { emitRagEvent } from "@/lib/rag-providers/analytics-shim";
import {
  createAgeGraphStore,
  deserializeAgtype,
} from "@/lib/rag-providers/age-graph";

const mockSafeQuery = safeQuery as jest.MockedFunction<typeof safeQuery>;
const mockEmit = emitRagEvent as jest.MockedFunction<typeof emitRagEvent>;

function captureSql(): { sql: string; params: unknown[] } {
  expect(mockSafeQuery).toHaveBeenCalledTimes(1);
  const call = mockSafeQuery.mock.calls[0];
  return { sql: call[0] as string, params: (call[1] as unknown[]) ?? [] };
}

function parseFirstParam(params: unknown[]): Record<string, unknown> {
  expect(params.length).toBeGreaterThanOrEqual(1);
  const raw = params[0];
  expect(typeof raw).toBe("string");
  return JSON.parse(raw as string) as Record<string, unknown>;
}

function eventNames(): string[] {
  return mockEmit.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockEmit.mockReset();
});

// ---------------------------------------------------------------------------
// upsertNode
// ---------------------------------------------------------------------------

describe("createAgeGraphStore / upsertNode", () => {
  it("emits MERGE (v:Label {id: ...}) for a single-label node", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const store = createAgeGraphStore();

    await store.upsertNode({
      id: "n1",
      labels: ["Person"],
      props: { name: "Ada" },
      tenantId: "t-abc",
    });

    const { sql } = captureSql();
    // The cypher() wrapper must reference the default graph name.
    expect(sql).toMatch(/cypher\('instinct'/);
    // Single-label MERGE shape — tolerant of whitespace.
    expect(sql).toMatch(/MERGE \(v:Person \{id:\s*\$id\}\)/);
    expect(sql).toMatch(/SET v \+= \$props/);
    expect(sql).toMatch(/RETURN v/);

    expect(eventNames()).toEqual(["rag.graph_upsert_ok"]);
    const payload = mockEmit.mock.calls[0][3] as Record<string, unknown>;
    expect(payload.provider).toBe("age");
    expect(typeof payload.duration_ms).toBe("number");
  });

  it("joins multiple labels with ':' inside the MERGE", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const store = createAgeGraphStore();

    await store.upsertNode({
      id: "n2",
      labels: ["Person", "Employee", "Admin"],
      props: { name: "Grace" },
      tenantId: "t-abc",
    });

    const { sql } = captureSql();
    expect(sql).toMatch(
      /MERGE \(v:Person:Employee:Admin \{id:\s*\$id\}\)/,
    );
  });

  it("ALWAYS injects tenant_id into node props (CRITICAL)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const store = createAgeGraphStore();

    await store.upsertNode({
      id: "n3",
      labels: ["Thing"],
      props: { name: "no tenant here" },
      tenantId: "tenant-xyz",
    });

    const { params } = captureSql();
    const parsed = parseFirstParam(params);
    expect(parsed.props).toMatchObject({
      tenant_id: "tenant-xyz",
      name: "no tenant here",
      id: "n3",
    });
  });

  it("overwrites any caller-supplied tenant_id with the envelope tenantId", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const store = createAgeGraphStore();

    await store.upsertNode({
      id: "n4",
      labels: ["Thing"],
      // Hostile: caller tries to spoof another tenant via raw props.
      props: { tenant_id: "other-tenant", name: "spoof" },
      tenantId: "real-tenant",
    });

    const { params } = captureSql();
    const parsed = parseFirstParam(params);
    const props = parsed.props as Record<string, unknown>;
    expect(props.tenant_id).toBe("real-tenant");
  });

  it("never throws on DB failure; emits rag.graph_upsert_failed", async () => {
    mockSafeQuery.mockRejectedValue(new Error("pg down"));
    const store = createAgeGraphStore();

    await expect(
      store.upsertNode({
        id: "n5",
        labels: ["X"],
        props: {},
        tenantId: "t",
      }),
    ).resolves.toBeUndefined();

    expect(eventNames()).toEqual(["rag.graph_upsert_failed"]);
    const payload = mockEmit.mock.calls[0][3] as Record<string, unknown>;
    expect(payload.provider).toBe("age");
    expect(payload.op).toBe("node");
    expect(payload.error).toBe("pg down");
  });
});

// ---------------------------------------------------------------------------
// upsertEdge
// ---------------------------------------------------------------------------

describe("createAgeGraphStore / upsertEdge", () => {
  it("emits MATCH + MATCH + MERGE (…)-[r:TYPE]->(…) with the edge type", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const store = createAgeGraphStore();

    await store.upsertEdge({
      from: "a",
      to: "b",
      type: "KNOWS",
      props: { since: 2024 },
      tenantId: "t",
    });

    const { sql } = captureSql();
    expect(sql).toMatch(/MATCH \(from \{id:\s*\$from\}\)/);
    expect(sql).toMatch(/MATCH \(to \{id:\s*\$to\}\)/);
    expect(sql).toMatch(/MERGE \(from\)-\[r:KNOWS\]->\(to\)/);
    expect(sql).toMatch(/SET r \+= \$props/);
  });

  it("ALWAYS injects tenant_id into edge props (CRITICAL)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const store = createAgeGraphStore();

    await store.upsertEdge({
      from: "a",
      to: "b",
      type: "REFERS_TO",
      props: { weight: 0.5 },
      tenantId: "tenant-42",
    });

    const { params } = captureSql();
    const parsed = parseFirstParam(params);
    const props = parsed.props as Record<string, unknown>;
    expect(props.tenant_id).toBe("tenant-42");
    expect(props.weight).toBe(0.5);
  });

  it("overwrites caller-supplied tenant_id on edges too", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const store = createAgeGraphStore();

    await store.upsertEdge({
      from: "a",
      to: "b",
      type: "LINKS",
      props: { tenant_id: "hostile" },
      tenantId: "real",
    });

    const { params } = captureSql();
    const parsed = parseFirstParam(params);
    expect((parsed.props as Record<string, unknown>).tenant_id).toBe("real");
  });

  it("never throws on DB failure; emits rag.graph_upsert_failed with op=edge", async () => {
    mockSafeQuery.mockRejectedValue(new Error("boom"));
    const store = createAgeGraphStore();

    await expect(
      store.upsertEdge({
        from: "a",
        to: "b",
        type: "X",
        props: {},
        tenantId: "t",
      }),
    ).resolves.toBeUndefined();

    expect(eventNames()).toEqual(["rag.graph_upsert_failed"]);
    const payload = mockEmit.mock.calls[0][3] as Record<string, unknown>;
    expect(payload.op).toBe("edge");
  });
});

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

describe("createAgeGraphStore / query", () => {
  it("forwards the caller's Cypher verbatim inside the cypher() wrapper", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const store = createAgeGraphStore();

    const userCypher = "MATCH (p:Person) WHERE p.tenant_id = $tenant RETURN p";
    await store.query(userCypher, { tenant: "t-1" });

    const { sql, params } = captureSql();
    expect(sql).toContain(userCypher);
    expect(sql).toMatch(/SELECT \* FROM cypher\('instinct'/);
    expect(sql).toMatch(/AS \(r agtype\)/);
    const parsed = parseFirstParam(params);
    expect(parsed).toEqual({ tenant: "t-1" });
  });

  it("deserializes agtype rows into plain objects", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        { r: '{"id":"n1","label":"Person","properties":{"name":"Ada"}}::vertex' },
        { r: '{"id":"n2","label":"Person","properties":{"name":"Grace"}}::vertex' },
      ],
      fromCache: false,
    });
    const store = createAgeGraphStore();

    const rows = await store.query("MATCH (p) RETURN p", {});

    expect(rows).toHaveLength(2);
    expect(rows[0].r).toMatchObject({
      id: "n1",
      label: "Person",
      properties: { name: "Ada" },
    });
    expect(rows[1].r).toMatchObject({ id: "n2" });
    expect(eventNames()).toEqual(["rag.graph_query_ok"]);
  });

  it("returns [] and emits rag.graph_query_failed on DB failure", async () => {
    mockSafeQuery.mockRejectedValue(new Error("syntax error"));
    const store = createAgeGraphStore();

    const rows = await store.query("NOT CYPHER", {});

    expect(rows).toEqual([]);
    expect(eventNames()).toEqual(["rag.graph_query_failed"]);
    const payload = mockEmit.mock.calls[0][3] as Record<string, unknown>;
    expect(payload.provider).toBe("age");
    expect(payload.error).toBe("syntax error");
    expect(typeof payload.duration_ms).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

describe("createAgeGraphStore / health", () => {
  it("returns ok=true when RETURN 1 yields a row; emits rag.graph_health_ok", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ r: "1" }],
      fromCache: false,
    });
    const store = createAgeGraphStore();

    const h = await store.health();

    expect(h.ok).toBe(true);
    expect(typeof h.latencyMs).toBe("number");
    const { sql } = captureSql();
    expect(sql).toContain("RETURN 1");
    expect(eventNames()).toEqual(["rag.graph_health_ok"]);
  });

  it("returns ok=false when RETURN 1 yields no rows; emits rag.graph_health_failed", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const store = createAgeGraphStore();

    const h = await store.health();

    expect(h.ok).toBe(false);
    expect(h.detail).toBeDefined();
    expect(eventNames()).toEqual(["rag.graph_health_failed"]);
  });

  it("returns ok=false with a detail message on DB failure", async () => {
    mockSafeQuery.mockRejectedValue(new Error("conn refused"));
    const store = createAgeGraphStore();

    const h = await store.health();

    expect(h.ok).toBe(false);
    expect(h.detail).toBe("conn refused");
    expect(eventNames()).toEqual(["rag.graph_health_failed"]);
  });
});

// ---------------------------------------------------------------------------
// custom graph name
// ---------------------------------------------------------------------------

describe("createAgeGraphStore / graphName", () => {
  it("uses the supplied graph name in the cypher() wrapper", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    const store = createAgeGraphStore("wolfpack");

    await store.query("RETURN 1", {});

    const { sql } = captureSql();
    expect(sql).toContain("cypher('wolfpack'");
  });
});

// ---------------------------------------------------------------------------
// deserializeAgtype — the helper is exported for reuse + direct unit tests.
// ---------------------------------------------------------------------------

describe("deserializeAgtype", () => {
  it("strips ::vertex and JSON-parses the payload", () => {
    const v = deserializeAgtype('{"id":"x","properties":{"k":1}}::vertex');
    expect(v).toEqual({ id: "x", properties: { k: 1 } });
  });

  it("strips ::edge", () => {
    const v = deserializeAgtype('{"id":"e","label":"KNOWS"}::edge');
    expect(v).toEqual({ id: "e", label: "KNOWS" });
  });

  it("returns the trimmed string when JSON.parse fails", () => {
    const v = deserializeAgtype("not json::vertex");
    expect(v).toBe("not json");
  });

  it("passes through non-string values unchanged", () => {
    expect(deserializeAgtype(42)).toBe(42);
    expect(deserializeAgtype(null)).toBeNull();
  });
});
