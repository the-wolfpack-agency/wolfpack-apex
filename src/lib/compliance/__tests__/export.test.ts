/**
 * Unit tests for the signed compliance evidence export (src/lib/compliance/export).
 *
 * The CORE SECURITY PROPERTY: build -> verify() === true, and ANY tamper to the
 * payload -> verify() === false. Plus: the canonical payload is deterministic
 * for the same input (so the signature is reproducible), and a disabled signer
 * degrades gracefully (signature null, signed=false, still hash-anchored).
 *
 * An in-test HMAC signer implements the OgiamSigner interface so the round trip
 * is exercised without Key Vault. Tamper is proven by mutating the payload AFTER
 * signing and asserting verification rejects it.
 */
import { createHmac } from "crypto";
import {
  buildEvidenceExport,
  verifyEvidenceExport,
  renderEvidenceHtml,
  EVIDENCE_EXPORT_VERSION,
} from "../export";
import type { OgiamSigner } from "@/lib/ogiam/signing";
import type { ComplianceReport } from "../types";

const SECRET = "test-evidence-signing-secret";

/** A symmetric HMAC signer that satisfies the OgiamSigner contract for the round
 *  trip. Real production signing is asymmetric Key Vault ES256; the verify()
 *  contract is identical, so this exercises the export's sign/verify wiring. */
const testSigner: OgiamSigner = {
  keyId: "test-hmac",
  algorithm: "HS256-test",
  isProduction: false,
  mode: "local",
  async sign(payload: string) {
    return {
      signature: createHmac("sha256", SECRET).update(payload).digest("base64"),
      keyId: "test-hmac",
      algorithm: "HS256-test",
    };
  },
  async verify(payload: string, signature: string) {
    const expected = createHmac("sha256", SECRET).update(payload).digest("base64");
    return expected === signature;
  },
};

/** A signer that never produces a signature (mirrors the disabled NullSigner). */
const nullSigner: OgiamSigner = {
  keyId: "none",
  algorithm: "none",
  isProduction: false,
  mode: "none",
  async sign() {
    return { signature: null, keyId: "none", algorithm: "none" };
  },
  async verify() {
    return false;
  },
};

const report: ComplianceReport = {
  framework: "SOC2",
  generatedNote: "Derived from measured evidence. Not a blanket attestation.",
  controls: [
    { id: "SOC2-CC4.1", name: "Monitoring", ogiamControl: "Tamper-evident ledger", rationale: "r", status: "covered", evidence: "audit chain verified across 42 entries" },
    { id: "SOC2-CC7.2", name: "Threat monitoring", ogiamControl: "Red-team", rationale: "r", status: "gap", evidence: "red-team pass rate n/a" },
  ],
  covered: 1,
  partial: 0,
  gap: 1,
  coverage: 0.5,
};

const input = { reportId: "cmp_abc", workspaceId: "w-1", report, generatedAt: "2026-06-30T00:00:00.000Z" };

describe("compliance evidence export", () => {
  test("builds a signed artifact and verify() round-trips to true", async () => {
    const artifact = await buildEvidenceExport(input, testSigner);

    expect(artifact.payload.version).toBe(EVIDENCE_EXPORT_VERSION);
    expect(artifact.payload.kind).toBe("compliance-evidence");
    expect(artifact.payload.reportId).toBe("cmp_abc");
    expect(artifact.payload.workspaceId).toBe("w-1");
    expect(artifact.signature.signed).toBe(true);
    expect(artifact.signature.signature).toBeTruthy();
    expect(artifact.signature.payloadSha256).toMatch(/^[0-9a-f]{64}$/);

    await expect(verifyEvidenceExport(artifact, testSigner)).resolves.toBe(true);
  });

  test("the signature covers the FULL payload: a tampered status -> verify() false", async () => {
    const artifact = await buildEvidenceExport(input, testSigner);
    // Flip a control's status from gap to covered (the exact lie an auditor cares about).
    const tampered = {
      ...artifact,
      payload: {
        ...artifact.payload,
        report: {
          ...artifact.payload.report,
          controls: artifact.payload.report.controls.map((c, i) =>
            i === 1 ? { ...c, status: "covered" as const } : c,
          ),
          gap: 0,
          covered: 2,
          coverage: 1,
        },
      },
    };
    await expect(verifyEvidenceExport(tampered, testSigner)).resolves.toBe(false);
  });

  test("tampering with the canonicalPayload bytes alone -> verify() false", async () => {
    const artifact = await buildEvidenceExport(input, testSigner);
    const tampered = { ...artifact, canonicalPayload: artifact.canonicalPayload.replace("0.5", "1") };
    await expect(verifyEvidenceExport(tampered, testSigner)).resolves.toBe(false);
  });

  test("a swapped/garbage signature -> verify() false", async () => {
    const artifact = await buildEvidenceExport(input, testSigner);
    const tampered = { ...artifact, signature: { ...artifact.signature, signature: "AAAAnotarealsig" } };
    await expect(verifyEvidenceExport(tampered, testSigner)).resolves.toBe(false);
  });

  test("a mismatched payload hash -> verify() false", async () => {
    const artifact = await buildEvidenceExport(input, testSigner);
    const tampered = { ...artifact, signature: { ...artifact.signature, payloadSha256: "0".repeat(64) } };
    await expect(verifyEvidenceExport(tampered, testSigner)).resolves.toBe(false);
  });

  test("the canonical payload is deterministic for the same input (reproducible signature)", async () => {
    const a = await buildEvidenceExport(input, testSigner);
    const b = await buildEvidenceExport(input, testSigner);
    expect(a.canonicalPayload).toBe(b.canonicalPayload);
    expect(a.signature.signature).toBe(b.signature.signature);
    expect(a.signature.payloadSha256).toBe(b.signature.payloadSha256);
  });

  test("disabled signer degrades gracefully: signature null, signed false, verify false", async () => {
    const artifact = await buildEvidenceExport(input, nullSigner);
    expect(artifact.signature.signature).toBeNull();
    expect(artifact.signature.signed).toBe(false);
    // Still hash-anchored.
    expect(artifact.signature.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyEvidenceExport(artifact, nullSigner)).resolves.toBe(false);
  });

  test("renders a self-contained printable HTML view with the facts + signature meta", async () => {
    const artifact = await buildEvidenceExport(input, testSigner);
    const html = renderEvidenceHtml(artifact.payload, artifact.signature);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("SOC2");
    expect(html).toContain("SOC2-CC4.1");
    expect(html).toContain("50%"); // coverage
    expect(html).toContain(artifact.signature.payloadSha256);
    expect(html).toContain("Signed (HS256-test)");
  });

  test("HTML escapes content so a forwarded artifact cannot inject markup", () => {
    const evil: ComplianceReport = {
      ...report,
      controls: [{ id: "<script>x</script>", name: "n", ogiamControl: "o", rationale: "r", status: "covered", evidence: "e" }],
    };
    const html = renderEvidenceHtml(
      { version: "1", kind: "compliance-evidence", reportId: "id", workspaceId: "w", framework: "SOC2", generatedAt: "t", report: evil },
      { algorithm: "none", keyId: "none", signature: null, signed: false, payloadSha256: "0".repeat(64), canonicalization: "json-sorted-keys" },
    );
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
