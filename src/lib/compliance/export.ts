/**
 * Forwardable, cryptographically SIGNED compliance evidence export.
 *
 * The "Comply" beat turns governance from a login into a receipt: a CISO or
 * auditor receives a single artifact they can verify OFFLINE, instead of being
 * asked to log in and trust the screen. This module is the source of truth for
 * that artifact.
 *
 * WHAT WE PRODUCE (and why, comparing the options):
 *   - PDF (pdfkit / puppeteer): a heavy NEW runtime dependency, and a PDF is not
 *     machine-verifiable - the signature would be over rendered bytes, not the
 *     facts. CLAUDE.md forbids new runtime deps without strong justification.
 *     Rejected.
 *   - Self-contained signed HTML: signable, but the signature would cover
 *     presentation (markup, classes) that drifts, so verification breaks on a
 *     cosmetic change. Rejected as the SOURCE OF TRUTH.
 *   - Signed canonical JSON (CHOSEN): the signature covers a deterministic,
 *     sorted-key JSON of the FACTS (framework, controls, coverage, the evidence
 *     each status was derived from). Auditors value a machine-verifiable
 *     signature; the same input always yields the same bytes, so the signature
 *     is stable. A printable HTML view is RENDERED FROM the same payload (no new
 *     dep, just a string template) for the human reader. The HTML is a view; the
 *     JSON + detached signature is the evidence.
 *
 * CANONICALIZATION: reuse `canonicalJSON` from @/lib/audit-log - the exact
 * sorted-key serializer the hash chain already commits to. One canonicalizer in
 * the repo so a signature produced here verifies byte-for-byte anywhere. Do not
 * re-implement.
 *
 * SIGNING: reuse the OGIAM signer (getSigner -> Azure Key Vault ES256 in prod,
 * HMAC dev fallback, disabled otherwise) - the established detached-signature
 * pattern with independent verify() and graceful degradation. The crypto
 * registry (src/lib/crypto/algorithms.ts) reserves the ml-dsa-65-hybrid slot for
 * the post-quantum migration; the signer's `algorithm` field is recorded in the
 * artifact so a future PQ algorithm verifies through the same envelope without a
 * format change (crypto agility).
 *
 * SECURITY:
 *   - The signature covers the FULL canonical payload. verify() recomputes the
 *     canonical bytes and checks the signature, so ANY tampering (a flipped
 *     status, an edited coverage number, an added control) fails verification.
 *   - We never expose the private key (the signer holds it; KeyVault never
 *     releases it) and we never sign client-controlled fields blindly: the
 *     payload is built from a STORED report fetched by (id, workspaceId).
 *   - Workspace scoping (no IDOR) is the caller's contract: pass only a report
 *     the requesting workspace owns (getReportById enforces it).
 */

import { createHash } from "crypto";
import { canonicalJSON } from "@/lib/audit-log";
import { getSigner, type OgiamSigner } from "@/lib/ogiam/signing";
import type { ComplianceReport } from "./types";

/** The artifact format version. Bump if the payload SHAPE changes so a verifier
 *  can dispatch; signatures are over a specific version's canonical bytes. */
export const EVIDENCE_EXPORT_VERSION = "1" as const;

/** The facts the signature commits to. Deterministic: build it from the same
 *  stored report + identity and you get byte-identical canonical JSON, so the
 *  signature is reproducible. Nothing here is presentation. */
export interface EvidencePayload {
  version: typeof EVIDENCE_EXPORT_VERSION;
  /** Stable artifact kind tag, so a verifier never confuses this with another
   *  signed envelope (e.g. an OGIAM checkpoint). */
  kind: "compliance-evidence";
  reportId: string;
  workspaceId: string;
  framework: string;
  generatedAt: string;
  /** The full report the status table is derived from. */
  report: ComplianceReport;
}

/** The verification metadata recorded alongside the signature so a third party
 *  can re-check it offline: which algorithm, which key, what canonical bytes the
 *  signature is over (by hash, so the verifier can confirm it has the same
 *  payload), and how to reproduce them. */
export interface SignatureEnvelope {
  /** "ES256" | "HS256-local" | "none". Mirrors the signer's algorithm; future
   *  PQ algorithms slot in here without changing the envelope shape. */
  algorithm: string;
  /** Public key identifier (vault key URL or a local label). Never a secret. */
  keyId: string;
  /** base64 detached signature over the canonical payload bytes, or null when
   *  signing is disabled (the artifact is still a faithful, hash-anchored
   *  snapshot; it is just not notarized). */
  signature: string | null;
  /** Whether a real (non-local) signature was produced. */
  signed: boolean;
  /** sha256 (hex) of the canonical payload bytes the signature is over. Lets a
   *  verifier confirm payload integrity even before checking the signature. */
  payloadSha256: string;
  /** The canonicalization scheme, so a verifier reproduces the exact bytes. */
  canonicalization: "json-sorted-keys";
}

/** The full forwardable artifact: the facts, the canonical bytes the signature
 *  is over, the signature envelope, and a printable HTML view rendered from the
 *  same facts. JSON is the source of truth; HTML is the human view. */
export interface ComplianceEvidenceExport {
  payload: EvidencePayload;
  /** The exact canonical JSON string the signature is computed over. Included
   *  verbatim so a verifier need not re-canonicalize to check the signature. */
  canonicalPayload: string;
  signature: SignatureEnvelope;
  /** Self-contained printable HTML rendered from `payload`. View only. */
  html: string;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Escape user/text content for safe HTML interpolation (the report strings are
 *  system-derived, but escape defensively so the printable view can never inject
 *  markup into a forwarded artifact). */
function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATUS_LABEL: Record<string, string> = {
  covered: "Covered",
  partial: "Partial",
  gap: "Gap",
};

/** Render the printable, self-contained HTML view from the signed payload. No
 *  external assets, inline styles only, so a forwarded file renders standalone
 *  and offline. Includes the verification metadata so a reader sees this is a
 *  signed artifact, not a screenshot. */
export function renderEvidenceHtml(
  payload: EvidencePayload,
  signature: SignatureEnvelope,
): string {
  const r = payload.report;
  const pct = `${Math.round(r.coverage * 100)}%`;
  const rows = r.controls
    .map(
      (c) => `        <tr>
          <td>${esc(c.id)} ${esc(c.name)}</td>
          <td>${esc(c.ogiamControl)}</td>
          <td class="status status-${esc(c.status)}">${esc(STATUS_LABEL[c.status] ?? c.status)}</td>
          <td>${esc(c.evidence)}</td>
        </tr>`,
    )
    .join("\n");

  const sigLine = signature.signed
    ? `Signed (${esc(signature.algorithm)}) · key ${esc(signature.keyId)}`
    : "Not notarized (signing not configured) · payload hash-anchored";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Compliance Evidence — ${esc(payload.framework)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 2rem; max-width: 60rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { color: #555; margin: 0 0 1.5rem; }
  .meta { background: #f6f7f9; border: 1px solid #e2e5ea; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; font-size: 12.5px; }
  .meta dt { color: #666; font-weight: 600; }
  .meta dd { margin: 0 0 .5rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  .summary { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .tile { border: 1px solid #e2e5ea; border-radius: 8px; padding: .75rem 1rem; min-width: 7rem; }
  .tile b { display: block; font-size: 1.5rem; }
  .tile span { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: .55rem .5rem; border-top: 1px solid #e2e5ea; vertical-align: top; }
  th { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
  .status { font-weight: 600; }
  .status-covered { color: #0a7a32; }
  .status-partial { color: #9a6b00; }
  .status-gap { color: #b00020; }
  .note { color: #555; font-size: 12px; margin-top: 1.5rem; }
  @media print { body { margin: 0; } .meta { background: #fff; } }
</style>
</head>
<body>
  <h1>Compliance Evidence — ${esc(payload.framework)}</h1>
  <p class="sub">Coverage against ${esc(payload.framework)}, derived from measured controls. Forwardable, signed evidence.</p>

  <dl class="meta">
    <dt>Report ID</dt><dd>${esc(payload.reportId)}</dd>
    <dt>Generated</dt><dd>${esc(payload.generatedAt)}</dd>
    <dt>Signature</dt><dd>${sigLine}</dd>
    <dt>Payload SHA-256</dt><dd>${esc(signature.payloadSha256)}</dd>
  </dl>

  <div class="summary">
    <div class="tile"><b>${pct}</b><span>Coverage</span></div>
    <div class="tile"><b>${esc(r.covered)}</b><span>Covered</span></div>
    <div class="tile"><b>${esc(r.partial)}</b><span>Partial</span></div>
    <div class="tile"><b>${esc(r.gap)}</b><span>Gaps</span></div>
  </div>

  <table>
    <thead><tr><th>Control</th><th>OGIAM control</th><th>Status</th><th>Evidence</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>

  <p class="note">${esc(r.generatedNote)}</p>
  <p class="note">Verify this artifact by recomputing the canonical JSON payload and checking the detached signature against the recorded public key (${esc(signature.keyId)}).</p>
</body>
</html>`;
}

/**
 * Build the full signed evidence artifact from a STORED report. The caller must
 * have already scoped the report to the requesting workspace (getReportById);
 * this function does not fetch, it only serializes + signs what it is given, so
 * it is pure of IO except the signer call.
 *
 * The signature is a DETACHED signature over the canonical payload bytes. Best
 * effort: when the signer is disabled the artifact still carries the payload and
 * its sha256 (hash-anchored), with signature=null and signed=false.
 */
export async function buildEvidenceExport(
  input: { reportId: string; workspaceId: string; report: ComplianceReport; generatedAt: string },
  signer: OgiamSigner = getSigner(),
): Promise<ComplianceEvidenceExport> {
  const payload: EvidencePayload = {
    version: EVIDENCE_EXPORT_VERSION,
    kind: "compliance-evidence",
    reportId: input.reportId,
    workspaceId: input.workspaceId,
    framework: input.report.framework,
    generatedAt: input.generatedAt,
    report: input.report,
  };

  // The signature covers the FULL canonical payload. Deterministic sorted-key
  // JSON via the repo's single canonicalizer, so the same input always yields
  // the same bytes and the signature is reproducible / re-verifiable offline.
  const canonicalPayload = canonicalJSON(payload);
  const payloadSha256 = sha256Hex(canonicalPayload);

  const sig = await signer.sign(canonicalPayload);

  const signature: SignatureEnvelope = {
    algorithm: sig.algorithm,
    keyId: sig.keyId,
    signature: sig.signature,
    signed: sig.signature != null,
    payloadSha256,
    canonicalization: "json-sorted-keys",
  };

  const html = renderEvidenceHtml(payload, signature);

  return { payload, canonicalPayload, signature, html };
}

/**
 * Independently verify a signed evidence artifact. This is the core security
 * property: re-canonicalize the payload, confirm it matches the recorded
 * canonical bytes + hash, and check the detached signature against the signer's
 * public key. Returns false (never throws) on ANY mismatch - a tampered payload,
 * a swapped signature, a wrong hash, or a missing signature.
 *
 * Reproduces the verifier's own canonical bytes from `payload` rather than
 * trusting `canonicalPayload`, so an attacker cannot smuggle different facts in
 * the payload while leaving the signed bytes intact: the two must agree.
 */
export async function verifyEvidenceExport(
  artifact: Pick<ComplianceEvidenceExport, "payload" | "canonicalPayload" | "signature">,
  signer: OgiamSigner = getSigner(),
): Promise<boolean> {
  try {
    // 1. The canonical bytes must reproduce from the payload (no smuggled facts).
    const recomputed = canonicalJSON(artifact.payload);
    if (recomputed !== artifact.canonicalPayload) return false;

    // 2. The recorded hash must match those bytes.
    if (sha256Hex(recomputed) !== artifact.signature.payloadSha256) return false;

    // 3. There must be a signature to check, and it must verify against the key.
    if (!artifact.signature.signature) return false;
    return await signer.verify(recomputed, artifact.signature.signature);
  } catch {
    return false;
  }
}
