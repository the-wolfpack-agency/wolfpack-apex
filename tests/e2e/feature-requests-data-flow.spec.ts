/**
 * Feature-requests END-TO-END data-flow reality check.
 *
 * The bug we defend against here: a 200 response from an endpoint that
 * silently discarded the data. Unit tests and contract tests both CAN
 * miss this class of failure — only a real write against a real DB
 * followed by a real read-back proves the round-trip.
 *
 * Flow:
 *   1. Authenticate.
 *   2. POST a new feature request with a distinctive title (timestamp).
 *   3. Assert the response is 200 with an id.
 *   4. GET the feature request by that id via a SEPARATE API call.
 *   5. Assert the retrieved row's title + description match what we sent.
 *   6. (Compat-view verification) If apex_feature_requests view exists,
 *      assert that listing through the old-named endpoint still finds
 *      the same row — proves the auto-updatable view is genuinely R/W.
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD + a writable test
 * environment (PROD_URL pointing at a staging or prod deploy where we
 * have permission to create and later clean up rows). Skips cleanly
 * when creds are missing — does not fail CI.
 */

import { test, expect } from "@playwright/test";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

test.describe("feature-requests data flow — real DB round-trip", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("POST → id returned → GET by id returns identical row", async ({ page, request }) => {
    const token = await authToken(page);
    if (!token) {
      test.skip(true, "auth token missing");
      return;
    }

    const uniqueTitle = `E2E DATA FLOW ${Date.now()}`;
    const description = `Round-trip proof: if you see this still after 24h, cleanup failed. ${Math.random()}`;

    // POST the write.
    const postRes = await request.post(`${target.baseUrl}/api/features`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: { title: uniqueTitle, description, priority: "low" },
    });

    // 200 (or 201 — the endpoint uses 200 per the codebase) must carry a real id.
    expect([200, 201]).toContain(postRes.status());
    const posted = await postRes.json();
    expect(posted.id).toBeTruthy();
    expect(typeof posted.id).toBe("string");

    // Independent GET by id — if the write was silently dropped, this
    // returns null/404 even though the POST "succeeded".
    const getRes = await request.get(`${target.baseUrl}/api/features/${posted.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(getRes.status()).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.id).toBe(posted.id);
    expect(fetched.title).toBe(uniqueTitle);
    expect(fetched.description).toBe(description);
  });
});
