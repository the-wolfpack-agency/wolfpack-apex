/**
 * Analytics integration regression for clients library.
 *
 * Post-058 rename (apex_clients → instinct_clients) — this test locks
 * in the invariants that MUST hold after the rename:
 *
 *   1. Every write path in src/lib/clients.ts fires a trackEvent call
 *      so the data + learning mechanism still sees client activity.
 *      (Per CLAUDE.md: "No data lost. All data consumed to benefit
 *      the system.")
 *
 *   2. Every SQL statement targets the NEW table name `instinct_clients`,
 *      not the legacy `apex_clients`. The backward-compat view would
 *      mask missed replacements — this test makes them explicit.
 *
 *   3. Analytics event names, actor ids, and payload actions are stable
 *      across the rename so downstream consumers (audit log, Postgres
 *      event stream, Qdrant embeddings) keep working.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import {
  createClient,
  updateClient,
  getClient,
  getClients,
  linkDocToClient,
} from "@/lib/clients";

describe("clients library — post-058 analytics + SQL target invariants", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("SQL target uses the renamed table name (058)", () => {
    it("createClient INSERTs into instinct_clients, not apex_clients", async () => {
      mockSafeQuery.mockResolvedValueOnce({
        rows: [{ id: "c-1", name: "Acme" }],
        fromCache: false,
      });

      await createClient("Acme");

      const sql = String(mockSafeQuery.mock.calls[0][0]);
      expect(sql).toContain("INSERT INTO instinct_clients");
      expect(sql).not.toContain("INSERT INTO apex_clients");
    });

    it("updateClient UPDATEs instinct_clients", async () => {
      mockSafeQuery.mockResolvedValueOnce({
        rows: [{ id: "c-1" }],
        fromCache: false,
      });

      await updateClient("c-1", { name: "New" });

      const sql = String(mockSafeQuery.mock.calls[0][0]);
      expect(sql).toContain("UPDATE instinct_clients");
      expect(sql).not.toContain("UPDATE apex_clients");
    });

    it("getClients SELECTs FROM instinct_clients", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      await getClients();

      const sql = String(mockSafeQuery.mock.calls[0][0]);
      expect(sql).toContain("FROM instinct_clients");
      expect(sql).not.toContain("FROM apex_clients");
    });

    it("getClient SELECTs FROM instinct_clients by id", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      await getClient("c-1");

      const sql = String(mockSafeQuery.mock.calls[0][0]);
      expect(sql).toContain("FROM instinct_clients");
      expect(sql).not.toContain("FROM apex_clients");
    });

    it("linkDocToClient UPDATEs instinct_clients docs", async () => {
      mockSafeQuery.mockResolvedValueOnce({
        rows: [{ id: "c-1", docs: ["d-1"] }],
        fromCache: false,
      });

      await linkDocToClient("c-1", "d-1");

      const sql = String(mockSafeQuery.mock.calls[0][0]);
      expect(sql).toContain("UPDATE instinct_clients");
      expect(sql).not.toContain("UPDATE apex_clients");
    });
  });

  describe("analytics events continue to fire after rename", () => {
    it("fires client.doc_generated on createClient with action=client_created", async () => {
      mockSafeQuery.mockResolvedValueOnce({
        rows: [{ id: "c-42", name: "NewCo" }],
        fromCache: false,
      });

      await createClient("NewCo", "tech");

      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      const [eventName, actorId, source, payload] = mockTrackEvent.mock.calls[0];
      expect(eventName).toBe("client.doc_generated");
      expect(actorId).toBe("c-42");
      expect(source).toBe("unknown");
      expect(payload).toMatchObject({
        action: "client_created",
        client_name: "NewCo",
      });
    });

    it("fires client.doc_generated on linkDocToClient with action=doc_linked", async () => {
      mockSafeQuery.mockResolvedValueOnce({
        rows: [{ id: "c-1", docs: ["d-1"] }],
        fromCache: false,
      });

      await linkDocToClient("c-1", "d-1");

      expect(mockTrackEvent).toHaveBeenCalledTimes(1);
      const [eventName, actorId, , payload] = mockTrackEvent.mock.calls[0];
      expect(eventName).toBe("client.doc_generated");
      expect(actorId).toBe("c-1");
      expect(payload).toMatchObject({
        action: "doc_linked",
        doc_id: "d-1",
      });
    });

    it("does NOT fire analytics when shadow-mode fallback is used (no row inserted)", async () => {
      // Shadow-mode path: safeQuery returns { rows: [], fromCache: true }.
      // createClient returns a synthetic demo client but must not pretend
      // a real write happened — so no analytics event.
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });

      const result = await createClient("Shadow Co");

      expect(result).not.toBeNull();
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it("does NOT fire analytics when linkDocToClient target is missing", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      const result = await linkDocToClient("missing", "d-1");

      expect(result).toBeNull();
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });
  });
});
