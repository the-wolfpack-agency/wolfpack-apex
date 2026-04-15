/**
 * CSP Violation Report Endpoint
 *
 * Browsers send violation reports here when Content-Security-Policy blocks a
 * resource. No authentication required — browsers submit these automatically.
 *
 * The route validates the report shape, writes a system.csp_violation_reported
 * analytics event, and returns 204 (no content) so the browser is satisfied.
 */

import { NextRequest, NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics";

// Shape of a browser CSP violation report (csp-report key from report-uri format)
interface CspViolationReport {
  "blocked-uri"?: string;
  "violated-directive"?: string;
  "source-file"?: string;
  "line-number"?: number;
  "column-number"?: number;
  "referrer"?: string;
  "document-uri"?: string;
  "original-policy"?: string;
  "disposition"?: string;
  "status-code"?: number;
}

interface CspReportBody {
  "csp-report": CspViolationReport;
}

function isValidCspReport(body: unknown): body is CspReportBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b["csp-report"] !== "object" || b["csp-report"] === null) return false;
  return true;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isValidCspReport(body)) {
    return NextResponse.json(
      { error: "Missing or malformed csp-report field" },
      { status: 400 },
    );
  }

  const report = body["csp-report"];

  const blockedUri = String(report["blocked-uri"] ?? "");
  const violatedDirective = String(report["violated-directive"] ?? "");
  const sourceFile = String(report["source-file"] ?? "");
  const lineNumber = Number(report["line-number"] ?? 0);

  // Fire-and-forget analytics event — system context, no real user ID
  trackEvent(
    "system.csp_violation_reported",
    "system",
    "system",
    {
      blocked_uri: blockedUri,
      violated_directive: violatedDirective,
      source_file: sourceFile,
      line_number: lineNumber,
    },
  );

  // 204: report accepted, no body
  return new NextResponse(null, { status: 204 });
}
