#!/usr/bin/env node
/**
 * scripts/journey-scan.mjs - LIVE tier-2 DETERMINISTIC scripted-journey scan CLI.
 *
 * Thin orchestration only. ALL journey logic lives in the unit-tested TypeScript
 * core (src/lib/platform-scan/browser/journey-runner.ts); this script's whole job
 * is to provide the TWO concrete deps the pure runner needs plus a real browser:
 *
 *   1. authorize(action)  -> POST ${BASE}/api/admin/platform-scans/browser/authorize
 *                            (Bearer CRON_SECRET). This is gate-as-a-service: every
 *                            step is authorized by the OGIAM gate BEFORE it runs, so
 *                            the runner can never act outside a recorded gate
 *                            decision. The route returns { allowed, reason }.
 *   2. executeStep(step)  -> perform the step on a REAL Playwright page
 *                            (navigate / click / fill / press / hover; "expect" =
 *                            check a selector is visible OR the URL matches).
 *
 * It runs each operator-defined ScriptedJourney via runScriptedJourney, collects
 * the JourneyTrace[], and POSTs them to ${BASE}/api/admin/platform-scans/ingest as
 * { platform, baseUrl, traces } (Bearer CRON_SECRET). apex runs classifyJourney
 * SERVER-SIDE and the findings flow through the SAME recordScan pipeline as every
 * other scan source - no data lost.
 *
 * Safety: the read-only network floor (installReadOnlyFloor, reused from the core)
 * is installed on every page so only GET/HEAD ever leaves the browser - UNLESS a
 * journey is explicitly `mutatingAuthorized: true` (it has an active ui_probe scope
 * and is allowed to submit). Even then, the GATE is the policy floor: a mutating
 * step that the gate denies is never executed by the runner.
 *
 * Config (argv overrides env):
 *   --base / BASE_URL        target base URL (required)
 *   --platform / TARGET_PLATFORM platform label (default "self"); a journey may
 *                            override per-journey via its own `platform`.
 *   --journeys / JOURNEYS_FILE path to a JSON file: ScriptedJourney[] (each may add
 *                            `mutatingAuthorized: true`). Required.
 *   --ingest / INGEST_URL    ingest endpoint (default `${BASE}/api/.../ingest`)
 *   --authorize / AUTHORIZE_URL gate endpoint (default `${BASE}/api/.../browser/authorize`)
 *   --secret / CRON_SECRET   Bearer secret for both endpoints (required to POST)
 *
 * Usage:
 *   node scripts/journey-scan.mjs --base https://target.example.com \
 *     --secret $CRON_SECRET --journeys ./journeys.json
 *
 * journeys.json shape (array of ScriptedJourney):
 *   [{ "platform": "self", "route": "/", "journey": "pricing",
 *      "goal": "reach pricing", "expectedSteps": 3,
 *      "steps": [
 *        { "kind": "navigate", "targetUrl": "/" },
 *        { "kind": "click", "selector": "a[href='/pricing']", "mutating": true },
 *        { "kind": "expect", "description": "pricing url", "value": "/pricing" }
 *      ] }]
 */

import { createRequire } from "node:module";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Register ts-node so we import the SAME TS core the unit tests cover (no JS copy
// to drift). CJS transpile-only mirrors scripts/ux-scan.mjs exactly.
require("ts-node").register({
  transpileOnly: true,
  compilerOptions: { module: "commonjs", moduleResolution: "node", esModuleInterop: true },
});

const { runScriptedJourney } = require(
  join(ROOT, "src/lib/platform-scan/browser/journey-runner.ts"),
);
const { installReadOnlyFloor } = require(
  join(ROOT, "src/lib/platform-scan/browser/capture.ts"),
);
const { chromium } = require("@playwright/test");

function argOf(flag, envKey, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (envKey && process.env[envKey]) return process.env[envKey];
  return fallback;
}

/** Resolve a step's URL to an absolute one against the base (paths -> base+path). */
function absoluteUrl(baseUrl, target) {
  if (!target) return baseUrl;
  if (/^https?:\/\//i.test(target)) return target;
  return `${baseUrl.replace(/\/$/, "")}${target.startsWith("/") ? "" : "/"}${target}`;
}

/**
 * Build the gate-as-a-service authorize dep. POSTs the proposed BrowserAction to
 * the authorize route and returns { allowed, reason }. A query failure fails
 * closed (allowed:false) - the runner then records a gate dead-end and stops,
 * which is the safe outcome (never execute an un-authorized step).
 */
function makeAuthorize({ authorizeUrl, secret }) {
  return async (action) => {
    try {
      const res = await fetch(authorizeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          platform: action.platform,
          action: {
            kind: action.kind,
            targetUrl: action.targetUrl,
            selector: action.selector,
            mutating: action.mutating,
          },
        }),
      });
      if (!res.ok) return { allowed: false, reason: `authorize_http_${res.status}` };
      const json = await res.json();
      return { allowed: json.allowed === true, reason: json.reason };
    } catch (e) {
      return { allowed: false, reason: `authorize_error_${e.message}` };
    }
  };
}

/**
 * Build the executeStep dep bound to a live Playwright page + the journey's base.
 * Returns true on success, false on a normal failure (the runner records ok:false
 * and continues). Throwing aborts the journey (the runner catches it and stops).
 */
function makeExecuteStep({ page, baseUrl, route }) {
  return async (step) => {
    const timeout = 15000;
    switch (step.kind) {
      case "navigate": {
        const url = absoluteUrl(baseUrl, step.targetUrl ?? route);
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        await page.waitForLoadState("networkidle").catch(() => {});
        return !!resp && resp.status() < 400;
      }
      case "observe": {
        // Read-only: confirm the selector exists in the DOM (or the body, if none).
        if (!step.selector) return true;
        return (await page.locator(step.selector).count()) > 0;
      }
      case "hover": {
        if (!step.selector) return false;
        await page.locator(step.selector).first().hover({ timeout });
        return true;
      }
      case "key": {
        // value carries the key to press (e.g. "Enter", "Tab").
        await page.keyboard.press(step.value ?? "Enter");
        return true;
      }
      case "click": {
        if (!step.selector) return false;
        await page.locator(step.selector).first().click({ timeout });
        await page.waitForLoadState("networkidle").catch(() => {});
        return true;
      }
      case "fill": {
        if (!step.selector) return false;
        await page.locator(step.selector).first().fill(step.value ?? "", { timeout });
        return true;
      }
      case "submit": {
        // Submit the form: click the step's selector (a submit button) if given,
        // else press Enter in the focused field.
        if (step.selector) {
          await page.locator(step.selector).first().click({ timeout });
        } else {
          await page.keyboard.press("Enter");
        }
        await page.waitForLoadState("networkidle").catch(() => {});
        return true;
      }
      case "expect": {
        // Assertion: a selector is visible AND/OR the URL contains step.value.
        let ok = true;
        if (step.selector) {
          ok =
            ok &&
            (await page
              .locator(step.selector)
              .first()
              .isVisible({ timeout })
              .catch(() => false));
        }
        if (step.value) {
          ok = ok && page.url().includes(step.value);
        }
        return ok;
      }
      default:
        return false;
    }
  };
}

async function main() {
  const baseUrl = argOf("--base", "BASE_URL", "");
  if (!baseUrl) {
    console.error("[journey-scan] --base / BASE_URL is required");
    process.exit(2);
  }
  const defaultPlatform = argOf("--platform", "TARGET_PLATFORM", "self");
  const journeysFile = argOf("--journeys", "JOURNEYS_FILE", "");
  if (!journeysFile) {
    console.error("[journey-scan] --journeys / JOURNEYS_FILE (path to a JSON array) is required");
    process.exit(2);
  }
  const secret = argOf("--secret", "CRON_SECRET", "");
  const ingestUrl = argOf(
    "--ingest",
    "INGEST_URL",
    `${baseUrl.replace(/\/$/, "")}/api/admin/platform-scans/ingest`,
  );
  const authorizeUrl = argOf(
    "--authorize",
    "AUTHORIZE_URL",
    `${baseUrl.replace(/\/$/, "")}/api/admin/platform-scans/browser/authorize`,
  );

  const filePath = isAbsolute(journeysFile) ? journeysFile : resolve(process.cwd(), journeysFile);
  let journeys;
  try {
    journeys = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`[journey-scan] could not read journeys file ${filePath}: ${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(journeys) || journeys.length === 0) {
    console.error("[journey-scan] journeys file must be a non-empty JSON array of ScriptedJourney");
    process.exit(2);
  }

  console.log(
    `[journey-scan] target=${baseUrl} platform=${defaultPlatform} journeys=${journeys.length}`,
  );

  const authorize = makeAuthorize({ authorizeUrl, secret });
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const traces = [];

  try {
    for (const j of journeys) {
      const journey = { platform: defaultPlatform, ...j };
      const page = await context.newPage();
      // Read-only floor by default; only a journey explicitly authorized to mutate
      // (it holds an active ui_probe scope) skips it. The GATE is still the policy
      // floor either way - a denied mutating step is never executed.
      if (!journey.mutatingAuthorized) {
        await installReadOnlyFloor(page);
      }
      try {
        const trace = await runScriptedJourney(journey, {
          authorize,
          executeStep: makeExecuteStep({ page, baseUrl, route: journey.route }),
        });
        traces.push(trace);
        console.log(
          `[journey-scan] ${journey.journey}: completed=${trace.completed} steps=${trace.steps.length}`,
        );
      } catch (e) {
        console.warn(`[journey-scan] journey ${journey.journey} failed: ${e.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (!secret) {
    console.warn("[journey-scan] no --secret/CRON_SECRET; skipping ingest POST (dry run)");
    console.log(JSON.stringify({ platform: defaultPlatform, baseUrl, traces }, null, 2));
    return;
  }

  const res = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ platform: defaultPlatform, baseUrl, traces }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[journey-scan] ingest failed ${res.status}: ${text}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[journey-scan] ingest ok: ${text}`);
}

main().catch((err) => {
  console.error("[journey-scan]", err);
  process.exit(1);
});
