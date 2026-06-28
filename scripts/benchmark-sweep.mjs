#!/usr/bin/env node
/**
 * scripts/benchmark-sweep.mjs - THE CONTINUOUS BENCHMARK SWEEP.
 *
 * The always-on learning loop that replaces slow manual testing. On each scheduled
 * tick it walks the CONSENT-TO-TEST corpus (BENCHMARK_CORPUS), scans every
 * consented target READ-ONLY, POSTs the raw observations to apex's ingest endpoint
 * (classified + recordScan'd server-side), then triggers server-side scoring so
 * recall / coverage signals are refreshed automatically.
 *
 * READ-ONLY ONLY. This sweep is, and must stay, read-only: every target is gated
 * through assertBenchmarkConsent(target, "read-only") and every page gets the
 * read-only network floor (installed by runUxScan), so only GET/HEAD ever leaves
 * the browser. ACTIVE RECALL - probing the planted vulns on a self-hosted labeled
 * target (e.g. Juice Shop) - is a SEPARATE, explicitly-authorized pentest run gated
 * by a pentest scope token; it is NOT this sweep and is never triggered here.
 *
 * Thin orchestrator. ALL real logic is reused from the unit-tested core:
 *   - corpus + consent gate: src/lib/platform-scan/benchmark/corpus.ts
 *   - target selection (read-only consent floor): benchmark/sweep-targets.ts
 *   - the scan loop (read-only floor + capture + per-route isolation + ingest):
 *     src/lib/platform-scan/browser/runner.ts (runUxScan), exactly like ux-scan.mjs.
 * This script only supplies the concrete chromium browser, the axe-core runner, and
 * the network sink, and it orchestrates: scan -> ingest (per target) -> trigger
 * scoring (once). No duplicated loop or safety logic.
 *
 * Per-target isolation: one target failing (scan crash, ingest non-2xx) is logged
 * and the sweep continues; the scoring trigger still fires for what did ingest.
 *
 * Config (env; argv overrides where given):
 *   --base / BASE_URL            apex base URL for ingest + scoring endpoints
 *                                (defaults to the production Instinct URL).
 *   --secret / CRON_SECRET       Bearer secret for ingest + benchmark endpoints
 *                                (required to POST; dry run without it).
 *   BENCHMARK_JUICE_SHOP_URL     OPTIONAL. If set, the self-hosted Juice Shop corpus
 *                                entry points at our infra; it is swept READ-ONLY
 *                                here like any other corpus target.
 *
 * Usage:
 *   node scripts/benchmark-sweep.mjs --base https://wolfpack-instinct.vercel.app \
 *     --secret $CRON_SECRET
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Register ts-node so we import the SAME TS core the unit tests cover (no JS copy to
// drift). CJS transpile-only mirrors scripts/ux-scan.mjs + journey-scan.mjs exactly.
require("ts-node").register({
  transpileOnly: true,
  compilerOptions: { module: "commonjs", moduleResolution: "node", esModuleInterop: true },
});

const { runUxScan } = require(
  join(ROOT, "src/lib/platform-scan/browser/runner.ts"),
);
const { selectReadOnlyTargets, DEFAULT_SWEEP_ROUTES } = require(
  join(ROOT, "src/lib/platform-scan/benchmark/sweep-targets.ts"),
);
const { chromium } = require("@playwright/test");

// Resolve the axe-core engine source once (a DEV/CI dependency). Injected into the
// scanned page below by runAxe, never into apex's bundle - identical to ux-scan.mjs.
const fs = require("node:fs");
const AXE_SOURCE = fs.readFileSync(require.resolve("axe-core"), "utf8");

/**
 * Build the runAxe dep for a Playwright page: inject the axe-core engine, run it,
 * and distill each violation (one entry per RULE). Best-effort: any failure returns
 * [] so a page is still captured. Identical to the ux-scan.mjs runner; the server
 * maps these to ScanFindings via the SAME classifier - the script ships only raw data.
 */
async function runAxe(page) {
  try {
    await page.addScriptTag({ content: AXE_SOURCE });
    return await page.evaluate(async () => {
      const r = await window.axe.run();
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        nodeCount: v.nodes.length,
      }));
    });
  } catch {
    return [];
  }
}

function argOf(flag, envKey, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (envKey && process.env[envKey]) return process.env[envKey];
  return fallback;
}

async function main() {
  const baseUrl = argOf(
    "--base",
    "BASE_URL",
    "https://wolfpack-instinct.vercel.app",
  ).replace(/\/$/, "");
  const secret = argOf("--secret", "CRON_SECRET", "");
  const ingestUrl = `${baseUrl}/api/admin/platform-scans/ingest`;
  const benchmarkUrl = `${baseUrl}/api/admin/platform-scans/benchmark`;

  // SAFETY FLOOR (reused from the core): only corpus targets that pass the
  // read-only consent gate are sweepable; anything that throws is skipped.
  const { selected, skipped } = selectReadOnlyTargets();
  for (const s of skipped) {
    console.warn(`[benchmark-sweep] skipped ${s.name}: ${s.reason} (consent refused)`);
  }
  console.log(
    `[benchmark-sweep] apex=${baseUrl} targets=${selected.length} (read-only)`,
  );
  if (selected.length === 0) {
    console.warn("[benchmark-sweep] no consented targets to sweep");
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Adapt the Playwright context to the minimal ScanBrowser the core expects - a
  // real Page already satisfies ScanPage structurally; we only wrap goto so it adds
  // a sane waitUntil + settle and returns the response (which exposes status()).
  // Identical adapter to ux-scan.mjs.
  const scanBrowser = {
    async newPage() {
      const page = await context.newPage();
      const realGoto = page.goto.bind(page);
      page.goto = async (url) => {
        const resp = await realGoto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForLoadState("networkidle").catch(() => {});
        return resp;
      };
      return page;
    },
  };

  /** Build the per-target ingest sink: POST raw observations to apex's ingest
   *  endpoint with { platform, baseUrl, observations } (Bearer CRON_SECRET). */
  function makeIngest(target) {
    return async (observations) => {
      console.log(
        `[benchmark-sweep] ${target.name}: captured ${observations.length} observation(s)`,
      );
      if (!secret) {
        console.warn("[benchmark-sweep] no --secret/CRON_SECRET; skipping POST (dry run)");
        return;
      }
      const res = await fetch(ingestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          platform: target.name,
          baseUrl: target.baseUrl,
          observations,
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        // Throw so the per-target try/catch below isolates this failure.
        throw new Error(`ingest failed ${res.status}: ${text}`);
      }
      console.log(`[benchmark-sweep] ${target.name}: ingest ok`);
    };
  }

  let scanned = 0;
  try {
    for (const target of selected) {
      // Per-target isolation: one target failing must not abort the sweep.
      try {
        // The scan loop is single-sourced in runUxScan: it installs the read-only
        // floor on every page, captures, isolates per-route failures, and ingests
        // once. We thread the axe runner + the per-target ingest sink. No
        // duplicated loop or safety logic - exactly the ux-scan.mjs pattern.
        await runUxScan(
          {
            baseUrl: target.baseUrl,
            routes: DEFAULT_SWEEP_ROUTES,
            ingest: makeIngest(target),
            runAxe,
            onRouteError: ({ path, error }) =>
              console.warn(
                `[benchmark-sweep] ${target.name} route ${path} failed: ${error.message}`,
              ),
          },
          scanBrowser,
        );
        scanned += 1;
      } catch (err) {
        console.error(`[benchmark-sweep] target ${target.name} failed: ${err.message}`);
        process.exitCode = 1;
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  // After all targets are scanned + ingested, trigger server-side scoring ONCE so
  // the recall / coverage / noise signals refresh against the freshly-ingested
  // findings. Read-only: this only reads stored findings + ground truth and writes
  // learning signals; it never probes a target.
  if (!secret) {
    console.warn("[benchmark-sweep] no --secret/CRON_SECRET; skipping scoring trigger (dry run)");
    return;
  }
  console.log(`[benchmark-sweep] scanned ${scanned}/${selected.length}; triggering scoring`);
  const res = await fetch(benchmarkUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({}),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[benchmark-sweep] scoring trigger failed ${res.status}: ${text}`);
    process.exitCode = 1;
    return;
  }
  // Log the returned recall / coverage / signal counts (best-effort: the body shape
  // is owned by the benchmark route built in parallel, so we surface what is there).
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    const { recall, coverage, signals, signalCount, coverageGaps, noiseCandidates } = parsed;
    console.log(
      "[benchmark-sweep] scoring ok:",
      JSON.stringify({ recall, coverage, signals, signalCount, coverageGaps, noiseCandidates }),
    );
  } else {
    console.log(`[benchmark-sweep] scoring ok: ${text}`);
  }
}

main().catch((err) => {
  console.error("[benchmark-sweep]", err);
  process.exit(1);
});
