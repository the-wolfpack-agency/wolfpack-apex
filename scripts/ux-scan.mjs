#!/usr/bin/env node
/**
 * scripts/ux-scan.mjs - LIVE tier-1 READ-ONLY browser UX scan CLI.
 *
 * Thin orchestration only. ALL logic lives in the unit-tested TypeScript core
 * (src/lib/platform-scan/browser/capture.ts + runner.ts); this script's whole job
 * is to:
 *   1. spin up a REAL chromium browser (Playwright, dev/CI dependency),
 *   2. adapt each real Playwright Page to the minimal `ScanPage` shape the core
 *      expects (it is structurally compatible already, so this is near-identity),
 *   3. run `runUxScan` with an `ingest` sink that POSTs the RAW observations to
 *      apex's ingest endpoint, which classifies them server-side.
 *
 * The core imports NO Playwright and NO fetch, so it stays pure and testable; the
 * concrete browser + network live here at the edge.
 *
 * Safety: runUxScan installs the read-only network floor on every page, so only
 * GET/HEAD ever reach the target. A scan can never mutate a client's system.
 *
 * Config (argv overrides env):
 *   --base / BASE_URL            target base URL (required)
 *   --platform / TARGET_PLATFORM platform label for the scan record (default "self")
 *   --ingest / INGEST_URL        ingest endpoint (default `${BASE}/api/admin/platform-scans/ingest`)
 *   --secret / CRON_SECRET       Bearer secret for the ingest endpoint (required to POST)
 *   --routes / ROUTES            comma list of `path|journey` (default a small set)
 *
 * Usage:
 *   node scripts/ux-scan.mjs --base https://target.example.com --secret $CRON_SECRET \
 *     --routes "/|landing,/login|login,/dashboard|dashboard"
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Register ts-node so we can import the TS core directly (keeps the runner/capture
// logic single-sourced; no duplicated JS copy to drift). CJS transpile-only is the
// reliable path under this repo's bundler moduleResolution.
require("ts-node").register({
  transpileOnly: true,
  compilerOptions: { module: "commonjs", moduleResolution: "node", esModuleInterop: true },
});

const { runUxScan } = require(join(ROOT, "src/lib/platform-scan/browser/runner.ts"));
const { chromium } = require("@playwright/test");

function argOf(flag, envKey, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (envKey && process.env[envKey]) return process.env[envKey];
  return fallback;
}

function parseRoutes(spec) {
  // "/|landing,/dashboard|dashboard" -> [{ path, journey }]
  return spec
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [path, journey] = pair.split("|");
      return { path: path.trim(), journey: (journey || path).trim() };
    });
}

async function main() {
  const baseUrl = argOf("--base", "BASE_URL", "");
  if (!baseUrl) {
    console.error("[ux-scan] --base / BASE_URL is required");
    process.exit(2);
  }
  const platform = argOf("--platform", "TARGET_PLATFORM", "self");
  const ingestUrl = argOf(
    "--ingest",
    "INGEST_URL",
    `${baseUrl.replace(/\/$/, "")}/api/admin/platform-scans/ingest`,
  );
  const secret = argOf("--secret", "CRON_SECRET", "");
  const routes = parseRoutes(
    argOf(
      "--routes",
      "ROUTES",
      "/|landing,/login|login,/dashboard|dashboard,/settings|settings",
    ),
  );

  console.log(`[ux-scan] target=${baseUrl} platform=${platform} routes=${routes.length}`);

  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Adapt the Playwright context to the minimal ScanBrowser the core expects.
  // A real Playwright Page already satisfies ScanPage structurally (route/on/
  // addInitScript/evaluate), and we adapt goto so it resolves to a { status() }.
  const scanBrowser = {
    async newPage() {
      const page = await context.newPage();
      const realGoto = page.goto.bind(page);
      // goto in the core takes only a URL and expects a result with status();
      // wrap to add a sane waitUntil + a settle, returning the response (which
      // already exposes status()).
      page.goto = async (url) => {
        const resp = await realGoto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForLoadState("networkidle").catch(() => {});
        return resp;
      };
      return page;
    },
  };

  async function ingest(observations) {
    console.log(`[ux-scan] captured ${observations.length} observation(s)`);
    if (!secret) {
      console.warn("[ux-scan] no --secret/CRON_SECRET; skipping POST (dry run)");
      return;
    }
    const res = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ platform, baseUrl, observations }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[ux-scan] ingest failed ${res.status}: ${text}`);
      process.exitCode = 1;
      return;
    }
    console.log(`[ux-scan] ingest ok: ${text}`);
  }

  try {
    await runUxScan(
      {
        baseUrl,
        routes,
        ingest,
        onRouteError: ({ path, error }) =>
          console.warn(`[ux-scan] route ${path} failed: ${error.message}`),
      },
      scanBrowser,
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("[ux-scan]", err);
  process.exit(1);
});
