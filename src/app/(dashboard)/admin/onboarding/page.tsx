"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

interface UserInfo {
  role: string;
}
function isAdmin(user: UserInfo | null): boolean {
  return !!user && (user.role === "ceo" || user.role === "cto" || user.role === "evp");
}

interface TargetRow {
  platform: string;
  baseUrl: string;
  hasStatic: boolean;
  hasApi: boolean;
  hasLogin: boolean;
}

interface BaselineResult {
  scanned: boolean;
  findingCount: number;
  criticalCount: number;
  recommendations: number;
  profiled: boolean;
}

interface PreflightCheck {
  name: string;
  pass: boolean;
  detail: string;
  critical: boolean;
}

interface PreflightResult {
  platform: string;
  ok: boolean;
  checks: PreflightCheck[];
}

const inputStyle = { background: "var(--wp-dark-base)", border: "1px solid var(--wp-dark-border)", color: "var(--wp-text)" };

export default function OnboardingPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [targets, setTargets] = useState<TargetRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Onboard form
  const [platform, setPlatform] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [repoRef, setRepoRef] = useState("main");
  const [protectedPaths, setProtectedPaths] = useState("/admin");
  const [publicPaths, setPublicPaths] = useState("/");
  const [onboarding, setOnboarding] = useState(false);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const [onboarded, setOnboarded] = useState<string | null>(null);

  // Baseline
  const [running, setRunning] = useState(false);
  const [baseline, setBaseline] = useState<BaselineResult | null>(null);

  // Preflight (test connection), keyed by platform
  const [preflightFor, setPreflightFor] = useState<string | null>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  useEffect(() => {
    const u = getInstinctUser<UserInfo>();
    if (!u) {
      router.push("/login?next=/admin/onboarding");
      return;
    }
    setUser(u);
    if (!isAdmin(u)) setError("This page is for CEO/CTO roles only.");
  }, [router]);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans/targets");
      if (!res.ok) return;
      const data = (await res.json()) as { targets: TargetRow[] };
      setTargets(data.targets ?? []);
    } catch {
      /* listing is best effort */
    }
  }, []);

  useEffect(() => {
    if (user && isAdmin(user)) void load();
  }, [user, load]);

  function buildManifest() {
    const toRoutes = (csv: string, auth: "required" | "public") =>
      csv.split(",").map((p) => p.trim()).filter(Boolean).map((p) => ({ path: p, journey: `${auth === "required" ? "Protected" : "Public"} ${p}`, auth }));
    const routes = [...toRoutes(protectedPaths, "required"), ...toRoutes(publicPaths, "public")];
    const hasRepo = repoOwner.trim() && repoName.trim();
    return {
      baseUrl: baseUrl.trim(),
      routes,
      ...(hasRepo ? { static: { owner: repoOwner.trim(), repo: repoName.trim(), ref: repoRef.trim() || "main", paths: [] } } : {}),
    };
  }

  async function onOnboard(e: React.FormEvent) {
    e.preventDefault();
    setOnboarding(true);
    setOnboardError(null);
    setBaseline(null);
    try {
      const res = await fetchWithRefresh("/api/admin/platform-scans/targets", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ platform: platform.trim(), manifest: buildManifest() }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setOnboardError(b?.error ? String(b.error) : `Onboard failed: ${res.status}`);
        return;
      }
      setOnboarded(platform.trim());
      await load();
    } catch (e2) {
      setOnboardError((e2 as Error).message);
    } finally {
      setOnboarding(false);
    }
  }

  async function onRunBaseline() {
    if (!onboarded) return;
    setRunning(true);
    setError(null);
    const hasRepo = repoOwner.trim() && repoName.trim();
    try {
      let profiled = false;
      if (hasRepo) {
        const p = await fetchWithRefresh("/api/admin/platform-scans/profile", {
          method: "POST", headers: jsonHeaders(), body: JSON.stringify({ platform: onboarded }),
        });
        profiled = p.ok;
      }
      const scanRes = await fetchWithRefresh("/api/admin/platform-scans", {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ platform: onboarded, mode: hasRepo ? "static" : "http" }),
      });
      const scan = scanRes.ok ? ((await scanRes.json()) as { findingCount?: number; criticalCount?: number }) : {};
      const recRes = await fetchWithRefresh("/api/admin/platform-scans/recommendations", {
        method: "POST", headers: jsonHeaders(), body: JSON.stringify({ platform: onboarded }),
      });
      const rec = recRes.ok ? ((await recRes.json()) as { count?: number }) : {};
      setBaseline({
        scanned: scanRes.ok,
        findingCount: scan.findingCount ?? 0,
        criticalCount: scan.criticalCount ?? 0,
        recommendations: rec.count ?? 0,
        profiled,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function onTestConnection(p: string) {
    setPreflightFor(p);
    setPreflighting(true);
    setPreflight(null);
    setPreflightError(null);
    try {
      const res = await fetchWithRefresh(`/api/admin/platform-scans/preflight?platform=${encodeURIComponent(p)}`);
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setPreflightError(b?.error ? String(b.error) : `Test connection failed: ${res.status}`);
        return;
      }
      const data = (await res.json()) as PreflightResult;
      setPreflight(data);
    } catch (e) {
      setPreflightError((e as Error).message);
    } finally {
      setPreflighting(false);
    }
  }

  async function onOffboard(p: string) {
    const res = await fetchWithRefresh(`/api/admin/platform-scans/targets?platform=${encodeURIComponent(p)}`, {
      method: "DELETE", headers: jsonHeaders(),
    });
    if (res.ok) await load();
    else setError(`Offboard failed: ${res.status}`);
  }

  if (!user) return null;
  if (!isAdmin(user)) {
    return <div className="p-6 text-sm" style={{ color: "var(--wp-text-dim)" }}>{error ?? "Admin access required."}</div>;
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="mb-2 text-xl font-semibold" style={{ color: "var(--wp-gold)" }}>Onboard a Client System</h1>
      <p className="mb-6 text-sm" style={{ color: "var(--wp-text-dim)" }}>
        Register a client target once: its deployed URL, repo, and routes. Every capability (scan, map,
        recommend, report, pentest) then works against it with no deploy.
      </p>

      {error && <div className="mb-4 rounded p-3 text-sm" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.6)", color: "#ef4444" }}>{error}</div>}

      {/* Step 1: onboard */}
      <form data-testid="onboard-form" onSubmit={onOnboard} className="mb-8 grid grid-cols-1 gap-3 rounded-lg p-4 sm:grid-cols-2" style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)" }}>
        <div className="sm:col-span-2 text-sm font-medium" style={{ color: "var(--wp-text)" }}>1. Register the target</div>
        <input data-testid="onboard-platform" value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="Platform id (e.g. acme-app)" required className="px-2 py-1.5 rounded text-sm" style={inputStyle} />
        <input data-testid="onboard-baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Deployed URL (https://app.acme.com)" required className="px-2 py-1.5 rounded text-sm" style={inputStyle} />
        <input data-testid="onboard-repo-owner" value={repoOwner} onChange={(e) => setRepoOwner(e.target.value)} placeholder="Repo owner (optional)" className="px-2 py-1.5 rounded text-sm" style={inputStyle} />
        <input data-testid="onboard-repo-name" value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="Repo name (optional)" className="px-2 py-1.5 rounded text-sm" style={inputStyle} />
        <input value={protectedPaths} onChange={(e) => setProtectedPaths(e.target.value)} placeholder="Protected paths (comma)" className="px-2 py-1.5 rounded text-sm" style={inputStyle} />
        <input value={publicPaths} onChange={(e) => setPublicPaths(e.target.value)} placeholder="Public paths (comma)" className="px-2 py-1.5 rounded text-sm" style={inputStyle} />
        {onboardError && <div className="sm:col-span-2 text-xs" style={{ color: "#ef4444" }}>{onboardError}</div>}
        <button data-testid="onboard-submit" type="submit" disabled={onboarding} className="sm:col-span-2 justify-self-start px-3 py-2 rounded text-sm" style={{ background: "var(--wp-gold)", color: "var(--wp-dark-base)" }}>
          {onboarding ? "Registering…" : "Onboard target"}
        </button>
      </form>

      {/* Step 2: baseline */}
      {onboarded && (
        <div data-testid="onboard-baseline" className="mb-8 rounded-lg p-4" style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)" }}>
          <div className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>2. Baseline assessment for {onboarded}</div>
          <p className="mt-1 mb-3 text-xs" style={{ color: "var(--wp-text-dim)" }}>Maps the system, scans it, and generates recommendations. All findings flow into the review console + report.</p>
          <button data-testid="onboard-run-baseline" onClick={onRunBaseline} disabled={running} className="px-3 py-2 rounded text-sm" style={{ background: "var(--wp-gold)", color: "var(--wp-dark-base)" }}>
            {running ? "Running…" : "Run baseline assessment"}
          </button>
          {baseline && (
            <div data-testid="onboard-baseline-result" className="mt-4 text-sm" style={{ color: "var(--wp-text)" }}>
              Scan: {baseline.findingCount} findings ({baseline.criticalCount} critical){baseline.profiled ? ", system mapped" : ""}, {baseline.recommendations} recommendations.
              <div className="mt-2 flex gap-3 text-xs">
                <a href="/admin/platform-scans" style={{ color: "var(--wp-gold)" }}>Review findings</a>
                <a href="/admin/pentest" style={{ color: "var(--wp-gold)" }}>Pentest console</a>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Onboarded targets */}
      <h2 className="mb-3 text-sm font-medium" style={{ color: "var(--wp-text)" }}>Targets</h2>
      {targets.length === 0 ? (
        <div data-testid="onboard-empty" className="text-sm" style={{ color: "var(--wp-text-dim)" }}>No targets yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-lg" style={{ border: "1px solid var(--wp-dark-border)" }}>
          <table className="w-full text-left text-sm">
            <thead style={{ color: "var(--wp-text-dim)" }}>
              <tr>{["Platform", "URL", "Repo", "API", "Login", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody style={{ color: "var(--wp-text)" }}>
              {targets.map((t) => (
                <tr data-testid="onboard-target-row" key={t.platform} style={{ borderTop: "1px solid var(--wp-dark-border)" }}>
                  <td className="px-3 py-2">{t.platform}</td>
                  <td className="px-3 py-2 font-mono text-xs">{t.baseUrl}</td>
                  <td className="px-3 py-2 text-xs">{t.hasStatic ? "yes" : "no"}</td>
                  <td className="px-3 py-2 text-xs">{t.hasApi ? "yes" : "no"}</td>
                  <td className="px-3 py-2 text-xs">{t.hasLogin ? "yes" : "no"}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <button data-testid="onboard-test-connection" onClick={() => onTestConnection(t.platform)} disabled={preflighting && preflightFor === t.platform} className="px-2 py-1 rounded text-xs" style={{ background: "var(--wp-dark-base)", border: "1px solid var(--wp-dark-border)", color: "var(--wp-text)" }}>
                        {preflighting && preflightFor === t.platform ? "Testing…" : "Test connection"}
                      </button>
                      <button data-testid="onboard-offboard" onClick={() => onOffboard(t.platform)} className="px-2 py-1 rounded text-xs" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.5)", color: "#ef4444" }}>Offboard</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Preflight (test connection) result */}
      {preflightFor && (preflighting || preflight || preflightError) && (
        <div data-testid="onboard-preflight" className="mt-6 rounded-lg p-4" style={{ background: "var(--wp-dark-elevated)", border: "1px solid var(--wp-dark-border)" }}>
          <div className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>Connection test for {preflightFor}</div>
          {preflighting && (
            <div data-testid="onboard-preflight-loading" className="mt-2 text-sm" style={{ color: "var(--wp-text-dim)" }}>Running readiness checks…</div>
          )}
          {!preflighting && preflightError && (
            <div data-testid="onboard-preflight-error" className="mt-2 rounded p-3 text-sm" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.6)", color: "#ef4444" }}>
              {preflightError}
            </div>
          )}
          {!preflighting && !preflightError && preflight && (
            <div className="mt-2">
              <div
                data-testid="onboard-preflight-banner"
                className="rounded p-3 text-sm font-medium"
                style={preflight.ok
                  ? { background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.6)", color: "#22c55e" }
                  : { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.6)", color: "#ef4444" }}
              >
                {preflight.ok ? "Ready" : "Not ready"}
              </div>
              <ul className="mt-3 space-y-1">
                {preflight.checks.map((c) => (
                  <li data-testid="onboard-preflight-check" key={c.name} className="flex items-start gap-2 text-sm" style={{ color: "var(--wp-text)" }}>
                    <span aria-hidden style={{ color: c.pass ? "#22c55e" : "#ef4444" }}>{c.pass ? "✓" : "✗"}</span>
                    <span>
                      <span className="font-medium">{c.name}</span>
                      {c.detail ? <span style={{ color: "var(--wp-text-dim)" }}>: {c.detail}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
