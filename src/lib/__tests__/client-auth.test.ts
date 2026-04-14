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
    it("writes both instinct_* and apex_* keys", () => {
      const user = { id: "u1", role: "ceo" };
      setInstinctSession("my-token", user);

      expect(store["instinct_token"]).toBe("my-token");
      expect(store["apex_token"]).toBe("my-token");
      expect(JSON.parse(store["instinct_user"])).toEqual(user);
      expect(JSON.parse(store["apex_user"])).toEqual(user);
    });

    it("calls localStorage.setItem four times (two token + two user)", () => {
      setInstinctSession("t", {});
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(4);
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
});
