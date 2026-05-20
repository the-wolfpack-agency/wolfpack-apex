/**
 * Brain upload — reality check against the deployed URL.
 *
 * The test that would have caught the xlsx silent-skip regression on
 * 2026-05-20: an xlsx file gets POSTed to /api/brain/upload, and the
 * route either accepts it (status=indexed, chunk_count>0,
 * extracted_chars>0) or rejects with a stable reason — never the
 * silent "201 with status=skipped" outcome the widget renders as a
 * red ✗ chip but the user reads as "WHY?".
 *
 * For every advertised UPLOAD_FILTER_ALLOWED_MIME_TYPES entry that
 * isn't on the explicit EXEMPT list (DOCX needs a real zip fixture,
 * PDF skeleton is too degenerate for unpdf), this spec generates a
 * minimal real-bytes sample at runtime, POSTs it, and asserts the
 * response is the indexed-and-searchable shape — not skipped, not
 * failed, not "201 with no chunks."
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD. Targets PROD_URL
 * when set so the gate runs against actual Vercel state (the unit
 * test verifies the extractor; THIS test verifies the deployed
 * pipeline end-to-end).
 */
import { test, expect } from "@playwright/test";
import * as XLSX from "xlsx";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SPEC_NAME = "brain-upload-reality-check";

interface SampleCase {
  mime: string;
  filename: string;
  body: Buffer;
}

/* Mirror of the unit-test sample factory, with one important difference:
   we emit *real* bytes for every MIME the deployed pipeline must accept
   end-to-end. If a MIME is added to the upload-filter allowlist, append
   a case here OR add it to EXEMPT_FROM_E2E with a one-line reason. */
function buildCases(): SampleCase[] {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["Code", "Description"],
    ["WOLFPACK-AUTO", "Dealer DOS engineering"],
    ["CLIENT-ACME", "Acme retainer billable"],
    ["INTERNAL-OPS", "Internal operations non-billable"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Job Codes");
  const xlsxBytes = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return [
    {
      mime: "text/plain",
      filename: "brain-e2e-sample.txt",
      body: Buffer.from(
        "Brain end-to-end probe. The deployed upload pipeline must accept this plain text file, extract its words, chunk them, and return status indexed with at least one chunk. Otherwise the user sees a red X with no reason chip and rightly loses trust.",
      ),
    },
    {
      mime: "text/markdown",
      filename: "brain-e2e-sample.md",
      body: Buffer.from(
        "# Brain Probe\n\nThis markdown file exists to verify the deployed extractor produces non-empty text for markdown uploads. If this row comes back as skipped, the markdown branch of `extract()` is broken in production even though it passes locally — exactly the class of regression the xlsx silent-skip belonged to.",
      ),
    },
    {
      mime: "text/csv",
      filename: "brain-e2e-sample.csv",
      body: Buffer.from(
        "Code,Description,BillingRate\nWOLFPACK-AUTO,Dealer DOS engineering,150\nCLIENT-ACME,Acme retainer billable,200\nINTERNAL-OPS,Internal operations non-billable,0\n",
      ),
    },
    {
      mime: "application/json",
      filename: "brain-e2e-sample.json",
      body: Buffer.from(
        JSON.stringify(
          {
            jobCodes: ["WOLFPACK-AUTO", "CLIENT-ACME", "INTERNAL-OPS"],
            description: "Brain end-to-end probe JSON document. Long enough to clear the 50-char minimum content gate and the 10-token threshold.",
          },
          null,
          2,
        ),
      ),
    },
    {
      mime: "text/html",
      filename: "brain-e2e-sample.html",
      body: Buffer.from(
        "<html><body><h1>Brain Probe</h1><p>This HTML document is here so the deployed pipeline proves it can parse and extract a basic html block end-to-end. Otherwise the user reads a red X with no chip and rightly loses trust in the widget.</p></body></html>",
      ),
    },
    {
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "brain-e2e-job-codes.xlsx",
      body: xlsxBytes,
    },
  ];
}

/* These MIMEs need a real fixture file too large to generate inline
   (DOCX requires a real Office-shaped zip; PDF requires a real PDF, not
   the degenerate skeleton the unit test uses since unpdf refuses it).
   Their extractor branches are covered by the existing unit tests; the
   E2E coverage gap is documented here so adding to this list is visible
   in code review. */
const EXEMPT_FROM_E2E = new Set<string>([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/pdf",
  "application/vnd.ms-excel", // legacy .xls — same extractor as .xlsx; covered by xlsx case
]);

test.describe("brain upload — deployed pipeline reality check", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping brain upload reality check",
  );

  test("every advertised MIME survives the deployed upload pipeline as indexed", async ({
    page,
    request,
  }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let token = "";
    const failures: string[] = [];

    try {
      const signedIn = await signInIfPossible(page, target);
      expect(signedIn, "sign-in attempt must succeed").toBe(true);
      token = await authToken(page);
      expect(token, "authToken must be present after sign-in").not.toEqual("");

      for (const c of buildCases()) {
        if (EXEMPT_FROM_E2E.has(c.mime)) continue;

        /* multipart upload via Playwright's request context so we hit
           the deployed route exactly the way the widget does — same
           bearer header, same Content-Type, same body shape. */
        const res = await request.post(`${target.baseUrl}/api/brain/upload`, {
          headers: { authorization: `Bearer ${token}` },
          multipart: {
            file: {
              name: c.filename,
              mimeType: c.mime,
              buffer: c.body,
            },
          },
          timeout: 60_000,
        });

        const status = res.status();
        let body: Record<string, unknown> = {};
        try {
          body = (await res.json()) as Record<string, unknown>;
        } catch {
          body = { error: "non-json response", raw: await res.text() };
        }

        if (status === 201) {
          const docStatus = String(body.status ?? "");
          const chunkCount = Number(body.chunk_count ?? 0);
          const extractedChars = Number(body.extracted_chars ?? 0);

          /* "skipped" or "failed" coming back from a 201 IS the bug we
             are guarding against. The route returned 201 (technical
             success) but the document didn't make it into the index —
             the user reads this as a red X with no reason chip and the
             content is silently unsearchable. */
          if (docStatus !== "indexed" && docStatus !== "queued") {
            failures.push(
              `${c.mime} → 201 but status=${docStatus} (${JSON.stringify(body)})`,
            );
            continue;
          }
          if (chunkCount === 0) {
            failures.push(
              `${c.mime} → 201/${docStatus} but chunk_count=0 — extraction silently produced nothing`,
            );
            continue;
          }
          if (extractedChars === 0) {
            failures.push(
              `${c.mime} → 201/${docStatus} but extracted_chars=0 — no text reached the chunker`,
            );
            continue;
          }
        } else {
          failures.push(
            `${c.mime} → HTTP ${status} ${JSON.stringify(body)}`,
          );
        }
      }

      if (failures.length > 0) {
        result = "fail";
        throw new Error(
          `${failures.length} MIME(s) failed the deployed upload reality check:\n` +
            failures.map((f) => `  - ${f}`).join("\n"),
        );
      }
    } catch (err) {
      if (result !== "fail") result = "fail";
      throw err;
    } finally {
      await recordRealityCheckRun(request, target, token || null, {
        spec: SPEC_NAME,
        result,
        duration_ms: Date.now() - start,
        note: failures.length > 0 ? failures.join(" | ").slice(0, 500) : undefined,
      });
    }
  });
});
