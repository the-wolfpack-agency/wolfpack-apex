/**
 * Read-only probe of our deployed sites' public surface.
 *
 *   npm run security:surface                               # every site in surface-sites.json
 *   npm run security:surface -- --site instinct,fdos       # some of them
 *   npm run security:surface -- --url https://preview.example.com --protected-path /admin
 *   npm run security:surface -- --post-deploy --site instinct --expect-sha <sha>
 *
 * --post-deploy also asserts what a fresh deploy must get right: `/` and the
 * site's loginPath answer 200 after redirects; on a site marked
 * enforcesForcefield, /?q=ignore%20all%20previous%20instructions is refused
 * with 403 and x-forcefield: blocked:payload; and with --expect-sha, the
 * site's versionPath (/api/version) reports that commit. With --url, pass
 * --login-path, --enforces-forcefield and --version-path for the same checks.
 *
 * Per site: core security headers (CSP, HSTS, nosniff, frame protection,
 * Referrer-Policy), no version-leaking X-Powered-By or Server banner, /.env and
 * /.git/config not served, /_next/image not an open proxy for external URLs,
 * and an x-middleware-subrequest header does not turn a refused request into a
 * served one (CVE-2025-29927). Rules: scripts/security/lib/surface.ts.
 *
 * GET, HEAD and OPTIONS only. No form posts, no logins, nothing that changes
 * state on the target. The image-proxy probe asks the target to fetch one
 * public Google logo, which is exactly the behavior being tested.
 *
 * Exit: 0 clean, 1 findings at or above --fail-on (default medium), 2 error.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { emitReport, newReport, parseCliOptions } from "./lib/report";
import {
  INJECTION_PROBE_PATH,
  MIDDLEWARE_SUBREQUEST_VALUES,
  headerFindings,
  injectionProbeFinding,
  postDeployStatusFinding,
  versionFinding,
  imageProxyFinding,
  middlewareBypassFinding,
  secretPathFinding,
  toHeaderMap,
  type ProbeResponse,
  type SiteConfig,
} from "./lib/surface";

const argv = process.argv.slice(2);
const opts = parseCliOptions(argv, "scripts/security/out");
const argValue = (flag: string) => {
  const i = argv.indexOf(flag);
  return i > -1 ? argv[i + 1] : undefined;
};
const POST_DEPLOY = argv.includes("--post-deploy");
const EXPECT_SHA = argValue("--expect-sha");
const CONFIG = resolve(argValue("--config") ?? "scripts/security/surface-sites.json");
const EXTERNAL_IMAGE = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png";
const TIMEOUT_MS = 20_000;
const UA = "wolfpack-security-surface/1.0 (+read-only probe)";

async function probe(url: string, init: { method?: "GET" | "HEAD" | "OPTIONS"; headers?: Record<string, string>; follow?: boolean } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      redirect: init.follow ? "follow" : "manual",
      headers: { "user-agent": UA, ...(init.headers ?? {}) },
      signal: ctl.signal,
    });
    const ct = res.headers.get("content-type") ?? "";
    // Read a bounded prefix only: enough to recognize a leaked file.
    let body = "";
    if (init.method !== "HEAD" && !/^image\//i.test(ct)) body = (await res.text()).slice(0, 65536);
    else await res.arrayBuffer().catch(() => undefined);
    return { ok: true as const, status: res.status, headers: toHeaderMap(res.headers), contentType: ct, body, finalUrl: res.url };
  } catch (e) {
    return { ok: false as const, error: (e as Error).name === "AbortError" ? "timed out" : (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

function loadSites(): SiteConfig[] {
  const adhoc = argValue("--url");
  if (adhoc) {
    return [
      {
        name: argValue("--name") ?? new URL(adhoc).host,
        url: adhoc.replace(/\/$/, ""),
        protectedPath: argValue("--protected-path") || null,
        loginPath: argValue("--login-path") || null,
        enforcesForcefield: argv.includes("--enforces-forcefield"),
        versionPath: argValue("--version-path") || null,
      },
    ];
  }
  const all = (JSON.parse(readFileSync(CONFIG, "utf8")) as { sites: SiteConfig[] }).sites;
  const only = argValue("--site")?.split(",").map((s) => s.trim());
  return only ? all.filter((s) => only.includes(s.name)) : all;
}

/** --post-deploy and --expect-sha. Returns the number of requests made. */
async function postDeployChecks(site: SiteConfig, base: string, landingStatus: number, report: ReturnType<typeof newReport>): Promise<number> {
  let n = 0;
  if (POST_DEPLOY) {
    const root = postDeployStatusFinding(site.name, "/", landingStatus);
    if (root) report.findings.push(root);
    if (site.loginPath) {
      const r = await probe(`${base}${site.loginPath}`, { follow: true });
      n += 1;
      const f = postDeployStatusFinding(site.name, site.loginPath, r.ok ? r.status : null, r.ok ? undefined : r.error);
      if (f) report.findings.push(f);
    } else report.notes.push(`${site.name}: no loginPath configured; the login page check was not run.`);

    const inj = await probe(`${base}${INJECTION_PROBE_PATH}`);
    n += 1;
    const status = inj.ok ? inj.status : null;
    const marker = inj.ok ? (inj.headers["x-forcefield"] ?? null) : null;
    const f = injectionProbeFinding(site.name, site.enforcesForcefield === true, status, marker);
    if (f) report.findings.push(f);
    if (!site.enforcesForcefield) {
      report.notes.push(`${site.name}: not marked enforcesForcefield; the injection probe answered ${inj.ok ? `HTTP ${inj.status}` : inj.error} and was not asserted.`);
    }
  }
  if (EXPECT_SHA) {
    let status: number | null = null;
    let body = "";
    if (site.versionPath) {
      const r = await probe(`${base}${site.versionPath}`, { follow: true });
      n += 1;
      if (r.ok) {
        status = r.status;
        body = r.body;
      }
    }
    const f = versionFinding(site.name, EXPECT_SHA, site.versionPath, status, body);
    if (f) report.findings.push(f);
  }
  return n;
}

async function main(): Promise<number> {
  const report = newReport("surface");
  const sites = loadSites();
  if (!sites.length) {
    process.stderr.write("No sites selected.\n");
    return 2;
  }
  if (EXPECT_SHA && sites.length > 1) {
    process.stderr.write("--expect-sha names one deployment's commit: pick one site with --site <name> or --url.\n");
    return 2;
  }
  let probes = 0;
  for (const site of sites) {
    const base = site.url.replace(/\/$/, "");
    const landing = await probe(`${base}/`, { follow: true });
    probes += 1;
    if (!landing.ok || landing.status >= 500) {
      report.findings.push({
        severity: "medium",
        rule: "surface.unreachable",
        subject: site.name,
        detail: `${base}/ did not answer cleanly (${landing.ok ? `HTTP ${landing.status}` : landing.error}); the other probes for this site were skipped.`,
        source: base,
      });
      continue;
    }
    report.stats[`${site.name}`] = `${base} -> HTTP ${landing.status} at ${landing.finalUrl}`;

    if (POST_DEPLOY || EXPECT_SHA) {
      probes += await postDeployChecks(site, base, landing.status, report);
    }
    report.findings.push(...headerFindings(site.name, landing.headers));

    for (const path of ["/.env", "/.git/config"]) {
      const r = await probe(`${base}${path}`);
      probes += 1;
      if (!r.ok) {
        report.notes.push(`${site.name}: ${path} probe failed (${r.error}).`);
        continue;
      }
      const f = secretPathFinding(site.name, path, r.status, r.contentType, r.body);
      if (f) report.findings.push(f);
    }

    const img = await probe(`${base}/_next/image?url=${encodeURIComponent(EXTERNAL_IMAGE)}&w=64&q=75`);
    probes += 1;
    if (img.ok) {
      const f = imageProxyFinding(site.name, img.status, img.contentType, EXTERNAL_IMAGE);
      if (f) report.findings.push(f);
    } else report.notes.push(`${site.name}: /_next/image probe failed (${img.error}).`);

    if (site.protectedPath) {
      const url = `${base}${site.protectedPath}`;
      const baseline = await probe(url);
      probes += 1;
      if (!baseline.ok) {
        report.notes.push(`${site.name}: protected path probe failed (${baseline.error}).`);
      } else {
        const b: ProbeResponse = { status: baseline.status, location: baseline.headers["location"] ?? null };
        if (!(b.status === 401 || b.status === 403 || (b.status >= 300 && b.status < 400))) {
          report.notes.push(`${site.name}: ${site.protectedPath} answered HTTP ${b.status} anonymously, so there is no refusal to test the middleware bypass against. Point protectedPath at a path that refuses anonymous requests.`);
        }
        for (const value of MIDDLEWARE_SUBREQUEST_VALUES) {
          const r = await probe(url, { headers: { "x-middleware-subrequest": value } });
          probes += 1;
          if (!r.ok) continue;
          const f = middlewareBypassFinding(site.name, site.protectedPath, b, { status: r.status, location: r.headers["location"] ?? null }, value);
          if (f) {
            report.findings.push(f);
            break;
          }
        }
      }
    } else {
      report.notes.push(`${site.name}: no protectedPath configured; the x-middleware-subrequest check was not run.`);
    }
  }
  report.stats = { sites: sites.length, requests: probes, ...report.stats };
  report.notes.push(`Sites list: ${argValue("--url") ? "--url argument" : CONFIG}.`);
  return emitReport(report, opts);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`security:surface failed: ${(e as Error).stack ?? e}\n`);
    process.exit(2);
  },
);
