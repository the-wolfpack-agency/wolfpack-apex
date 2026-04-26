/**
 * POST /api/automations/[automationId]/summaries/[classKey]/upload-sharepoint
 *
 * Assembles the AssembledSummary, renders it as a .docx, and PUTs it to
 * the configured SharePoint folder via Microsoft Graph. Replaces Alicia's
 * manual "download → drop into SharePoint" handoff for PCNA.
 *
 * Auth: requires `automations.run` capability (codified — `automations.manage`
 * is not a registered capability in `src/lib/auth/capabilities.ts`; "run"
 * is the existing trigger-action capability used by `/poll` and the same
 * roles already have it).
 *
 * Response shape:
 *   200 { ok: true, web_url }                     — uploaded
 *   202 { ok: false, skipped_reason, error }      — gracefully skipped
 *                                                   (not_configured / no_token)
 *   404 { error }                                 — automation or class not found
 *   502 { ok: false, skipped_reason: "graph_error", error, status }
 *                                                 — Graph rejected the upload
 *
 * 202 (Accepted) is intentional for the gracefully-skipped paths so the
 * UI can show "SharePoint not yet configured" / "Reconnect Microsoft"
 * without surfacing a hard error. The route NEVER throws — every failure
 * path is JSON.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getAutomation } from "@/lib/automations/registry";
import { renderClassSummaryDocx } from "@/lib/automations/porsche-classes/export-docx";
import { uploadClassSummary } from "@/lib/automations/porsche-classes/sharepoint-upload";
import { recordAction } from "@/lib/automations/porsche-classes/audit-repo";

interface Ctx {
  params: Promise<{ automationId: string; classKey: string }>;
}

/**
 * Build a deterministic SharePoint filename from the assembled summary.
 * Format: `<course> - YYYY-MM-DD - <location>.docx`.
 *
 * Hardened against the "The string did not match the expected pattern"
 * error Microsoft Graph returns when a drive-item name violates the
 * SharePoint name regex:
 *   - class_date is normalized to YYYY-MM-DD (no time-of-day, no `Z`,
 *     no `.000` — those produced patterns like `T000000.000Z` that
 *     Graph rejected on path-addressed PUT).
 *   - All Windows-restricted chars (\\ / : * ? " < > |) are stripped.
 *   - Hash, percent, ampersand stripped (some SharePoint tenants
 *     reject these in path names).
 *   - Leading/trailing whitespace and trailing periods trimmed —
 *     Graph forbids both.
 *   - Multiple consecutive whitespace runs collapse to a single space.
 */
export function buildFilename(opts: {
  course_type: unknown;
  class_date: unknown;
  location: unknown;
}): string {
  // Coerce every field to a string before doing string ops. Postgres
  // can hand back DATE columns as JS Date instances depending on
  // pg-types config, and any non-string value here would throw
  // "TypeError: e.match is not a function" the moment we touch the
  // regex below. Build-tool-first defensive: stringify, then process.
  const toStr = (v: unknown): string => {
    if (v == null) return "";
    if (v instanceof Date) {
      return Number.isNaN(v.getTime()) ? "" : v.toISOString();
    }
    return typeof v === "string" ? v : String(v);
  };
  const dateOnly = (raw: unknown): string => {
    const s = toStr(raw);
    if (!s) return "Date";
    // Match the leading YYYY-MM-DD if present (covers both
    // 2026-04-20T00:00:00.000Z and bare 2026-04-20). Anything that
    // doesn't match falls back to a parse + slice so we never leak
    // a colon or period through.
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return safe(s);
  };
  const safe = (raw: unknown): string => {
    let out = toStr(raw)
      .replace(/[\\/:*?"<>|#%&]+/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .trim();
    if (!out) out = "Class";
    return out;
  };
  return `${safe(opts.course_type)} - ${dateOnly(opts.class_date)} - ${safe(opts.location)}.docx`;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  const { automationId, classKey: rawClassKey } = await ctx.params;
  const classKey = decodeURIComponent(rawClassKey);

  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json(
      { error: "automation not found", automationId },
      { status: 404 },
    );
  }
  if (!automation.assemble_summary) {
    return NextResponse.json(
      { error: "automation does not implement summary assembly", automationId },
      { status: 404 },
    );
  }

  // 1. Assemble the summary. Null = no snapshots → 404.
  let summary;
  try {
    summary = await automation.assemble_summary(classKey);
  } catch (err) {
    console.error(
      `[automations/${automationId}/summaries/${classKey}/upload-sharepoint] assembler threw:`,
      (err as Error).message,
    );
    return NextResponse.json(
      { error: "summary assembly failed", reason: "assembler_error" },
      { status: 500 },
    );
  }
  if (!summary) {
    return NextResponse.json(
      { error: "no snapshots for this class", classKey },
      { status: 404 },
    );
  }

  // 2. Render the .docx — pure CPU, in-process. Failures here would mean
  // the renderer broke; surface as 500 (not graph_error).
  let bytes: Buffer;
  try {
    bytes = await renderClassSummaryDocx(summary);
  } catch (err) {
    console.error(
      `[automations/${automationId}/summaries/${classKey}/upload-sharepoint] render threw:`,
      (err as Error).message,
    );
    return NextResponse.json(
      { error: "docx render failed", reason: "render_error" },
      { status: 500 },
    );
  }

  const filename = buildFilename({
    course_type: summary.course_type,
    class_date: summary.class_date,
    location: summary.location,
  });

  // 3. Emit attempt analytics BEFORE the network call so we have a record
  // even when the upload itself fails after this point (e.g. node crash).
  trackEvent("automations.sharepoint_upload_attempted", auth.user.id, auth.user.role, {
    automation_id: automationId,
    class_key: classKey,
    filename,
    byte_count: bytes.length,
  });

  // 4. Upload. Dual-anchor token lookup — userId first, email fallback —
  // mirrors the meeting-insights live-pull pattern in
  // /api/meetings/feeds/[slug]/poll/route.ts.
  const result = await uploadClassSummary({
    userId: auth.user.id,
    userEmail: auth.user.email,
    filename,
    bytes,
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  if (result.ok) {
    trackEvent(
      "automations.sharepoint_upload_succeeded",
      auth.user.id,
      auth.user.role,
      {
        automation_id: automationId,
        class_key: classKey,
        filename,
        byte_count: bytes.length,
        web_url: result.web_url,
      },
    );
    // Audit log + 24h undo: record the action AFTER the analytics event
    // (analytics is fire-and-forget so its failure mode is invisible;
    // the audit insert is strict — we wrap defensively so a pg outage on
    // the audit table does not poison a successful upload). The audit
    // row carries item_id (durable Graph handle for DELETE) + web_url
    // (operator-friendly link).
    let audit_id: string | null = null;
    try {
      const audit = await recordAction({
        automation_id: automationId,
        action_kind: "sharepoint_upload",
        target_ref: classKey,
        actor: auth.user.email,
        detail: {
          item_id: result.item_id,
          web_url: result.web_url,
          filename,
        },
      });
      audit_id = audit.id;
    } catch (err) {
      console.warn(
        `[automations/${automationId}/summaries/${classKey}/upload-sharepoint] audit insert failed:`,
        (err as Error).message,
      );
    }
    return NextResponse.json(
      { ok: true, web_url: result.web_url, filename, audit_id },
      { status: 200 },
    );
  }

  // Skipped / failed — emit the skip event with the structured reason.
  trackEvent(
    "automations.sharepoint_upload_skipped",
    auth.user.id,
    auth.user.role,
    {
      automation_id: automationId,
      class_key: classKey,
      filename,
      skipped_reason: result.skipped_reason ?? "graph_error",
      status: result.status ?? 0,
    },
  );

  // 202 for not_configured / no_token (graceful degradation), 502 for
  // upstream Graph rejections so the client can distinguish.
  const isGraceful =
    result.skipped_reason === "not_configured" ||
    result.skipped_reason === "no_token";
  const status = isGraceful ? 202 : 502;

  // Server-side diagnostic — Graph 4xx with a confusing message
  // ("The string did not match the expected pattern") is always a
  // path-validation failure. Logging the exact filename + status +
  // body makes the next session debuggable.
  if (!isGraceful) {
    console.error(
      `[automations/${automationId}/summaries/${classKey}/upload-sharepoint] ` +
        `Graph rejected upload — ` +
        `filename="${filename}" ` +
        `status=${result.status ?? 0} ` +
        `error=${(result.error ?? "").slice(0, 800)}`,
    );
  }

  return NextResponse.json(
    {
      ok: false,
      error: result.error,
      skipped_reason: result.skipped_reason ?? "graph_error",
      ...(result.status ? { upstream_status: result.status } : {}),
      filename,
      // Diagnostic block surfaced in the UI so the operator can see
      // what was actually sent. Only filled on real failures.
      diagnostic: {
        filename,
        course_type: summary.course_type,
        class_date: summary.class_date,
        location: summary.location,
        byte_count: bytes.length,
      },
    },
    { status },
  );
}
