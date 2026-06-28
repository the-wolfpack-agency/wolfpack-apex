#!/usr/bin/env node
/**
 * scripts/competitive-benchmark.mjs - THE COMPETITIVE BENCHMARK runner.
 *
 * Proves to clients we find the same (and more) issues than the leading FREE
 * scanners. On each tick it runs OWASP ZAP (baseline) + Nuclei against the SAME
 * consent-to-test corpus targets we score ourselves against, parses each tool's
 * JSON output, and POSTs the raw findings to apex's competitive endpoint, which
 * normalizes them into OUR taxonomy, scores them with the SAME scorer vs the same
 * ground truth, and records the head-to-head.
 *
 * TOOL CHOICE (documented + defensible):
 *   - OWASP ZAP   the canonical free DAST baseline; the de-facto reference every
 *                 security team recognizes. `zap-baseline.py` is read-only (passive
 *                 + safe spider), so it fits the read-only sweep floor.
 *   - Nuclei      modern, template-driven, fast; the current community standard for
 *                 signature-based detection. Complements ZAP's passive analysis.
 *   - REJECTED: Nikto (dated, noisy, largely superseded), and paid tools
 *     (Burp Pro, Acunetix, etc.) because they are not reproducible in CI without a
 *     license and cannot be re-run by a client to verify our numbers. The whole
 *     point is a reproducible, honest, apples-to-apples comparison.
 *
 * SAFETY - READ-ONLY ONLY, CONSENT-GATED:
 *   Targets come ONLY from the consent corpus, gated through the SAME read-only
 *   consent floor the benchmark sweep uses (selectReadOnlyTargets ->
 *   assertBenchmarkConsent(target, "read-only")). The open internet is never a
 *   target. We run ZAP in BASELINE mode and Nuclei WITHOUT intrusive/destructive
 *   templates, so neither mutates a target. Active probing of planted vulns is a
 *   separate, explicitly-authorized pentest run, never this script.
 *
 * Thin orchestrator. The corpus + consent gate + target selection are REUSED from
 * the unit-tested core (benchmark/sweep-targets.ts); this script only shells out to
 * the two tools (via docker), parses their JSON, and POSTs.
 *
 * Config (env; argv overrides where given):
 *   --base / BASE_URL      apex base URL for the competitive endpoint.
 *   --secret / CRON_SECRET Bearer secret for the endpoint (required to POST; dry
 *                          run without it).
 *   --tools                comma list, subset of "zap,nuclei" (default both).
 *   BENCHMARK_JUICE_SHOP_URL / _OWASP_URL / _VAMPI_URL / _NODEGOAT_URL
 *                          OPTIONAL self-hosted labeled targets on OUR infra; when
 *                          set, the matching corpus entry points at them.
 *
 * Usage:
 *   node scripts/competitive-benchmark.mjs --base https://wolfpack-instinct.vercel.app \
 *     --secret $CRON_SECRET --tools zap,nuclei
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Register ts-node so we import the SAME TS core the unit tests cover (no JS copy to
// drift). CJS transpile-only mirrors scripts/benchmark-sweep.mjs exactly.
require("ts-node").register({
  transpileOnly: true,
  compilerOptions: { module: "commonjs", moduleResolution: "node", esModuleInterop: true },
});

const { selectReadOnlyTargets } = require(
  join(ROOT, "src/lib/platform-scan/benchmark/sweep-targets.ts"),
);

function argOf(flag, envKey, fallback) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (envKey && process.env[envKey]) return process.env[envKey];
  return fallback;
}

/** Run a command, capturing stdout/stderr; never throws (returns the result). */
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 600_000, ...opts });
}

/**
 * Run OWASP ZAP baseline against a URL (read-only passive scan) via the official
 * docker image, emitting a JSON report. Returns the raw alert objects (or [] on
 * any failure - a tool we cannot run must never crash the whole sweep). Each ZAP
 * alert object carries `alert` (name) + `instances[].uri`; we flatten to one entry
 * per instance so the route sees a route/url per finding.
 */
function runZap(url) {
  const outDir = mkdtempSync(join(tmpdir(), "zap-"));
  const reportName = "zap-report.json";
  // zap-baseline.py is passive + safe-spider only: read-only by design.
  const res = run("docker", [
    "run",
    "--rm",
    "-v",
    `${outDir}:/zap/wrk:rw`,
    "ghcr.io/zaproxy/zaproxy",
    "zap-baseline.py",
    "-t",
    url,
    "-J",
    reportName,
    "-I", // do not fail the process on warnings
  ]);
  const reportPath = join(outDir, reportName);
  if (!existsSync(reportPath)) {
    console.warn(`[competitive] zap produced no report for ${url} (exit ${res.status})`);
    return [];
  }
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const findings = [];
    for (const site of report.site ?? []) {
      for (const alert of site.alerts ?? []) {
        const instances = alert.instances ?? [{ uri: site["@name"] ?? url }];
        for (const inst of instances) {
          findings.push({ alert: alert.alert ?? alert.name, url: inst.uri ?? url });
        }
      }
    }
    return findings;
  } catch (err) {
    console.warn(`[competitive] failed to parse zap report for ${url}: ${err.message}`);
    return [];
  }
}

/**
 * Run Nuclei against a URL via the official docker image, emitting JSONL. Read-only:
 * we exclude intrusive/destructive template tags so nothing mutates the target.
 * Returns one raw object per match with templateId + tags + matched-at. [] on any
 * failure.
 */
function runNuclei(url) {
  const res = run("docker", [
    "run",
    "--rm",
    "projectdiscovery/nuclei",
    "-u",
    url,
    "-jsonl",
    "-silent",
    // Read-only floor: exclude any template tagged intrusive/destructive/fuzz/dos.
    "-exclude-tags",
    "intrusive,dos,fuzz,destructive",
  ]);
  if (res.status !== 0 && !res.stdout) {
    console.warn(`[competitive] nuclei failed for ${url} (exit ${res.status}): ${res.stderr ?? ""}`);
    return [];
  }
  const findings = [];
  for (const line of (res.stdout ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      findings.push({
        templateId: obj["template-id"] ?? obj.templateID ?? obj.templateId,
        name: obj.info?.name,
        tags: obj.info?.tags ?? [],
        "matched-at": obj["matched-at"] ?? obj.host ?? url,
      });
    } catch {
      // Skip a non-JSON log line (nuclei prints some banners even with -silent).
    }
  }
  return findings;
}

const TOOL_RUNNERS = { zap: runZap, nuclei: runNuclei };

async function main() {
  const baseUrl = argOf("--base", "BASE_URL", "https://wolfpack-instinct.vercel.app").replace(/\/$/, "");
  const secret = argOf("--secret", "CRON_SECRET", "");
  const toolsArg = argOf("--tools", "COMPETITIVE_TOOLS", "zap,nuclei");
  const tools = toolsArg
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t in TOOL_RUNNERS);
  const competitiveUrl = `${baseUrl}/api/admin/platform-scans/benchmark/competitive`;

  // SAFETY FLOOR (reused from the core): only corpus targets that pass the
  // read-only consent gate are sweepable; anything that throws is skipped.
  const { selected, skipped } = selectReadOnlyTargets();
  for (const s of skipped) {
    console.warn(`[competitive] skipped ${s.name}: ${s.reason} (consent refused)`);
  }
  console.log(
    `[competitive] apex=${baseUrl} tools=${tools.join(",")} targets=${selected.length} (read-only)`,
  );

  /** POST one tool/target's raw findings to the competitive endpoint. */
  async function post(entry) {
    if (!secret) {
      console.warn(
        `[competitive] no --secret/CRON_SECRET; skipping POST for ${entry.tool} vs ${entry.target} (dry run)`,
      );
      return;
    }
    const res = await fetch(competitiveUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(entry),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`competitive POST failed ${res.status}: ${text}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const report = parsed?.reports?.[0];
    console.log(
      `[competitive] ${entry.tool} vs ${entry.target}: ok`,
      report
        ? JSON.stringify({
            theirRecall: report.tools?.[0]?.recall,
            ourRecall: report.ours?.recall,
            rivalOnlyGaps: report.rivalOnlyGaps?.length,
            parity: report.parity,
          })
        : "",
    );
  }

  for (const target of selected) {
    for (const tool of tools) {
      // Per-(tool,target) isolation: one failure must not abort the sweep.
      try {
        const findings = TOOL_RUNNERS[tool](target.baseUrl);
        console.log(
          `[competitive] ${tool} on ${target.name} (${target.baseUrl}): ${findings.length} finding(s)`,
        );
        await post({ tool, target: target.name, findings });
      } catch (err) {
        console.error(`[competitive] ${tool} vs ${target.name} failed: ${err.message}`);
        process.exitCode = 1;
      }
    }
  }

  console.log("[competitive] done");
}

main().catch((err) => {
  console.error("[competitive]", err);
  process.exit(1);
});
