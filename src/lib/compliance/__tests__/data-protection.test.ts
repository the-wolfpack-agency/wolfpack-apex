/**
 * Data-protection compliance: proves the new MEASURED evidence (crypto signing +
 * at-rest encryption, tenant-isolation guardrail) drives the new controls
 * honestly. cryptoPosture probes the real signer + encryption (mocked here for
 * determinism); isolationPosture reads the real committed baseline; and the new
 * crosswalk controls move covered/partial/gap with the evidence, never asserted.
 */

const mockGetSigner = jest.fn();
const mockEncrypt = jest.fn();
const mockDecrypt = jest.fn();

jest.mock("@/lib/ogiam/signing", () => ({ getSigner: () => mockGetSigner() }));
jest.mock("@/lib/crypto/secret-storage", () => ({
  encryptSecret: (...a: unknown[]) => mockEncrypt(...a),
  decryptSecret: (...a: unknown[]) => mockDecrypt(...a),
}));

import { cryptoPosture, isolationPosture } from "../evidence";
import { generateReport } from "../report";
import type { EvidenceInputs } from "../types";

beforeEach(() => {
  jest.resetAllMocks();
  // Healthy defaults: ES256 signer + a real round-tripping encryptor.
  mockGetSigner.mockReturnValue({ algorithm: "ES256" });
  mockEncrypt.mockImplementation((p: string) => `enc(${p})`);
  mockDecrypt.mockImplementation((t: string) => (t.startsWith("enc(") ? t.slice(4, -1) : null));
});

describe("cryptoPosture (measured)", () => {
  test("active signer + round-tripping encryption -> protected", () => {
    const c = cryptoPosture();
    expect(c).toEqual({ signingActive: true, signingAlgorithm: "ES256", secretsEncryptedAtRest: true });
  });
  test("null signer -> signing inactive (honest gap)", () => {
    mockGetSigner.mockReturnValue({ algorithm: "none" });
    const c = cryptoPosture();
    expect(c.signingActive).toBe(false);
    expect(c.signingAlgorithm).toBe("none");
  });
  test("encryption that does not round-trip -> not protected", () => {
    mockDecrypt.mockReturnValue("tampered");
    expect(cryptoPosture().secretsEncryptedAtRest).toBe(false);
  });
  test("a throwing encryptor degrades to false, never throws", () => {
    mockEncrypt.mockImplementation(() => { throw new Error("no key"); });
    expect(cryptoPosture().secretsEncryptedAtRest).toBe(false);
  });
  test("ciphertext equal to plaintext is not treated as encrypted", () => {
    mockEncrypt.mockImplementation((p: string) => p);
    expect(cryptoPosture().secretsEncryptedAtRest).toBe(false);
  });
});

describe("isolationPosture (real committed baseline)", () => {
  test("the guardrail baseline is enforced with scoped tables (0 unclassified)", () => {
    const i = isolationPosture();
    expect(i.tenantIsolationEnforced).toBe(true);
    expect(i.tenantScopedTables).toBeGreaterThan(0);
  });
});

/** A full, healthy evidence object; override per assertion. */
const healthy: EvidenceInputs = {
  auditChainValid: true, auditEntries: 100, gateDecisions: 10, gateWouldBlock: 2,
  enforceCapabilities: 3, redteamPassRate: 1, redteamRecent: true,
  aiSurfacesTotal: 10, ungovernedAiSurfaces: 0,
  signingActive: true, signingAlgorithm: "ES256", secretsEncryptedAtRest: true,
  tenantIsolationEnforced: true, tenantScopedTables: 44,
};
const statusOf = (fw: Parameters<typeof generateReport>[0], id: string, e: EvidenceInputs) =>
  generateReport(fw, e).controls.find((c) => c.id === id)?.status;

describe("new crosswalk controls track the evidence", () => {
  test("tenant isolation: enforced->covered, scoped-but-unclassified->partial, none->gap", () => {
    expect(statusOf("SOC2", "SOC2-CC6.6", healthy)).toBe("covered");
    expect(statusOf("SOC2", "SOC2-CC6.6", { ...healthy, tenantIsolationEnforced: false })).toBe("partial");
    expect(statusOf("SOC2", "SOC2-CC6.6", { ...healthy, tenantIsolationEnforced: false, tenantScopedTables: 0 })).toBe("gap");
  });
  test("encryption: both->covered, one->partial, neither->gap (SOC2 + ISO mirror)", () => {
    expect(statusOf("SOC2", "SOC2-CC6.7", healthy)).toBe("covered");
    expect(statusOf("SOC2", "SOC2-CC6.7", { ...healthy, secretsEncryptedAtRest: false })).toBe("partial");
    expect(statusOf("ISO42001", "ISO42001-A.8.3", { ...healthy, signingActive: false, secretsEncryptedAtRest: false })).toBe("gap");
  });
  test("record integrity: ledger+signing->covered, ledger only->partial, no ledger->gap", () => {
    expect(statusOf("EU_AI_ACT", "EUAIACT-ART12-INTEGRITY", healthy)).toBe("covered");
    expect(statusOf("EU_AI_ACT", "EUAIACT-ART12-INTEGRITY", { ...healthy, signingActive: false })).toBe("partial");
    expect(statusOf("EU_AI_ACT", "EUAIACT-ART12-INTEGRITY", { ...healthy, auditChainValid: false, auditEntries: 0, signingActive: false })).toBe("gap");
  });
});
