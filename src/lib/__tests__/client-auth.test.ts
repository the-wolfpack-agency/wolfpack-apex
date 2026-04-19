/**
 * @jest-environment jsdom
 */

/**
 * Unit tests for client-auth helpers.
 *
 * Verifies that getInstinctToken, getInstinctUser, setInstinctSession,
 * clearInstinctSession, authHeaders, and jsonHeaders all work correctly
 * with the instinct_* / apex_* dual-key approach.
 */

// ---------------------------------------------------------------------------
// Mock localStorage
// ---------------------------------------------------------------------------

const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: jest.fn((k: string) => store[k] ?? null),
  setItem: jest.fn((k: string, v: string) => { store[k] = v; }),
  removeItem: jest.fn((k: string) => { delete store[k]; }),
};
Object.defineProperty(window, "localStorage", { value: mockLocalStorage, writable: true });

// Import AFTER mocking localStorage
import {
  getInstinctToken,
  getInstinctUser,
  setInstinctSession,
  clearInstinctSession,
  authHeaders,
  jsonHeaders,
  migrateLegacyApexKeys,
} from "@/lib/client-auth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  for (const k of Object.keys(store)) delete store[k];
  jest.clearAllMocks();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("client-auth", () => {
  beforeEach(resetStore);

  // ---- getInstinctToken ---------------------------------------------------

  describe("getInstinctToken", () => {
    it("returns instinct_token when present", () => {
      store["instinct_token"] = "tok-new";
      expect(getInstinctToken()).toBe("tok-new");
    });

    it("falls back to apex_token when instinct_token is absent", () => {
      store["apex_token"] = "tok-legacy";
      expect(getInstinctToken()).toBe("tok-legacy");
    });

    it("prefers instinct_token over apex_token", () => {
      store["instinct_token"] = "tok-new";
      store["apex_token"] = "tok-legacy";
      expect(getInstinctToken()).toBe("tok-new");
    });

    it("returns null when neither key exists", () => {
      expect(getInstinctToken()).toBeNull();
    });
  });

  // ---- getInstinctUser ----------------------------------------------------

  describe("getInstinctUser", () => {
    it("returns parsed instinct_user when present", () => {
      const user = { id: "1", name: "Test" };
      store["instinct_user"] = JSON.stringify(user);
      expect(getInstinctUser()).toEqual(user);
    });

    it("falls back to apex_user when instinct_user is absent", () => {
      const user = { id: "2", name: "Legacy" };
      store["apex_user"] = JSON.stringify(user);
      expect(getInstinctUser()).toEqual(user);
    });

    it("returns null for invalid JSON", () => {
      store["instinct_user"] = "not-json";
      expect(getInstinctUser()).toBeNull();
    });

    it("returns null when neither key exists", () => {
      expect(getInstinctUser()).toBeNull();
    });
  });

  // ---- setInstinctSession -------------------------------------------------

  describe("setInstinctSession", () => {
    it("writes only canonical instinct_* keys (no legacy apex_* mirror)", () => {
      const user = { id: "u1", role: "ceo" };
      setInstinctSession("my-token", user);

      expect(store["instinct_token"]).toBe("my-token");
      expect(JSON.parse(store["instinct_user"])).toEqual(user);
      expect(store["apex_token"]).toBeUndefined();
      expect(store["apex_user"]).toBeUndefined();
    });

    it("calls localStorage.setItem twice (one token + one user)", () => {
      setInstinctSession("t", {});
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(2);
    });
  });

  // ---- clearInstinctSession -----------------------------------------------

  describe("clearInstinctSession", () => {
    it("removes all four keys", () => {
      store["instinct_token"] = "a";
      store["apex_token"] = "b";
      store["instinct_user"] = "c";
      store["apex_user"] = "d";

      clearInstinctSession();

      expect(store["instinct_token"]).toBeUndefined();
      expect(store["apex_token"]).toBeUndefined();
      expect(store["instinct_user"]).toBeUndefined();
      expect(store["apex_user"]).toBeUndefined();
    });

    it("calls localStorage.removeItem four times", () => {
      clearInstinctSession();
      expect(mockLocalStorage.removeItem).toHaveBeenCalledTimes(4);
    });
  });

  // ---- authHeaders --------------------------------------------------------

  describe("authHeaders", () => {
    it("returns Authorization header when token is present", () => {
      store["instinct_token"] = "jwt-xyz";
      const headers = authHeaders();
      expect(headers).toEqual({ Authorization: "Bearer jwt-xyz" });
    });

    it("returns empty object when no token exists", () => {
      expect(authHeaders()).toEqual({});
    });
  });

  // ---- jsonHeaders --------------------------------------------------------

  describe("jsonHeaders", () => {
    it("includes both Authorization and Content-Type when token exists", () => {
      store["instinct_token"] = "jwt-abc";
      const headers = jsonHeaders();
      expect(headers).toEqual({
        Authorization: "Bearer jwt-abc",
        "Content-Type": "application/json",
      });
    });

    it("includes Content-Type even without token", () => {
      const headers = jsonHeaders();
      expect(headers).toEqual({ "Content-Type": "application/json" });
    });
  });

  // ---- migrateLegacyApexKeys ---------------------------------------------

  describe("migrateLegacyApexKeys", () => {
    it("copies apex_token → instinct_token when only legacy exists", () => {
      store["apex_token"] = "tok-legacy";
      const migrated = migrateLegacyApexKeys();
      expect(migrated).toBe(1);
      expect(store["instinct_token"]).toBe("tok-legacy");
      expect(store["apex_token"]).toBeUndefined();
    });

    it("copies apex_user → instinct_user when only legacy exists", () => {
      store["apex_user"] = JSON.stringify({ id: "u1" });
      const migrated = migrateLegacyApexKeys();
      expect(migrated).toBe(1);
      expect(store["instinct_user"]).toBe(JSON.stringify({ id: "u1" }));
      expect(store["apex_user"]).toBeUndefined();
    });

    it("migrates preference keys (briefing + email notifications)", () => {
      store["apex_briefing_enabled"] = "false";
      store["apex_email_notifications"] = "true";
      const migrated = migrateLegacyApexKeys();
      expect(migrated).toBe(2);
      expect(store["instinct_briefing_enabled"]).toBe("false");
      expect(store["instinct_email_notifications"]).toBe("true");
      expect(store["apex_briefing_enabled"]).toBeUndefined();
      expect(store["apex_email_notifications"]).toBeUndefined();
    });

    it("never overwrites an existing canonical value (newer writes win)", () => {
      store["instinct_token"] = "tok-new";
      store["apex_token"] = "tok-legacy";
      const migrated = migrateLegacyApexKeys();
      expect(migrated).toBe(0); // didn't copy, but DID clean
      expect(store["instinct_token"]).toBe("tok-new");
      expect(store["apex_token"]).toBeUndefined();
    });

    it("is idempotent — calling twice is a no-op on the second call", () => {
      store["apex_token"] = "tok-legacy";
      const first = migrateLegacyApexKeys();
      const second = migrateLegacyApexKeys();
      expect(first).toBe(1);
      expect(second).toBe(0);
      expect(store["instinct_token"]).toBe("tok-legacy");
    });

    it("is a no-op when no legacy keys exist", () => {
      store["instinct_token"] = "tok-new";
      const migrated = migrateLegacyApexKeys();
      expect(migrated).toBe(0);
      expect(store["instinct_token"]).toBe("tok-new");
    });

    it("migrates all four key pairs independently", () => {
      store["apex_token"] = "t";
      store["apex_user"] = JSON.stringify({ id: "u" });
      store["apex_briefing_enabled"] = "true";
      store["apex_email_notifications"] = "false";
      const migrated = migrateLegacyApexKeys();
      expect(migrated).toBe(4);
      expect(store["instinct_token"]).toBe("t");
      expect(JSON.parse(store["instinct_user"])).toEqual({ id: "u" });
      expect(store["instinct_briefing_enabled"]).toBe("true");
      expect(store["instinct_email_notifications"]).toBe("false");
      for (const legacy of [
        "apex_token",
        "apex_user",
        "apex_briefing_enabled",
        "apex_email_notifications",
      ]) {
        expect(store[legacy]).toBeUndefined();
      }
    });
  });
});
