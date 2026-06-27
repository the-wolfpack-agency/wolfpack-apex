/**
 * Unit tests for target ownership verification.
 *
 * Covers: token issuance (CSPRNG, persisted, both instructions), and the proof
 * check across http success / http token-mismatch / dns success / dns mismatch /
 * SSRF-blocked target / not-yet-verified, plus isTargetVerified. All DB + IO is
 * injected/mocked so no network, DNS, or DB is touched.
 */

const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
const mockTrack = jest.fn();
const mockGetStored = jest.fn();

jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/platform-scan/targets-store", () => ({
  getStoredScanTarget: (...a: unknown[]) => mockGetStored(...a),
}));

import {
  issueVerificationToken,
  checkVerification,
  isTargetVerified,
  WELL_KNOWN_PATH,
  DNS_TXT_PREFIX,
} from "@/lib/platform-scan/authorization";
import { SsrfBlockedError } from "@/lib/platform-scan/ssrf-guard";

const ACTOR = { userId: "u-cto", role: "cto" };

beforeEach(() => {
  jest.clearAllMocks();
  mockWriteQuery.mockResolvedValue({ rows: [{ verified_at: "2026-06-27T00:00:00Z" }] });
  mockGetStored.mockResolvedValue({ baseUrl: "https://app.acme.com", routes: [] });
});

function mkRes(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body } as unknown as Response;
}

describe("issueVerificationToken", () => {
  it("generates a random hex token, persists it, and returns instructions for both methods", async () => {
    mockGetStored.mockResolvedValue({ baseUrl: "https://app.acme.com", routes: [] });
    const a = await issueVerificationToken("ws-1", "acme");
    const b = await issueVerificationToken("ws-1", "acme");

    expect(a.token).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex, CSPRNG
    expect(a.token).not.toEqual(b.token); // fresh challenge each issue
    expect(a.status).toBe("pending");
    expect(mockWriteQuery).toHaveBeenCalled();

    const methods = a.instructions.map((i) => i.method).sort();
    expect(methods).toEqual(["dns_txt", "http_well_known"]);
    const http = a.instructions.find((i) => i.method === "http_well_known")!;
    expect(http.location).toBe(`https://app.acme.com${WELL_KNOWN_PATH}`);
    expect(http.value).toBe(a.token);
    const dns = a.instructions.find((i) => i.method === "dns_txt")!;
    expect(dns.location).toBe("app.acme.com");
    expect(dns.value).toBe(`${DNS_TXT_PREFIX}${a.token}`);
  });
});

describe("checkVerification - http_well_known", () => {
  it("verifies on a matching token and fires platform.target_verified", async () => {
    const token = "a".repeat(64);
    mockSafeQuery.mockResolvedValue({ rows: [{ verification_token: token, verified_at: null }] });
    const fetchImpl = jest.fn().mockResolvedValue(mkRes(`  ${token}\n`));
    const assertScannable = jest.fn().mockResolvedValue(undefined);

    const res = await checkVerification("ws-1", "acme", "http_well_known", ACTOR, {
      fetchImpl, assertScannable, resolveBaseUrl: async () => "https://app.acme.com",
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe("verified");
    expect(fetchImpl).toHaveBeenCalledWith(`https://app.acme.com${WELL_KNOWN_PATH}`, expect.anything());
    expect(mockTrack).toHaveBeenCalledWith("platform.target_verified", "u-cto", "cto", { platform: "acme", method: "http_well_known" });
  });

  it("fails on token mismatch and fires platform.target_verification_failed", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ verification_token: "a".repeat(64), verified_at: null }] });
    const fetchImpl = jest.fn().mockResolvedValue(mkRes("b".repeat(64)));

    const res = await checkVerification("ws-1", "acme", "http_well_known", ACTOR, {
      fetchImpl, assertScannable: async () => {}, resolveBaseUrl: async () => "https://app.acme.com",
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    expect(mockTrack).toHaveBeenCalledWith("platform.target_verification_failed", "u-cto", "cto", { platform: "acme", method: "http_well_known", reason: "token_mismatch" });
  });

  it("refuses a target that the SSRF guard blocks (never fetches)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ verification_token: "a".repeat(64), verified_at: null }] });
    const fetchImpl = jest.fn();
    const assertScannable = jest.fn().mockRejectedValue(new SsrfBlockedError("private IP"));

    const res = await checkVerification("ws-1", "acme", "http_well_known", ACTOR, {
      fetchImpl, assertScannable, resolveBaseUrl: async () => "https://169.254.169.254",
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("ssrf_blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("checkVerification - dns_txt", () => {
  it("verifies when a TXT record carries the token", async () => {
    const token = "c".repeat(64);
    mockSafeQuery.mockResolvedValue({ rows: [{ verification_token: token, verified_at: null }] });
    const dnsResolveTxt = jest.fn().mockResolvedValue([["unrelated"], [`${DNS_TXT_PREFIX}${token}`]]);

    const res = await checkVerification("ws-1", "acme", "dns_txt", ACTOR, {
      dnsResolveTxt, resolveBaseUrl: async () => "https://app.acme.com",
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe("verified");
    expect(dnsResolveTxt).toHaveBeenCalledWith("app.acme.com");
    expect(mockTrack).toHaveBeenCalledWith("platform.target_verified", "u-cto", "cto", { platform: "acme", method: "dns_txt" });
  });

  it("fails when no TXT record matches", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ verification_token: "c".repeat(64), verified_at: null }] });
    const dnsResolveTxt = jest.fn().mockResolvedValue([[`${DNS_TXT_PREFIX}${"d".repeat(64)}`]]);

    const res = await checkVerification("ws-1", "acme", "dns_txt", ACTOR, {
      dnsResolveTxt, resolveBaseUrl: async () => "https://app.acme.com",
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
  });

  it("fails with no_txt_record when the resolver throws (no record present)", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ verification_token: "c".repeat(64), verified_at: null }] });
    const dnsResolveTxt = jest.fn().mockRejectedValue(new Error("ENOTFOUND"));

    const res = await checkVerification("ws-1", "acme", "dns_txt", ACTOR, {
      dnsResolveTxt, resolveBaseUrl: async () => "https://app.acme.com",
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_txt_record");
  });
});

describe("checkVerification - not yet issued", () => {
  it("fails when no token has been issued", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    const res = await checkVerification("ws-1", "acme", "http_well_known", ACTOR, {
      fetchImpl: jest.fn(), assertScannable: async () => {}, resolveBaseUrl: async () => "https://app.acme.com",
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_token_issued");
  });
});

describe("isTargetVerified (the orchestrator gate)", () => {
  it("true only when a token exists AND verified_at is set", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ verification_token: "a".repeat(64), verified_at: "2026-06-27T00:00:00Z" }] });
    expect(await isTargetVerified("ws-1", "acme")).toBe(true);
  });

  it("false when not yet verified", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ verification_token: "a".repeat(64), verified_at: null }] });
    expect(await isTargetVerified("ws-1", "acme")).toBe(false);
  });

  it("false when no verification row exists", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await isTargetVerified("ws-1", "acme")).toBe(false);
  });
});
