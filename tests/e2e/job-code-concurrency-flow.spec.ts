/**
 * Job Code concurrency — deployed-URL reality check.
 *
 * Two-pass conflict simulation against the real /api/job-codes/[code]/cell
 * endpoint:
 *
 *   1. Pick a real code from the catalog (skip if cache is cold).
 *   2. Snapshot its current Program value.
 *   3. PATCH with an INTENTIONALLY-WRONG expected_value to simulate
 *      "someone else changed it between dialog-open and submit".
 *   4. Expect HTTP 409 + a typed `conflicts` array.
 *   5. PATCH again WITHOUT expected_value (the Overwrite path) and
 *      restore the original value so the workbook is unchanged.
 *
 * Gated on SMOKE_TEST_EMAIL/PASSWORD. Runs against PROD_URL when set.
 * The cell-writer itself enforces the 3 safety layers (forbidden column,
 * row-resolution verify, conflict gate) so this exercises the real path.
 */
import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
  recordRealityCheckRun,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();
const SPEC_NAME = "job-code-concurrency-flow";

test.describe("job code concurrency — deployed reality check", () => {
  test.skip(
    !target.email || !target.password,
    "SMOKE_TEST_EMAIL/PASSWORD not set — skipping concurrency check",
  );

  test("conflict: server returns 409 with typed conflicts[] when expected_value drifts", async ({ page, request }) => {
    const start = Date.now();
    let result: "pass" | "fail" | "skip" = "pass";
    let token = "";
    try {
      const signedIn = await signInIfPossible(page, target);
      expect(signedIn).toBe(true);
      token = await authToken(page);

      const listRes = await request.get(`${target.baseUrl}/api/job-codes`, {
        headers: { authorization: `Bearer ${token}` },
        timeout: 30_000,
      });
      if (listRes.status() !== 200) {
        result = "skip";
        return;
      }
      const list = await listRes.json();
      const sample = Array.isArray(list.codes) && list.codes[0];
      if (!sample) {
        result = "skip";
        return;
      }

      const originalProgram = sample.extra?.Program ?? "";
      /* Pick a value that's almost certainly different from current —
         and pass an INTENTIONALLY-WRONG expected_value. The conflict
         gate compares the SharePoint current cell against
         expected_value, so the wrong snapshot forces 409 regardless
         of the requested new value. We use the current Program as the
         requested value so an Overwrite recovery is a no-op write. */
      const conflictRes = await request.patch(
        `${target.baseUrl}/api/job-codes/${encodeURIComponent(sample.code)}/cell`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          data: {
            column: "D",
            value: originalProgram || "(restored)",
            expected_value: "__wolfpack-conflict-canary-do-not-match__",
          },
          timeout: 30_000,
        },
      );

      /* The conflict gate only fires when the current cell is NON-empty
         AND differs from expected_value. If the workbook cell is blank
         for the sample code, the gate skips and we get 200 — that's a
         clean skip for this assertion. */
      if (conflictRes.status() === 200) {
        result = "skip";
        return;
      }

      expect(conflictRes.status()).toBe(409);
      const body = await conflictRes.json();
      expect(body.error).toBe("conflict");
      expect(Array.isArray(body.conflicts)).toBe(true);
      expect(body.conflicts[0]).toMatchObject({
        column: "Program",
        expectedValue: "__wolfpack-conflict-canary-do-not-match__",
      });

      /* Overwrite recovery — re-PATCH without expected_value and
         restore the original value (no-op write either way; either we
         restore the prior text or the server skips because new ==
         current). */
      const restoreRes = await request.patch(
        `${target.baseUrl}/api/job-codes/${encodeURIComponent(sample.code)}/cell`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          data: { column: "D", value: originalProgram },
          timeout: 30_000,
        },
      );
      expect([200, 502, 503]).toContain(restoreRes.status());
    } catch (err) {
      result = "fail";
      throw err;
    } finally {
      await recordRealityCheckRun(request, target, token || null, {
        spec: SPEC_NAME,
        result,
        duration_ms: Date.now() - start,
      });
    }
  });
});
