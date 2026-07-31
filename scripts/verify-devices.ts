/**
 * scripts/verify-devices.ts
 *
 * Post-deploy multi-device UI verification CLI. Loads a target URL at each device
 * viewport (phone / tablet / desktop) and reports responsive/layout regressions —
 * horizontal overflow, elements spilling past the viewport edge, buried/zero-size
 * required content, CSP violations, failed in-page requests, console errors. This
 * is the safety net for the exact bug class that keeps reaching clients: a page
 * that renders fine on a 1440px desktop but is broken on a phone.
 *
 * Usage:
 *   npx tsx scripts/verify-devices.ts <url>
 *   PROD_URL=https://wolfpack-instinct.vercel.app npx tsx scripts/verify-devices.ts
 *   npx tsx scripts/verify-devices.ts <url> --stub ./stub.json
 *
 * The optional --stub JSON file lets an auth-gated page be verified WITHOUT real
 * credentials. Shape (all keys optional):
 *   {
 *     "session":       { "token": "...", "user": { "id": "u1" } },
 *     "stubApi":       { "/api/dashboard": { "widgets": [] } },
 *     "mustBeVisible": ["h1", "main"],
 *     "probeSelectors": [".sidebar", "header"]
 *   }
 *
 * Exit code is 1 when ANY high-severity finding is present on ANY device (or the
 * run degraded — chromium unavailable is NOT a silent pass), so CI can gate a
 * deploy on it. A clean run exits 0.
 */
import fs from "fs";
import path from "path";
import {
  runDeviceMatrix,
  DEVICES,
  type DeviceFinding,
  type RunDeviceMatrixOptions,
} from "../src/lib/platform-scan/browser/device-matrix";

interface StubFile {
  session?: RunDeviceMatrixOptions["session"];
  stubApi?: RunDeviceMatrixOptions["stubApi"];
  mustBeVisible?: string[];
  probeSelectors?: string[];
}

function parseArgs(argv: string[]): { url: string | undefined; stubPath: string | undefined } {
  let url: string | undefined;
  let stubPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stub") {
      stubPath = argv[++i];
    } else if (!a.startsWith("--") && !url) {
      url = a;
    }
  }
  url = url ?? process.env.PROD_URL;
  return { url, stubPath };
}

function loadStub(stubPath: string | undefined): StubFile {
  if (!stubPath) return {};
  const resolved = path.resolve(process.cwd(), stubPath);
  const raw = fs.readFileSync(resolved, "utf8");
  return JSON.parse(raw) as StubFile;
}

const SEVERITY_MARK: Record<string, string> = {
  high: "HIGH",
  medium: "med ",
  low: "low ",
  critical: "CRIT",
};

function printDevice(device: string, width: number, findings: DeviceFinding[]): void {
  const highs = findings.filter((f) => f.severity === "high" || f.severity === "critical").length;
  const status = highs > 0 ? "FAIL" : findings.length > 0 ? "warn" : "pass";
  console.log(`\n[${status}] ${device} (${width}px) — ${findings.length} finding(s)`);
  for (const f of findings) {
    console.log(`   ${SEVERITY_MARK[f.severity] ?? f.severity} ${f.title}`);
    console.log(`        ${f.detail}`);
  }
}

async function main(): Promise<void> {
  const { url, stubPath } = parseArgs(process.argv.slice(2));
  if (!url) {
    console.error("Usage: npx tsx scripts/verify-devices.ts <url> [--stub file.json]");
    console.error("   or set PROD_URL. No target URL provided.");
    process.exitCode = 2;
    return;
  }

  let stub: StubFile = {};
  try {
    stub = loadStub(stubPath);
  } catch (err) {
    console.error(`Failed to read --stub file "${stubPath}": ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  console.log(`[verify-devices] target=${url} devices=${DEVICES.map((d) => d.name).join(",")}`);

  const result = await runDeviceMatrix(url, {
    session: stub.session,
    stubApi: stub.stubApi,
    mustBeVisible: stub.mustBeVisible,
    probeSelectors: stub.probeSelectors,
  });

  if (result.degraded) {
    // A degraded run is NEVER a silent pass — we cannot claim the UI is verified.
    console.error(`\n[verify-devices] DEGRADED: ${result.degradedReason}`);
    console.error("Cannot verify the UI without a browser. Treating as a failure.");
    process.exitCode = 1;
    return;
  }

  const widthByName = Object.fromEntries(DEVICES.map((d) => [d.name, d.width]));
  for (const device of Object.keys(result.byDevice)) {
    printDevice(device, widthByName[device] ?? 0, result.byDevice[device]);
  }

  const highCount = result.allFindings.filter(
    (f) => f.severity === "high" || f.severity === "critical",
  ).length;

  console.log(
    `\n[verify-devices] total findings=${result.allFindings.length} high-severity=${highCount}`,
  );

  if (highCount > 0) {
    console.error(
      `[verify-devices] FAIL — ${highCount} high-severity responsive/layout issue(s). Do not ship.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("[verify-devices] PASS — no high-severity responsive/layout issues.");
}

main().catch((err) => {
  // The module itself must never crash the runner without a clear signal.
  console.error("[verify-devices] unexpected error:", (err as Error).message);
  process.exitCode = 1;
});
