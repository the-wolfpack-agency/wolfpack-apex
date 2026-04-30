"use client";

/**
 * /admin/assistant-debug — self-service grounding diagnostic page.
 *
 * Open this URL while signed in to see EVERYTHING needed to diagnose
 * "the assistant says it doesn't have access" answers:
 *   - your Microsoft 365 token state (scopes parsed from the JWT)
 *   - live Graph probe results (SharePoint, Calendar, Mail, Tasks)
 *   - the full getRelevantContext bundle for a question
 *   - a 1-paragraph diagnosis of what to fix
 *
 * Why a client component (not a server component): the rest of the
 * dashboard authenticates via localStorage Bearer + fetchWithRefresh.
 * Writing a true server component here would diverge from the
 * established session pattern and would also break in environments
 * where the HttpOnly cookie isn't yet set (existing accounts logged
 * in with the legacy localStorage-only flow). The page-level UX
 * "open the URL while signed in and see EVERYTHING" still holds:
 * the dashboard layout already redirects unauthenticated users to
 * /login, and fetchWithRefresh handles 401 → silent refresh.
 *
 * Privacy: every byte rendered came from the calling user's own
 * delegated Graph token. No cross-user data. Raw access tokens are
 * never displayed.
 */

import { useState, useEffect, useCallback, FormEvent } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

const DEFAULT_QUESTION = "What's in the TWA Agenda 4.20 doc?";

interface ScopeReport {
  scopes_in_token: string[];
  expected_present: string[];
  expected_missing: string[];
  has_all_expected: boolean;
}

interface ProbeResult {
  name: string;
  label: string;
  endpoint: string;
  method: "GET" | "POST";
  status: number;
  ok: boolean;
  count?: number;
  error_code?: string;
  error_message?: string;
  scope_missing: boolean;
  took_ms: number;
}

interface GroundingDebugResponse {
  question: string;
  user: { id_hint: string; name: string; email: string; role: string };
  token: {
    has_token: boolean;
    decodable: boolean;
    user_email: string | null;
    expires_at: string | null;
    expires_in_seconds: number | null;
    audience: string | null;
    tenant_id: string | null;
    upn: string | null;
    scopes: ScopeReport | null;
  };
  probes: ProbeResult[];
  bundle: {
    surface: string;
    total_chars: number;
    took_ms: number;
    sharepoint_hits_count: number;
    project_tasks_count: number;
    meeting_notes_count: number;
    failures_observed: Array<{
      source: string;
      status: number;
      scope_missing: boolean;
      code?: string;
      message?: string;
    }>;
    rendered_prompt_block: string;
  };
  diagnosis: string;
  generated_at: string;
}

function formatExpiry(secs: number | null): string {
  if (secs === null) return "(unknown)";
  if (secs <= 0) return `expired ${Math.abs(secs)}s ago`;
  if (secs < 60) return `in ${secs}s`;
  if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
  return `in ${Math.round(secs / 3600)}h`;
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className="inline-block px-2 py-0.5 rounded text-xs font-mono"
      style={{
        background: ok ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)",
        color: ok ? "rgb(34,197,94)" : "rgb(239,68,68)",
      }}
    >
      {ok ? "OK" : ""} {label}
    </span>
  );
}

export default function AssistantDebugPage() {
  const [pendingQuestion, setPendingQuestion] = useState(DEFAULT_QUESTION);
  const [data, setData] = useState<GroundingDebugResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetchWithRefresh(
        `/api/assistant/grounding-debug?q=${encodeURIComponent(q)}`,
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as GroundingDebugResponse;
      setData(json);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(DEFAULT_QUESTION);
  }, [load]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = pendingQuestion.trim() || DEFAULT_QUESTION;
    void load(next);
  }

  return (
    <div
      className="max-w-5xl mx-auto"
      data-testid="assistant-debug-page"
      style={{ color: "var(--wp-text)" }}
    >
      <h1 className="text-2xl font-bold mb-2" style={{ color: "var(--wp-gold)" }}>
        Assistant Grounding Diagnostic
      </h1>
      <p className="text-sm mb-6" style={{ color: "var(--wp-text-dim)" }}>
        One URL. Everything needed to figure out why the assistant says
        &ldquo;I don&rsquo;t have access&rdquo;. Bookmark this page.
      </p>

      <form onSubmit={onSubmit} className="mb-6 flex gap-2">
        <input
          type="text"
          value={pendingQuestion}
          onChange={(e) => setPendingQuestion(e.target.value)}
          placeholder="Custom question to probe with"
          className="flex-1 px-3 py-2 rounded text-sm"
          style={{
            background: "var(--wp-dark-surface2)",
            border: "1px solid var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
          data-testid="assistant-debug-question-input"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 rounded text-sm font-medium"
          style={{
            background: "var(--wp-gold)",
            color: "var(--wp-dark)",
            opacity: loading ? 0.5 : 1,
          }}
          data-testid="assistant-debug-run-button"
        >
          {loading ? "Running..." : "Run"}
        </button>
      </form>

      {err && (
        <div
          className="p-4 rounded mb-6 text-sm"
          style={{ background: "rgba(239,68,68,0.15)", color: "rgb(239,68,68)" }}
          data-testid="assistant-debug-error"
        >
          Failed to load: {err}
        </div>
      )}

      {data && (
        <>
          <Section title="Signed in as" testId="section-user">
            <div className="space-y-1 text-sm font-mono">
              <div>
                {data.user.name}{" "}
                <span style={{ color: "var(--wp-text-dim)" }}>
                  ({data.user.email})
                </span>
              </div>
              <div style={{ color: "var(--wp-text-dim)" }}>
                Role: {data.user.role} &middot; User ID prefix:{" "}
                {data.user.id_hint}
              </div>
            </div>
          </Section>

          <Section
            title="Microsoft Graph Token Status"
            testId="section-token"
          >
            <div className="space-y-2 text-sm">
              <div>
                Has delegated token:{" "}
                <StatusPill
                  ok={data.token.has_token}
                  label={data.token.has_token ? "yes" : "no"}
                />
              </div>
              {data.token.has_token && (
                <>
                  <div className="font-mono text-xs" style={{ color: "var(--wp-text-dim)" }}>
                    Token expires: {data.token.expires_at ?? "(unknown)"} (
                    {formatExpiry(data.token.expires_in_seconds)})
                  </div>
                  {data.token.upn && (
                    <div className="font-mono text-xs" style={{ color: "var(--wp-text-dim)" }}>
                      UPN: {data.token.upn} &middot; tenant:{" "}
                      {data.token.tenant_id ?? "(none)"}
                    </div>
                  )}
                  {!data.token.decodable && (
                    <div className="text-xs" style={{ color: "var(--wp-warning)" }}>
                      Token is opaque (not decodable as JWT). Scope claim
                      cannot be read directly. Probe results below remain
                      authoritative.
                    </div>
                  )}
                  {data.token.scopes && (
                    <div className="mt-3" data-testid="section-scopes">
                      <div className="text-sm mb-1">Scopes in token:</div>
                      <ul className="text-xs font-mono space-y-1 ml-2">
                        {data.token.scopes.expected_present.map((s) => (
                          <li key={s}>
                            <span style={{ color: "rgb(34,197,94)" }}>OK</span>{" "}
                            {s}
                          </li>
                        ))}
                        {data.token.scopes.expected_missing.map((s) => (
                          <li key={s}>
                            <span style={{ color: "rgb(239,68,68)" }}>
                              MISSING
                            </span>{" "}
                            {s}
                          </li>
                        ))}
                      </ul>
                      {data.token.scopes.expected_missing.length > 0 && (
                        <div
                          className="mt-2 text-xs"
                          style={{ color: "var(--wp-warning)" }}
                        >
                          Missing scopes are the most likely reason a Graph
                          probe below will 403. See diagnosis at the bottom.
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </Section>

          <Section
            title="Probe results (live, using your token)"
            testId="section-probes"
          >
            <table className="w-full text-xs font-mono">
              <thead>
                <tr
                  style={{
                    color: "var(--wp-text-dim)",
                    borderBottom: "1px solid var(--wp-dark-border)",
                  }}
                >
                  <th className="text-left py-1">Probe</th>
                  <th className="text-left py-1">Status</th>
                  <th className="text-left py-1">Count</th>
                  <th className="text-left py-1">Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.probes.map((p) => (
                  <tr
                    key={p.name}
                    style={{ borderBottom: "1px solid var(--wp-dark-border)" }}
                    data-testid={`probe-row-${p.name}`}
                  >
                    <td className="py-2">
                      <div>{p.label}</div>
                      <div style={{ color: "var(--wp-text-dim)" }}>
                        {p.method} {p.endpoint}
                      </div>
                    </td>
                    <td className="py-2">
                      <StatusPill ok={p.ok} label={String(p.status || "ERR")} />
                    </td>
                    <td className="py-2">
                      {typeof p.count === "number" ? p.count : "-"}
                    </td>
                    <td className="py-2">
                      {p.scope_missing ? (
                        <span style={{ color: "rgb(239,68,68)" }}>
                          scope_missing=true
                        </span>
                      ) : p.error_code ? (
                        <span style={{ color: "var(--wp-warning)" }}>
                          {p.error_code}
                        </span>
                      ) : p.ok ? (
                        <span style={{ color: "var(--wp-text-dim)" }}>
                          {p.took_ms}ms
                        </span>
                      ) : (
                        <span style={{ color: "var(--wp-text-dim)" }}>-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            title={`getRelevantContext({ q: "${data.question}" })`}
            testId="section-bundle"
          >
            <div className="text-sm font-mono space-y-1">
              <div>total_chars: {data.bundle.total_chars}</div>
              <div>sharepoint_hits: {data.bundle.sharepoint_hits_count}</div>
              <div>project_tasks: {data.bundle.project_tasks_count}</div>
              <div>meeting_notes: {data.bundle.meeting_notes_count}</div>
              <div>took_ms: {data.bundle.took_ms}</div>
              {data.bundle.failures_observed.length > 0 && (
                <div className="mt-2">
                  <div style={{ color: "var(--wp-warning)" }}>
                    failures_observed:
                  </div>
                  <ul className="ml-4 text-xs">
                    {data.bundle.failures_observed.map((f, i) => (
                      <li key={`${f.source}-${i}`}>
                        - {f.source}: status={f.status}, scope_missing=
                        {String(f.scope_missing)}
                        {f.code ? `, code=${f.code}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <details className="mt-3">
                <summary
                  className="cursor-pointer text-xs"
                  style={{ color: "var(--wp-text-dim)" }}
                >
                  rendered_prompt_block (
                  {data.bundle.rendered_prompt_block.length} chars)
                </summary>
                <pre
                  className="mt-2 p-3 text-xs whitespace-pre-wrap rounded"
                  style={{
                    background: "var(--wp-dark-elevated)",
                    border: "1px solid var(--wp-dark-border)",
                    maxHeight: 320,
                    overflowY: "auto",
                  }}
                  data-testid="rendered-prompt-block"
                >
                  {data.bundle.rendered_prompt_block || "(empty)"}
                </pre>
              </details>
            </div>
          </Section>

          <Section title="Diagnosis" testId="section-diagnosis">
            <p
              className="text-sm leading-relaxed"
              data-testid="diagnosis-text"
              style={{
                background: "var(--wp-dark-elevated)",
                border: "1px solid var(--wp-dark-border)",
                padding: "12px 16px",
                borderRadius: 6,
              }}
            >
              {data.diagnosis}
            </p>
            <div
              className="mt-3 text-xs"
              style={{ color: "var(--wp-text-dim)" }}
            >
              Generated at {data.generated_at}
            </div>
          </Section>
        </>
      )}

      {!data && loading && (
        <div className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
          Running diagnostics...
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="mb-6 p-4 rounded"
      style={{
        background: "var(--wp-dark-surface)",
        border: "1px solid var(--wp-dark-border)",
      }}
    >
      <h2
        className="text-sm font-bold uppercase tracking-wide mb-3"
        style={{ color: "var(--wp-text-dim)" }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
