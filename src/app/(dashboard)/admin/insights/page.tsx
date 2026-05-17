/**
 * /admin/insights — admin dashboard surfacing three insight feeds
 * that together turn the event stream into "what to build next":
 *
 *   1. Unmet intents — phrases that fell through to the LLM,
 *      clustered + ranked by distinct-user count. This is the
 *      backlog signal.
 *   2. Integration templates — the canonical registry of every
 *      widget / form / page-facts surface paired with the external
 *      tool it mirrors. Shows last-known schema hash + use cases.
 *   3. Integration health — connectivity + schema-drift status per
 *      vendor (read from the integration_health_latest view).
 *
 * Auth: cto / ceo / evp (gate matches the underlying endpoints).
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, authHeaders, fetchWithRefresh } from "@/lib/client-auth";

interface UserInfo {
  role: string;
}

function isAdmin(user: UserInfo | null): boolean {
  return !!user && (user.role === "ceo" || user.role === "cto" || user.role === "evp");
}

interface UnmetIntent {
  normalizedText: string;
  exampleText: string;
  count: number;
  lastSeenAt: string;
  distinctUsers: number;
  brainContextRate: number;
}

interface IntegrationTemplate {
  id: string;
  templateId: string;
  surface: string;
  vendor: string;
  objectType: string | null;
  useCases: string[];
  lastKnownSchemaHash: string | null;
  fallbackFieldSet: Array<{ name: string; required?: boolean }>;
  notes: string | null;
  isActive: boolean;
}

interface HealthVendor {
  vendor: string;
  connectivity: { ok: boolean; statusCode: number | null; errorMessage: string | null; probedAt: string } | null;
  schema: Array<{
    objectType: string | null;
    ok: boolean;
    schemaHash: string | null;
    drifted: boolean;
    errorMessage: string | null;
    probedAt: string;
  }>;
}

export default function InsightsAdminPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);

  const [intents, setIntents] = useState<UnmetIntent[] | null>(null);
  const [templates, setTemplates] = useState<IntegrationTemplate[] | null>(null);
  const [health, setHealth] = useState<HealthVendor[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const u = getInstinctUser<UserInfo>();
    setUser(u);
    if (!u) {
      router.push("/login?next=/admin/insights");
      return;
    }
    if (!isAdmin(u)) {
      router.push("/");
    }
  }, [router]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const failures: string[] = [];
    try {
      const [intentRes, templateRes, healthRes] = await Promise.all([
        fetchWithRefresh("/api/admin/insights/unmet-intents", { headers: authHeaders() }),
        fetchWithRefresh("/api/admin/templates", { headers: authHeaders() }),
        fetchWithRefresh("/api/health/integrations", { headers: authHeaders() }),
      ]);
      if (intentRes.ok) {
        const body = await intentRes.json();
        setIntents(body.intents ?? []);
      } else failures.push(`unmet-intents: HTTP ${intentRes.status}`);
      if (templateRes.ok) {
        const body = await templateRes.json();
        setTemplates(body.templates ?? []);
      } else failures.push(`templates: HTTP ${templateRes.status}`);
      if (healthRes.ok) {
        const body = await healthRes.json();
        setHealth(body.vendors ?? []);
      } else failures.push(`health: HTTP ${healthRes.status}`);
    } catch (err) {
      failures.push((err as Error).message);
    }
    setErrors(failures);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (user && isAdmin(user)) loadAll();
  }, [user, loadAll]);

  if (!user) return null;
  if (!isAdmin(user)) return null;

  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="insights-admin-page">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
          Insights
        </h1>
        <button
          onClick={loadAll}
          disabled={loading}
          className="px-3 py-1.5 rounded text-sm font-medium"
          style={{
            background: "var(--wp-dark-surface2)",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-dark-border)",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {errors.length > 0 && (
        <div
          className="mb-4 p-3 rounded text-sm"
          style={{
            background: "rgba(239,68,68,0.10)",
            color: "var(--wp-error)",
            border: "1px solid rgba(239,68,68,0.30)",
          }}
        >
          Some feeds failed to load: {errors.join("; ")}
        </div>
      )}

      <section data-testid="insights-unmet-intents" className="mb-8">
        <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
          Unmet intents (last 7 days)
        </h2>
        <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
          Phrases users typed that no deterministic tool matched. Ranked by distinct users, then count.
        </p>
        {intents === null ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading…</p>
        ) : intents.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            No unmet intents in the window. Either every prompt routed to a deterministic tool, or
            traffic is low — check back after more usage.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: "var(--wp-text-dim)", textAlign: "left" }}>
                <th className="py-1">Phrase</th>
                <th className="py-1 w-20">Users</th>
                <th className="py-1 w-20">Count</th>
                <th className="py-1 w-32">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {intents.map((i) => (
                <tr key={i.normalizedText} className="border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
                  <td className="py-2" style={{ color: "var(--wp-text)" }}>
                    {i.exampleText}
                  </td>
                  <td className="py-2" style={{ color: "var(--wp-text-dim)" }}>{i.distinctUsers}</td>
                  <td className="py-2" style={{ color: "var(--wp-text-dim)" }}>{i.count}</td>
                  <td className="py-2 text-xs" style={{ color: "var(--wp-text-muted)" }}>
                    {new Date(i.lastSeenAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section data-testid="insights-templates" className="mb-8">
        <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
          Integration templates
        </h2>
        <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
          Every widget + form, the vendor it mirrors, what it&apos;s used for, last-known schema.
        </p>
        {templates === null ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading…</p>
        ) : templates.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            No templates registered. Run migration 141.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: "var(--wp-text-dim)", textAlign: "left" }}>
                <th className="py-1">Template</th>
                <th className="py-1 w-24">Surface</th>
                <th className="py-1 w-28">Vendor</th>
                <th className="py-1 w-28">Object</th>
                <th className="py-1">Use cases</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
                  <td className="py-2 font-mono text-xs" style={{ color: "var(--wp-text)" }}>{t.templateId}</td>
                  <td className="py-2 text-xs" style={{ color: "var(--wp-text-dim)" }}>{t.surface}</td>
                  <td className="py-2 text-xs" style={{ color: "var(--wp-text-dim)" }}>{t.vendor}</td>
                  <td className="py-2 text-xs" style={{ color: "var(--wp-text-dim)" }}>{t.objectType ?? "—"}</td>
                  <td className="py-2 text-xs" style={{ color: "var(--wp-text-muted)" }}>
                    {t.useCases.join("; ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section data-testid="insights-health" className="mb-8">
        <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
          Integration health
        </h2>
        <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
          Latest connectivity + schema-drift status per vendor. <code>drifted</code> = the latest
          schema hash differs from the previous one.
        </p>
        {health === null ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading…</p>
        ) : health.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            No probe data yet. Hit <code>?run=true</code> on the health endpoint or wait for the
            nightly orchestrator.
          </p>
        ) : (
          <div className="space-y-3">
            {health.map((v) => (
              <div
                key={v.vendor}
                className="rounded p-3"
                style={{ background: "var(--wp-dark-surface)", border: "1px solid var(--wp-dark-border)" }}
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold" style={{ color: "var(--wp-text)" }}>{v.vendor}</div>
                  {v.connectivity ? (
                    <span
                      className="text-xs px-2 py-0.5 rounded"
                      style={{
                        background: v.connectivity.ok ? "rgba(34,197,94,0.10)" : "rgba(239,68,68,0.10)",
                        color: v.connectivity.ok ? "var(--wp-success, #22c55e)" : "var(--wp-error)",
                      }}
                    >
                      {v.connectivity.ok ? "connected" : v.connectivity.errorMessage ?? "down"}
                    </span>
                  ) : (
                    <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>no probe</span>
                  )}
                </div>
                {v.schema.length > 0 && (
                  <table className="w-full text-xs mt-2">
                    <thead>
                      <tr style={{ color: "var(--wp-text-dim)", textAlign: "left" }}>
                        <th className="py-0.5">Object</th>
                        <th className="py-0.5 w-16">OK</th>
                        <th className="py-0.5 w-16">Drift</th>
                        <th className="py-0.5">Hash</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.schema.map((s) => (
                        <tr key={`${v.vendor}-${s.objectType}`} className="border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
                          <td className="py-1" style={{ color: "var(--wp-text)" }}>{s.objectType ?? "—"}</td>
                          <td className="py-1" style={{ color: s.ok ? "var(--wp-success, #22c55e)" : "var(--wp-error)" }}>
                            {s.ok ? "✓" : "✗"}
                          </td>
                          <td className="py-1" style={{ color: s.drifted ? "var(--wp-warning, #eab308)" : "var(--wp-text-muted)" }}>
                            {s.drifted ? "drifted" : "stable"}
                          </td>
                          <td className="py-1 font-mono" style={{ color: "var(--wp-text-muted)" }}>
                            {s.schemaHash ? s.schemaHash.slice(0, 12) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
