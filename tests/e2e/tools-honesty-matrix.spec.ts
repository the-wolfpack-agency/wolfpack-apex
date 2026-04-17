/**
 * Tools — Vibium honesty matrix (end-to-end).
 *
 * Asserts that a tool run, triggered against the deployed URL, actually
 * produced the artifacts it claims. This is the "green CI != actually
 * worked" guardrail: we dispatch a real run, poll to completion, and
 * verify:
 *
 *   1. The status response includes `run_url` pointing at the real run
 *   2. `artifacts[]` is non-empty and each entry has size_bytes + sha256
 *   3. The artifacts' `kind` satisfies the tool's contract
 *   4. `result.status === "complete"` with the expected per-tool keys
 *
 * Disabled by default because every run burns GitHub Actions minutes.
 * Opt in with `TOOLS_HONESTY_MATRIX_LIVE=1` + SMOKE_TEST_EMAIL/PASSWORD
 * env vars in the environment; the rest of the verify suite stays cheap.
 *
 * Run:
 *   TOOLS_HONESTY_MATRIX_LIVE=1 \
 *     SMOKE_TEST_EMAIL=... SMOKE_TEST_PASSWORD=... \
 *     PROD_URL=https://wolfpack-instinct.vercel.app \
 *     npx playwright test tests/e2e/tools-honesty-matrix.spec.ts
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, signInIfPossible } from "./helpers/smoke-helpers";

const LIVE = process.env.TOOLS_HONESTY_MATRIX_LIVE === "1";
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 6 * 60_000; // workflows are budgeted to 10min; we wait up to 6

interface ArtifactEntry {
  name: string;
  kind: string;
  path: string;
  size_bytes: number;
  sha256: string;
}

interface StatusResponse {
  status: string;
  run_id?: number;
  run_url?: string;
  result?: { status?: string } & Record<string, unknown>;
  artifacts?: ArtifactEntry[];
  error?: string;
}

test.describe("tools honesty matrix — live dispatch + artifact assertion", () => {
  test.skip(!LIVE, "live matrix disabled — set TOOLS_HONESTY_MATRIX_LIVE=1 to enable");

  const CONTRACTS: Array<{
    tool: "pdf-report" | "demo-deck" | "visual-diff" | "accessibility";
    requiredKinds: string[];
    requiredResultKeys: string[];
  }> = [
    { tool: "pdf-report",    requiredKinds: ["pdf"],            requiredResultKeys: ["file", "file_size_bytes"] },
    { tool: "demo-deck",     requiredKinds: ["screenshot"],     requiredResultKeys: ["total_pages", "pages"] },
    { tool: "visual-diff",   requiredKinds: ["screenshot"],     requiredResultKeys: ["pages_checked", "diffs"] },
    { tool: "accessibility", requiredKinds: ["rendered_html"],  requiredResultKeys: ["pages", "total_issues"] },
  ];

  for (const contract of CONTRACTS) {
    test(`${contract.tool} — dispatched run produces ${contract.requiredKinds.join("+")} artifact(s)`, async ({
      page,
      request,
    }) => {
      const target = resolveSmokeTarget();
      expect(target.isProduction, "PROD_URL must be set for the live matrix").toBe(true);

      const signedIn = await signInIfPossible(page, target);
      expect(signedIn, "SMOKE_TEST_EMAIL/PASSWORD required").toBe(true);

      // Pull the access token the page stored on login so the request
      // client can hit the authenticated API directly.
      const token = await page.evaluate(() => localStorage.getItem("instinct_access_token"));
      expect(token, "access token missing after signInIfPossible").toBeTruthy();

      const triggerRes = await request.post(`${target.baseUrl}/api/tools/${contract.tool}`, {
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        data: {},
      });
      expect(triggerRes.status(), `trigger /api/tools/${contract.tool}`).toBe(200);
      const trigger = await triggerRes.json();
      expect(trigger.status).toBe("queued");
      expect(trigger.run_id).toBeGreaterThan(0);

      const runId = trigger.run_id as number;
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let status: StatusResponse | undefined;
      while (Date.now() < deadline) {
        const res = await request.get(
          `${target.baseUrl}/api/tools/status?run_id=${runId}&tool=${contract.tool}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        expect(res.status()).toBe(200);
        status = (await res.json()) as StatusResponse;
        if (status.status === "completed" || status.status === "failed") break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      expect(status, "polling timed out before run terminated").toBeDefined();
      expect(status!.status, `run failed: ${JSON.stringify(status)}`).toBe("completed");
      expect(status!.run_url).toMatch(/^https:\/\/github\.com\/.+\/actions\/runs\/\d+$/);

      expect(status!.result).toBeDefined();
      expect(status!.result!.status).toBe("complete");
      for (const key of contract.requiredResultKeys) {
        expect(status!.result, `missing required result key ${key}`).toHaveProperty(key);
      }

      expect(status!.artifacts, "artifacts manifest missing").toBeDefined();
      expect(status!.artifacts!.length).toBeGreaterThan(0);
      for (const a of status!.artifacts!) {
        expect(a.sha256, `artifact ${a.name} missing sha256`).toMatch(/^[a-f0-9]{64}$/);
        expect(a.size_bytes, `artifact ${a.name} has zero bytes`).toBeGreaterThan(0);
      }

      const kindsSeen = new Set(status!.artifacts!.map((a) => a.kind));
      for (const kind of contract.requiredKinds) {
        expect(kindsSeen.has(kind), `expected artifact of kind=${kind}, saw ${[...kindsSeen]}`).toBe(true);
      }
    });
  }
});
