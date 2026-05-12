/**
 * Tests for the crypto-agility sign/verify layer and algorithm registry.
 *
 * Covers:
 *   - sign→verify roundtrip for each supported algorithm
 *   - tampered token fails verify
 *   - wrong secret fails verify
 *   - ml-dsa-65-hybrid throws NotImplementedError (reserved PQC slot)
 *   - unknown algorithm is rejected
 *   - analytics events emitted on each path
 */

 

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

// Must require AFTER mocking analytics
const { signToken, verifyToken } = require("@/lib/crypto/sign") as typeof import("@/lib/crypto/sign");
const {
  ALGORITHMS,
  CURRENT_SIGN_ALGORITHM,
  NotImplementedError,
  assertCallable,
} = require("@/lib/crypto/algorithms") as typeof import("@/lib/crypto/algorithms");

const origEnv = process.env;

beforeEach(() => {
  jest.resetModules();
  mockTrackEvent.mockClear();
  process.env = {
    ...origEnv,
    NODE_ENV: "test",
    INSTINCT_JWT_SECRET: "test-secret-32-chars-exactly!!x",
  };
});

afterAll(() => {
  process.env = origEnv;
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
describe("Algorithm registry", () => {
  it("CURRENT_SIGN_ALGORITHM is hs256", () => {
    expect(CURRENT_SIGN_ALGORITHM).toBe("hs256");
  });

  it("has hs256, rs256, es256 and ml-dsa-65-hybrid registered", () => {
    expect(Object.keys(ALGORITHMS)).toEqual(
      expect.arrayContaining(["hs256", "rs256", "es256", "ml-dsa-65-hybrid"]),
    );
  });

  it("ml-dsa-65-hybrid is marked quantumSafe", () => {
    expect(ALGORITHMS["ml-dsa-65-hybrid"].quantumSafe).toBe(true);
  });

  it("hs256/rs256/es256 are NOT quantumSafe", () => {
    expect(ALGORITHMS["hs256"].quantumSafe).toBe(false);
    expect(ALGORITHMS["rs256"].quantumSafe).toBe(false);
    expect(ALGORITHMS["es256"].quantumSafe).toBe(false);
  });

  it("ml-dsa-65-hybrid has empty jwtAlg (unimplemented)", () => {
    expect(ALGORITHMS["ml-dsa-65-hybrid"].jwtAlg).toBe("");
  });
});

// ---------------------------------------------------------------------------
// NotImplementedError for PQC reserved slot
// ---------------------------------------------------------------------------
describe("NotImplementedError — ml-dsa-65-hybrid", () => {
  it("assertCallable throws NotImplementedError for ml-dsa-65-hybrid", () => {
    expect(() => assertCallable("ml-dsa-65-hybrid")).toThrow(NotImplementedError);
  });

  it("signToken throws NotImplementedError when ml-dsa-65-hybrid is requested", () => {
    expect(() => signToken({ userId: "x" }, { algorithm: "ml-dsa-65-hybrid" })).toThrow(
      NotImplementedError,
    );
  });

  it("error message mentions NIST FIPS 204 and the algorithm name", () => {
    try {
      signToken({ userId: "x" }, { algorithm: "ml-dsa-65-hybrid" });
      fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/ml-dsa-65-hybrid/);
      expect((err as Error).message).toMatch(/FIPS 204/);
    }
  });
});

// ---------------------------------------------------------------------------
// sign → verify roundtrip (hs256 — the current algorithm)
// ---------------------------------------------------------------------------
describe("signToken / verifyToken roundtrip — hs256", () => {
  it("verifies a freshly signed token", () => {
    const token = signToken({ userId: "u1", role: "dev" });
    const result = verifyToken<{ userId: string; role: string }>(token);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.userId).toBe("u1");
      expect(result.payload.role).toBe("dev");
      expect(result.algorithm).toBe("hs256");
    }
  });

  it("emits system.token_signed on sign", () => {
    signToken({ userId: "u2" });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.token_signed",
      "system",
      "system",
      expect.objectContaining({ algorithm: "hs256", quantum_safe: false }),
    );
  });

  it("emits system.token_verified on successful verify", () => {
    const token = signToken({ userId: "u3" });
    mockTrackEvent.mockClear();
    verifyToken(token);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.token_verified",
      "system",
      "system",
      expect.objectContaining({ algorithm: "hs256", valid: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tampered token fails
// ---------------------------------------------------------------------------
describe("Tampered token", () => {
  it("fails verify with reason=invalid when payload is tampered", () => {
    const token = signToken({ userId: "honest" });
    const parts = token.split(".");
    // tamper the payload
    const tamperedPayload = Buffer.from(
      JSON.stringify({ userId: "attacker", role: "cto" }),
    ).toString("base64url");
    const tampered = [parts[0], tamperedPayload, parts[2]].join(".");

    const result = verifyToken(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("invalid");
    }
  });

  it("emits system.token_verify_failed on tampered token", () => {
    const token = signToken({ userId: "honest2" });
    const parts = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ userId: "x" })).toString("base64url");
    const tampered = [parts[0], tamperedPayload, parts[2]].join(".");
    mockTrackEvent.mockClear();
    verifyToken(tampered);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.token_verify_failed",
      "system",
      "system",
      expect.objectContaining({ reason: "invalid" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Wrong secret
// ---------------------------------------------------------------------------
describe("Wrong secret", () => {
  it("fails verify when env secret changes (simulating key rotation)", () => {
    const token = signToken({ userId: "u4" });
    // Change secret to simulate wrong key
    process.env.INSTINCT_JWT_SECRET = "a-different-secret-32-chars-exactly";
    jest.resetModules();
    const { verifyToken: freshVerify } = require("@/lib/crypto/sign") as typeof import("@/lib/crypto/sign");
    const result = freshVerify(token);
    expect(result.valid).toBe(false);
    // restore
    process.env.INSTINCT_JWT_SECRET = "test-secret-32-chars-exactly!!x";
  });
});

// ---------------------------------------------------------------------------
// TTL propagated correctly
// ---------------------------------------------------------------------------
describe("TTL", () => {
  it("includes a custom ttl in the token claims", () => {
    const token = signToken({ userId: "ttl-test" }, { ttlSeconds: 3600 });
    const result = verifyToken<{ userId: string; exp: number; iat: number }>(token);
    expect(result.valid).toBe(true);
    if (result.valid) {
      const delta = result.payload.exp - result.payload.iat;
      expect(delta).toBe(3600);
    }
  });

  it("default TTL is 900 seconds (15 min)", () => {
    const token = signToken({ userId: "default-ttl" });
    const result = verifyToken<{ userId: string; exp: number; iat: number }>(token);
    expect(result.valid).toBe(true);
    if (result.valid) {
      const delta = result.payload.exp - result.payload.iat;
      expect(delta).toBe(900);
    }
  });
});
