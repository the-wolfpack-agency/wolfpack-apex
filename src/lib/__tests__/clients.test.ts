/**
 * Client Library Tests
 */

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import {
  createClient,
  updateClient,
  getClients,
  getClient,
  linkDocToClient,
} from "@/lib/clients";

describe("Clients Library", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("createClient", () => {
    it("inserts a client and tracks analytics", async () => {
      const mockClient = {
        id: "client-1",
        name: "Acme Corp",
        industry: "tech",
        contact_email: "john@acme.com",
        contact_name: "John",
        notes: "Big deal",
        docs: [],
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      };

      mockSafeQuery.mockResolvedValueOnce({ rows: [mockClient], fromCache: false });

      const result = await createClient("Acme Corp", "tech", "john@acme.com", "John", "Big deal");

      expect(result).toEqual(mockClient);
      expect(mockSafeQuery.mock.calls[0][0]).toContain("INSERT INTO apex_clients");
      expect(mockTrackEvent).toHaveBeenCalledWith(
        "client.doc_generated",
        "client-1",
        "unknown",
        expect.objectContaining({ action: "client_created" }),
      );
    });

    it("returns demo client in shadow mode", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });

      const result = await createClient("Test Corp");

      expect(result).not.toBeNull();
      expect(result!.id).toMatch(/^demo-client-/);
      expect(result!.name).toBe("Test Corp");
      expect(result!.docs).toEqual([]);
    });

    it("handles optional fields as null", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "c-1" }], fromCache: false });

      await createClient("Solo");

      expect(mockSafeQuery.mock.calls[0][1]).toEqual(["Solo", null, null, null, null]);
    });
  });

  describe("updateClient", () => {
    it("updates specified fields only", async () => {
      const updated = { id: "client-1", name: "Acme Inc" };
      mockSafeQuery.mockResolvedValueOnce({ rows: [updated], fromCache: false });

      const result = await updateClient("client-1", { name: "Acme Inc" });

      expect(result).toEqual(updated);
      expect(mockSafeQuery.mock.calls[0][0]).toContain("name = $1");
      expect(mockSafeQuery.mock.calls[0][0]).toContain("updated_at = NOW()");
    });

    it("updates multiple fields", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "client-1" }], fromCache: false });

      await updateClient("client-1", { name: "New Name", industry: "finance", notes: "Updated" });

      const sql = mockSafeQuery.mock.calls[0][0];
      expect(sql).toContain("name = $1");
      expect(sql).toContain("industry = $2");
      expect(sql).toContain("notes = $3");
    });

    it("returns null for empty updates", async () => {
      const result = await updateClient("client-1", {});
      expect(result).toBeNull();
      expect(mockSafeQuery).not.toHaveBeenCalled();
    });

    it("returns null when client not found", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      const result = await updateClient("non-existent", { name: "X" });
      expect(result).toBeNull();
    });
  });

  describe("getClients", () => {
    it("returns all clients sorted by name", async () => {
      const clients = [{ id: "c-1", name: "Alpha" }, { id: "c-2", name: "Beta" }];
      mockSafeQuery.mockResolvedValueOnce({ rows: clients, fromCache: false });

      const result = await getClients();

      expect(result).toEqual(clients);
      expect(mockSafeQuery.mock.calls[0][0]).toContain("ORDER BY name ASC");
    });
  });

  describe("getClient", () => {
    it("returns a single client by ID", async () => {
      const client = { id: "client-1", name: "Acme" };
      mockSafeQuery.mockResolvedValueOnce({ rows: [client], fromCache: false });

      const result = await getClient("client-1");

      expect(result).toEqual(client);
      expect(mockSafeQuery.mock.calls[0][1]).toEqual(["client-1"]);
    });

    it("returns null when not found", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      const result = await getClient("non-existent");
      expect(result).toBeNull();
    });
  });

  describe("linkDocToClient", () => {
    it("appends doc ID to client docs array", async () => {
      const updated = { id: "client-1", docs: ["doc-1", "doc-2"] };
      mockSafeQuery.mockResolvedValueOnce({ rows: [updated], fromCache: false });

      const result = await linkDocToClient("client-1", "doc-2");

      expect(result).toEqual(updated);
      expect(mockSafeQuery.mock.calls[0][0]).toContain("docs = docs || $1::jsonb");
      expect(mockSafeQuery.mock.calls[0][1]).toEqual([JSON.stringify(["doc-2"]), "client-1"]);
    });

    it("tracks analytics on doc link", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [{ id: "client-1" }], fromCache: false });

      await linkDocToClient("client-1", "doc-1");

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "client.doc_generated",
        "client-1",
        "unknown",
        expect.objectContaining({ action: "doc_linked", doc_id: "doc-1" }),
      );
    });

    it("returns null when client not found", async () => {
      mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

      const result = await linkDocToClient("non-existent", "doc-1");
      expect(result).toBeNull();
    });
  });
});
