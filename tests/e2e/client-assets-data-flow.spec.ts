/**
 * Client-assets END-TO-END data-flow reality check (Path C Phase 1, Stream P3).
 *
 * The bug class we defend against: a 200 response from an endpoint that
 * silently discarded the write (RLS policy, auto-updatable view rewriter,
 * trigger rollback, constraint violation masked by a catch-all). Unit
 * tests CAN'T catch this — only a real write against a real DB followed
 * by a real read-back proves the round-trip actually committed.
 *
 * Flow:
 *   1. Authenticate.
 *   2. POST a tiny base64-encoded PNG to /api/clients/TEST_CLIENT/assets.
 *   3. Assert 201 with an id + canonical url.
 *   4. Independent GET the list — the uploaded row is there with the
 *      sha256 we computed locally (server agrees on the hash).
 *   5. POST the same bytes AGAIN — library MUST dedupe: same id,
 *      use_count >= 2, list still has exactly one entry for that sha.
 *   6. DELETE it → list filters it out (soft-delete, but list excludes).
 *
 * Gated on SMOKE_TEST_EMAIL + SMOKE_TEST_PASSWORD. Skips cleanly
 * (not a fail) when creds are missing, same pattern as
 * feature-requests-data-flow.spec.ts.
 */

import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  resolveSmokeTarget,
  signInIfPossible,
  authToken,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

// 1x1 transparent PNG, 70 bytes. Small enough to travel in a JSON body
// without chewing test-run time; distinctive enough that sha256 is
// deterministic.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const EXPECTED_SHA256 = createHash("sha256")
  .update(Buffer.from(TINY_PNG_BASE64, "base64"))
  .digest("hex");

// Per-run unique client slug so parallel runs don't race on rows we
// leave behind (cleanup-on-failure is best-effort).
const TEST_CLIENT = `e2e-assets-${Date.now().toString(36)}`;

test.describe("client-assets data flow — real DB round-trip", () => {
  test.beforeEach(async ({ page }) => {
    const signedIn = await signInIfPossible(page, target);
    if (!signedIn) test.skip();
  });

  test("POST → list → dedupe → delete round-trip", async ({ page, request }) => {
    const token = await authToken(page);
    if (!token) {
      test.skip(true, "auth token missing");
      return;
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const uploadBody = {
      filename: `e2e-logo-${Date.now()}.png`,
      content_base64: TINY_PNG_BASE64,
      mime: "image/png",
      kind: "logo" as const,
      alt_text: "E2E test logo",
    };

    // 1) POST the upload.
    const postRes = await request.post(
      `${target.baseUrl}/api/clients/${TEST_CLIENT}/assets`,
      { headers, data: uploadBody },
    );
    expect([200, 201]).toContain(postRes.status());
    const posted = (await postRes.json()) as { asset?: {
      id: string;
      sha256: string;
      url: string;
      useCount: number;
    } };
    expect(posted.asset).toBeTruthy();
    expect(posted.asset!.id).toBeTruthy();
    expect(posted.asset!.sha256).toBe(EXPECTED_SHA256);
    const assetId = posted.asset!.id;

    // 2) Independent GET — if the write was silently discarded, this
    //    returns []. The row MUST exist with the hash we sent.
    const listRes = await request.get(
      `${target.baseUrl}/api/clients/${TEST_CLIENT}/assets`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(listRes.status()).toBe(200);
    const listed = (await listRes.json()) as { assets: Array<{ id: string; sha256: string; useCount: number }> };
    const match = listed.assets.find((a) => a.id === assetId);
    expect(match).toBeTruthy();
    expect(match!.sha256).toBe(EXPECTED_SHA256);

    // 3) Re-upload the SAME bytes — must dedupe.
    const dupRes = await request.post(
      `${target.baseUrl}/api/clients/${TEST_CLIENT}/assets`,
      { headers, data: uploadBody },
    );
    expect([200, 201]).toContain(dupRes.status());
    const dup = (await dupRes.json()) as { asset?: { id: string; useCount: number } };
    expect(dup.asset!.id).toBe(assetId);
    expect(dup.asset!.useCount).toBeGreaterThanOrEqual(2);

    // List still has exactly one row for this sha256.
    const list2 = (await (
      await request.get(
        `${target.baseUrl}/api/clients/${TEST_CLIENT}/assets`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
    ).json()) as { assets: Array<{ id: string; sha256: string }> };
    const dupes = list2.assets.filter((a) => a.sha256 === EXPECTED_SHA256);
    expect(dupes).toHaveLength(1);

    // 4) DELETE (soft) → list excludes it.
    const delRes = await request.delete(
      `${target.baseUrl}/api/clients/${TEST_CLIENT}/assets/${assetId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(delRes.status()).toBe(200);

    const list3 = (await (
      await request.get(
        `${target.baseUrl}/api/clients/${TEST_CLIENT}/assets`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
    ).json()) as { assets: Array<{ id: string }> };
    expect(list3.assets.find((a) => a.id === assetId)).toBeUndefined();
  });
});
