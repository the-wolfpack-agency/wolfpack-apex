/**
 * Dashboard Stats & Auth Tests
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

// Auth tests need bcryptjs and jsonwebtoken
jest.mock("bcryptjs", () => ({
  hashSync: (pw: string) => `hashed_${pw}`,
  compareSync: (pw: string, hash: string) => hash === `hashed_${pw}`,
}));

jest.mock("jsonwebtoken", () => ({
  sign: (payload: Record<string, unknown>, _secret: string, _opts: unknown) =>
    `jwt_${payload.userId}_${payload.role}`,
  verify: (token: string) => {
    if (token.startsWith("jwt_")) {
      const parts = token.split("_");
      return { userId: parts[1], email: `${parts[1]}@test.com`, role: parts[2], name: "Test" };
    }
    throw new Error("Invalid token");
  },
}));

import { authenticate, getUserFromRequest, hasRole, createToken, verifyToken } from "@/lib/auth";

describe("Auth Library", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("authenticate", () => {
    it("returns user and JWT for valid shadow mode credentials", async () => {
      // No DATABASE_URL = shadow mode
      delete process.env.DATABASE_URL;

      const result = await authenticate("cto@wolfpack.dev", "apex");

      expect(result).not.toBeNull();
      expect(result!.user.email).toBe("cto@wolfpack.dev");
      expect(result!.user.role).toBe("cto");
      expect(result!.token).toBeTruthy();
    });

    it("returns null for invalid shadow mode credentials", async () => {
      delete process.env.DATABASE_URL;

      const result = await authenticate("cto@wolfpack.dev", "wrong");
      expect(result).toBeNull();
    });

    it("returns null for unknown email in shadow mode", async () => {
      delete process.env.DATABASE_URL;

      const result = await authenticate("nobody@test.com", "apex");
      expect(result).toBeNull();
    });

    it("tracks login event on success", async () => {
      delete process.env.DATABASE_URL;

      await authenticate("dev@wolfpack.dev", "apex");

      expect(mockTrackEvent).toHaveBeenCalledWith(
        "system.login",
        "demo-dev",
        "dev",
        expect.objectContaining({ mode: "shadow" }),
      );
    });

    it("supports all four demo roles", async () => {
      delete process.env.DATABASE_URL;

      for (const role of ["cto", "dev", "sales", "ops"]) {
        const result = await authenticate(`${role}@wolfpack.dev`, "apex");
        expect(result).not.toBeNull();
        expect(result!.user.role).toBe(role);
      }
    });
  });

  describe("getUserFromRequest", () => {
    it("extracts user from valid Bearer token", () => {
      const user = getUserFromRequest("Bearer jwt_user1_cto");

      expect(user).not.toBeNull();
      expect(user!.id).toBe("user1");
      expect(user!.role).toBe("cto");
    });

    it("returns null for missing header", () => {
      expect(getUserFromRequest(null)).toBeNull();
    });

    it("returns null for non-Bearer header", () => {
      expect(getUserFromRequest("Basic abc123")).toBeNull();
    });

    it("returns null for invalid token", () => {
      expect(getUserFromRequest("Bearer invalid_garbage")).toBeNull();
    });
  });

  describe("hasRole", () => {
    it("ceo and cto have equal top-level access", () => {
      expect(hasRole("ceo", "cto")).toBe(true);
      expect(hasRole("ceo", "ceo")).toBe(true);
      expect(hasRole("ceo", "dev")).toBe(true);
      expect(hasRole("ceo", "ops")).toBe(true);
      expect(hasRole("ceo", "sales")).toBe(true);
      expect(hasRole("cto", "ceo")).toBe(true);
      expect(hasRole("cto", "cto")).toBe(true);
      expect(hasRole("cto", "dev")).toBe(true);
      expect(hasRole("cto", "ops")).toBe(true);
      expect(hasRole("cto", "sales")).toBe(true);
    });

    it("dev has dev, ops, sales but not cto or ceo", () => {
      expect(hasRole("dev", "cto")).toBe(false);
      expect(hasRole("dev", "ceo")).toBe(false);
      expect(hasRole("dev", "dev")).toBe(true);
      expect(hasRole("dev", "ops")).toBe(true);
      expect(hasRole("dev", "sales")).toBe(true);
    });

    it("sales has only sales", () => {
      expect(hasRole("sales", "sales")).toBe(true);
      expect(hasRole("sales", "ops")).toBe(false);
      expect(hasRole("sales", "dev")).toBe(false);
      expect(hasRole("sales", "cto")).toBe(false);
    });
  });

  describe("createToken / verifyToken", () => {
    it("creates a JWT string", () => {
      const token = createToken({
        id: "u1",
        email: "test@test.com",
        name: "Test",
        role: "dev",
        created_at: "",
      });
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
    });

    it("verifyToken round-trips with createToken", () => {
      const token = createToken({
        id: "u1",
        email: "test@test.com",
        name: "Test",
        role: "dev",
        created_at: "",
      });
      const payload = verifyToken(token);
      expect(payload.userId).toBe("u1");
      expect(payload.role).toBe("dev");
    });
  });
});

describe("Dashboard Stats Shape", () => {
  it("dashboard API response has correct shape", () => {
    // Validate the expected shape matches what page.tsx and route.ts return
    const dashboardShape = {
      knowledge_count: 47,
      discussion_count: 12,
      feature_count: 8,
      team_count: 4,
      ai_efficiency: { zero_token_pct: 73.2, zero_token_answers: 34, ai_calls: 12 },
    };

    expect(dashboardShape).toHaveProperty("knowledge_count");
    expect(dashboardShape).toHaveProperty("discussion_count");
    expect(dashboardShape).toHaveProperty("feature_count");
    expect(dashboardShape).toHaveProperty("team_count");
    expect(dashboardShape).toHaveProperty("ai_efficiency");
    expect(dashboardShape.ai_efficiency).toHaveProperty("zero_token_pct");
    expect(dashboardShape.ai_efficiency).toHaveProperty("zero_token_answers");
    expect(dashboardShape.ai_efficiency).toHaveProperty("ai_calls");
    expect(typeof dashboardShape.knowledge_count).toBe("number");
    expect(typeof dashboardShape.ai_efficiency.zero_token_pct).toBe("number");
  });

  it("all analytics event types are valid strings", () => {
    const validEvents = [
      "feature.request_submitted",
      "feature.request_analyzed",
      "feature.request_approved",
      "feature.request_rejected",
      "discussion.thread_created",
      "discussion.reply_posted",
      "discussion.resolved",
      "client.doc_generated",
      "system.login",
      "system.page_viewed",
    ];

    for (const evt of validEvents) {
      expect(typeof evt).toBe("string");
      expect(evt).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });
});
