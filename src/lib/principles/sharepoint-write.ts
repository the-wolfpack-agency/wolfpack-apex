/**
 * SharePoint write-back for the weekly principles report.
 *
 * Closes the contract the explainer doc promises: every Monday Instinct
 * generates `Wolfpack — Last Week vs Operating Principles.docx` in the
 * same SharePoint folder as the source principles document. The cron
 * already builds + persists the markdown report (118); this module
 * generates the .docx + PUTs it via Microsoft Graph + records an audit
 * row for the learning loop.
 *
 * .docx generation uses the same JSZip approach as `parser.ts` — no
 * mammoth, no docx-js, no heavyweight libs. The hand-rolled writer
 * produces a minimal Office Open XML package that Word + Office.com +
 * SharePoint preview all render correctly.
 *
 * Auth + Graph access mirror `sharepoint-fetch.ts`: per-user M365 OAuth
 * via `getValidToken`, no app-level service principal, MCP-free.
 */

import JSZip from "jszip";

import { getValidToken } from "@/lib/microsoft-graph";
import { writeQuery, WriteQueryError } from "@/lib/db";
import type { WeeklyReportRecord } from "@/lib/principles/weekly-report";
import { encodeSharingUrl } from "@/lib/principles/sharepoint-fetch";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface ResolvedSharePointParent {
  driveId: string;
  parentItemId: string;
  parentWebUrl: string | null;
}

export type ResolveParentResult =
  | { ok: true; parent: ResolvedSharePointParent }
  | {
      ok: false;
      code:
        | "not_connected"
        | "scope_missing"
        | "not_found"
        | "graph_error";
      status?: number;
      message: string;
    };

export type UploadDocxResult =
  | {
      ok: true;
      itemId: string;
      webUrl: string | null;
      etag: string | null;
      byteCount: number;
    }
  | {
      ok: false;
      code: "scope_missing" | "graph_error";
      status?: number;
      message: string;
    };

export type WeeklyDocUploadOutcome =
  | "uploaded"
  | "skipped"
  | "failed";

export interface WeeklyDocUploadAuditInput {
  weekStart: string;
  status: WeeklyDocUploadOutcome;
  reasonCode?: string | null;
  filename?: string | null;
  byteCount?: number | null;
  parentDriveId?: string | null;
  parentItemId?: string | null;
  webUrl?: string | null;
  etag?: string | null;
  attemptedBy?: string | null;
  errorMessage?: string | null;
}

export interface WeeklyDocUploadAuditRecord {
  id: string;
  weekStart: string;
  status: WeeklyDocUploadOutcome;
  reasonCode: string | null;
  filename: string | null;
  byteCount: number | null;
  parentDriveId: string | null;
  parentItemId: string | null;
  webUrl: string | null;
  etag: string | null;
  attemptedBy: string | null;
  errorMessage: string | null;
  attemptedAt: string;
}

interface AuditRow {
  id: string;
  week_start: string;
  status: WeeklyDocUploadOutcome;
  reason_code: string | null;
  filename: string | null;
  byte_count: number | null;
  parent_drive_id: string | null;
  parent_item_id: string | null;
  web_url: string | null;
  etag: string | null;
  attempted_by: string | null;
  error_message: string | null;
  attempted_at: string;
}

/* ------------------------------------------------------------------ */
/* DOCX generation (hand-rolled OOXML via JSZip — no mammoth/docx-js)  */
/* ------------------------------------------------------------------ */

/**
 * XML-escape user content. Only `& < >` are required for Word XML
 * runs; quotes don't need escaping inside element text. Newlines are
 * stripped because the markdown→para split happens upstream.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

interface RenderedRun {
  text: string;
  bold: boolean;
}

/**
 * Split a markdown line into bold/non-bold runs at `**...**` markers.
 * Matches the parser's bold inline shape so round-tripping a generated
 * doc is loss-free.
 */
function splitMarkdownRuns(line: string): RenderedRun[] {
  if (!line) return [];
  const runs: RenderedRun[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (match.index > lastIdx) {
      runs.push({ text: line.slice(lastIdx, match.index), bold: false });
    }
    runs.push({ text: match[1], bold: true });
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < line.length) {
    runs.push({ text: line.slice(lastIdx), bold: false });
  }
  return runs;
}

interface RenderedParagraph {
  style?: "Heading1" | "Heading2";
  runs: RenderedRun[];
}

/**
 * Convert markdown into the small set of OOXML paragraph shapes Word
 * + SharePoint render reliably:
 *   - `# X` → Heading1
 *   - `## X` → Heading2
 *   - `**bold**` runs → bold
 *   - blank line → empty paragraph
 *   - everything else → plain paragraph
 *
 * We deliberately do NOT support tables here — they don't render well
 * inside SharePoint previews and the markdown report tables are short
 * enough that pipe-delimited text reads fine.
 */
export function markdownToParagraphs(md: string): RenderedParagraph[] {
  const out: RenderedParagraph[] = [];
  const lines = md.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line) {
      out.push({ runs: [] });
      continue;
    }
    if (line.startsWith("# ")) {
      out.push({ style: "Heading1", runs: splitMarkdownRuns(line.slice(2)) });
      continue;
    }
    if (line.startsWith("## ")) {
      out.push({ style: "Heading2", runs: splitMarkdownRuns(line.slice(3)) });
      continue;
    }
    out.push({ runs: splitMarkdownRuns(line) });
  }
  return out;
}

function buildParagraphXml(p: RenderedParagraph): string {
  const styleXml = p.style
    ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>`
    : "";
  if (p.runs.length === 0) {
    return `<w:p>${styleXml}</w:p>`;
  }
  const runXml = p.runs
    .map((r) => {
      const rPr = r.bold ? `<w:rPr><w:b/></w:rPr>` : "";
      return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(r.text)}</w:t></w:r>`;
    })
    .join("");
  return `<w:p>${styleXml}${runXml}</w:p>`;
}

/**
 * Build a complete .docx ZIP from a markdown body. Pure: no I/O. Tested
 * directly with JSZip.loadAsync so we know the package is parseable.
 */
export async function buildWeeklyReportDocx(markdown: string): Promise<Buffer> {
  const paragraphs = markdownToParagraphs(markdown);
  const bodyXml = paragraphs.map(buildParagraphXml).join("");

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${bodyXml}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>` +
    `</w:document>`;

  /* Minimal styles giving Heading1/Heading2 visible weight in Word. */
  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>` +
    `</w:styles>`;

  const contentTypesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `</Types>`;

  const rootRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;

  const docRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml);
  zip.file("_rels/.rels", rootRelsXml);
  zip.file("word/document.xml", documentXml);
  zip.file("word/styles.xml", stylesXml);
  zip.file("word/_rels/document.xml.rels", docRelsXml);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/* ------------------------------------------------------------------ */
/* Graph: resolve parent folder + PUT content                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve the parent folder of the source SharePoint principles doc so
 * the generated weekly report lands in the same folder, regardless of
 * which library/site it lives in.
 *
 * Returns `parentItemId` (folder driveItem id) — required because the
 * Graph upload endpoint needs the folder's id, not just its driveId.
 */
export async function resolveSharePointParent(
  userId: string,
  sharingUrl: string,
): Promise<ResolveParentResult> {
  const token = await getValidToken(userId);
  if (!token) {
    return {
      ok: false,
      code: "not_connected",
      message: "microsoft_not_connected",
    };
  }
  const shareId = encodeSharingUrl(sharingUrl);

  let metaRes: Response;
  try {
    metaRes = await fetch(`${GRAPH_BASE}/shares/${shareId}/driveItem`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
  } catch (err) {
    return {
      ok: false,
      code: "graph_error",
      message: `network: ${(err as Error).message}`,
    };
  }
  if (metaRes.status === 403) {
    return {
      ok: false,
      code: "scope_missing",
      message: "Files.Read required to resolve parent folder",
    };
  }
  if (metaRes.status === 404) {
    return {
      ok: false,
      code: "not_found",
      message: "share-id resolved to nothing — link may be private or revoked",
    };
  }
  if (!metaRes.ok) {
    return {
      ok: false,
      code: "graph_error",
      status: metaRes.status,
      message: `graph ${metaRes.status}`,
    };
  }
  const meta = (await metaRes.json().catch(() => ({}))) as {
    parentReference?: { driveId?: string; id?: string };
    webUrl?: string;
  };
  const driveId = meta.parentReference?.driveId;
  const parentItemId = meta.parentReference?.id;
  if (!driveId || !parentItemId) {
    return {
      ok: false,
      code: "graph_error",
      message: "parentReference missing driveId/id",
    };
  }
  /* The source doc's webUrl ends in the doc's filename; strip it so the
     audit row stores the parent folder URL, not the source doc URL. */
  const docWebUrl = meta.webUrl ?? null;
  const parentWebUrl = docWebUrl
    ? docWebUrl.replace(/\/[^/]*$/, "")
    : null;
  return {
    ok: true,
    parent: { driveId, parentItemId, parentWebUrl },
  };
}

/**
 * PUT the .docx bytes into the resolved parent folder. Uses Graph's
 * `:/{filename}:/content` path-relative shape so we don't need a
 * pre-created driveItem id.
 *
 * `behavior=replace` query param overwrites any existing report from a
 * prior run for the same week — matches the cron's idempotency model
 * (one row per week_start, last write wins).
 */
export async function uploadWeeklyReportDocx(args: {
  userId: string;
  parent: ResolvedSharePointParent;
  filename: string;
  bytes: Buffer;
}): Promise<UploadDocxResult> {
  const { userId, parent, filename, bytes } = args;
  const token = await getValidToken(userId);
  if (!token) {
    return {
      ok: false,
      code: "scope_missing",
      message: "microsoft_not_connected",
    };
  }
  const url =
    `${GRAPH_BASE}/drives/${parent.driveId}/items/${parent.parentItemId}` +
    `:/${encodeURIComponent(filename)}:/content?@microsoft.graph.conflictBehavior=replace`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      body: new Uint8Array(bytes),
    });
  } catch (err) {
    return {
      ok: false,
      code: "graph_error",
      message: `network: ${(err as Error).message}`,
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      code: "scope_missing",
      status: 403,
      message: "Files.ReadWrite scope required to upload to SharePoint",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "graph_error",
      status: res.status,
      message: `graph ${res.status}`,
    };
  }
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    webUrl?: string;
    eTag?: string;
  };
  return {
    ok: true,
    itemId: body.id ?? "",
    webUrl: body.webUrl ?? null,
    etag: body.eTag ?? null,
    byteCount: bytes.byteLength,
  };
}

/* ------------------------------------------------------------------ */
/* Audit persistence                                                   */
/* ------------------------------------------------------------------ */

function rowToAudit(row: AuditRow): WeeklyDocUploadAuditRecord {
  return {
    id: row.id,
    weekStart: row.week_start,
    status: row.status,
    reasonCode: row.reason_code,
    filename: row.filename,
    byteCount: row.byte_count,
    parentDriveId: row.parent_drive_id,
    parentItemId: row.parent_item_id,
    webUrl: row.web_url,
    etag: row.etag,
    attemptedBy: row.attempted_by,
    errorMessage: row.error_message,
    attemptedAt: row.attempted_at,
  };
}

export async function recordWeeklyDocUpload(
  args: WeeklyDocUploadAuditInput,
): Promise<WeeklyDocUploadAuditRecord | null> {
  try {
    const result = await writeQuery<AuditRow>(
      `INSERT INTO instinct_principle_weekly_doc_uploads
         (week_start, status, reason_code, filename, byte_count,
          parent_drive_id, parent_item_id, web_url, etag,
          attempted_by, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, week_start, status, reason_code, filename, byte_count,
                 parent_drive_id, parent_item_id, web_url, etag,
                 attempted_by, error_message, attempted_at`,
      [
        args.weekStart,
        args.status,
        args.reasonCode ?? null,
        args.filename ?? null,
        args.byteCount ?? null,
        args.parentDriveId ?? null,
        args.parentItemId ?? null,
        args.webUrl ?? null,
        args.etag ?? null,
        args.attemptedBy ?? null,
        args.errorMessage ?? null,
      ],
    );
    return result.rows[0] ? rowToAudit(result.rows[0]) : null;
  } catch (err) {
    /* Shadow / no-DB envs: surface as null so the cron continues to
       function; the in-memory event log + analytics still record the
       outcome. WriteQueryError is the typed escape hatch from db.ts. */
    if (err instanceof WriteQueryError) return null;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Top-level orchestrator — what the cron calls                        */
/* ------------------------------------------------------------------ */

export const WEEKLY_REPORT_DOC_FILENAME =
  "Wolfpack — Last Week vs Operating Principles.docx";

export interface WriteWeeklyReportToSharePointArgs {
  report: Pick<
    WeeklyReportRecord,
    "weekStart" | "weekEnd" | "markdownBody" | "observationCount" | "principleCount"
  >;
  config: { docUrl: string | null; ownerUserId: string | null };
}

export type WriteWeeklyReportToSharePointResult =
  | {
      ok: true;
      audit: WeeklyDocUploadAuditRecord | null;
      itemId: string;
      webUrl: string | null;
      etag: string | null;
      byteCount: number;
    }
  | {
      ok: false;
      status: WeeklyDocUploadOutcome; // 'skipped' | 'failed'
      reasonCode: string;
      message: string;
      audit: WeeklyDocUploadAuditRecord | null;
    };

/**
 * The cron's single entry point. Resolves config → builds .docx →
 * resolves parent → PUTs → records audit → returns a typed result so
 * the cron can emit the right analytics event without re-deriving the
 * outcome.
 */
export async function writeWeeklyReportToSharePoint(
  args: WriteWeeklyReportToSharePointArgs,
): Promise<WriteWeeklyReportToSharePointResult> {
  const { report, config } = args;
  const weekStart = report.weekStart;

  if (!config.docUrl || !config.ownerUserId) {
    const reasonCode = !config.docUrl ? "no_doc_url" : "no_owner";
    const audit = await recordWeeklyDocUpload({
      weekStart,
      status: "skipped",
      reasonCode,
      filename: WEEKLY_REPORT_DOC_FILENAME,
      attemptedBy: config.ownerUserId,
    });
    return {
      ok: false,
      status: "skipped",
      reasonCode,
      message: `principles config missing: ${reasonCode}`,
      audit,
    };
  }

  const userId = config.ownerUserId;
  const filename = WEEKLY_REPORT_DOC_FILENAME;

  let bytes: Buffer;
  try {
    bytes = await buildWeeklyReportDocx(report.markdownBody);
  } catch (err) {
    const audit = await recordWeeklyDocUpload({
      weekStart,
      status: "failed",
      reasonCode: "docx_build_error",
      filename,
      attemptedBy: userId,
      errorMessage: (err as Error).message,
    });
    return {
      ok: false,
      status: "failed",
      reasonCode: "docx_build_error",
      message: (err as Error).message,
      audit,
    };
  }

  const parentRes = await resolveSharePointParent(userId, config.docUrl);
  if (!parentRes.ok) {
    const reasonCode = parentRes.code;
    const status: WeeklyDocUploadOutcome =
      reasonCode === "scope_missing" || reasonCode === "not_connected"
        ? "skipped"
        : "failed";
    const audit = await recordWeeklyDocUpload({
      weekStart,
      status,
      reasonCode,
      filename,
      byteCount: bytes.byteLength,
      attemptedBy: userId,
      errorMessage: parentRes.message,
    });
    return {
      ok: false,
      status,
      reasonCode,
      message: parentRes.message,
      audit,
    };
  }

  const upload = await uploadWeeklyReportDocx({
    userId,
    parent: parentRes.parent,
    filename,
    bytes,
  });
  if (!upload.ok) {
    const reasonCode = upload.code;
    const status: WeeklyDocUploadOutcome =
      reasonCode === "scope_missing" ? "skipped" : "failed";
    const audit = await recordWeeklyDocUpload({
      weekStart,
      status,
      reasonCode,
      filename,
      byteCount: bytes.byteLength,
      parentDriveId: parentRes.parent.driveId,
      parentItemId: parentRes.parent.parentItemId,
      attemptedBy: userId,
      errorMessage: upload.message,
    });
    return {
      ok: false,
      status,
      reasonCode,
      message: upload.message,
      audit,
    };
  }

  const audit = await recordWeeklyDocUpload({
    weekStart,
    status: "uploaded",
    reasonCode: "ok",
    filename,
    byteCount: upload.byteCount,
    parentDriveId: parentRes.parent.driveId,
    parentItemId: parentRes.parent.parentItemId,
    webUrl: upload.webUrl,
    etag: upload.etag,
    attemptedBy: userId,
  });
  return {
    ok: true,
    audit,
    itemId: upload.itemId,
    webUrl: upload.webUrl,
    etag: upload.etag,
    byteCount: upload.byteCount,
  };
}
