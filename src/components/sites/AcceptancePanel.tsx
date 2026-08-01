"use client";

/**
 * AcceptancePanel — the contract this build is judged against, and how it did.
 *
 * This is the surface that replaces "open the preview, compare it to the
 * prototype by eye, describe the difference in a message". The left half is the
 * contract as a form: a prototype URL, the routes that must answer, the phrases
 * that must appear, the pixel tolerance. The right half is what the machine
 * found the last time a deploy finished.
 *
 * Two things the UI must never do, because both would undo the point of the
 * layer:
 *
 *   - Show a degraded run as anything like a pass. "Could not check" gets its
 *     own status and its own colour, and it reads as not accepted.
 *   - Show an empty history as reassurance. No runs yet means nobody has
 *     checked, which is stated in those words.
 *
 * Every call goes through fetchWithRefresh (raw fetch from a client component
 * is what caused the April 16 blank-dashboard incident).
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

export interface AcceptanceCriteriaView {
  prototypeUrl: string | null;
  viewports: { width: number; height: number }[];
  tolerancePx: number;
  requiredRoutes: string[];
  requiredContent: string[];
  requireFontParity: boolean;
  maxLayoutDiffs: number;
}

export interface AcceptanceCheckView {
  id: string;
  status: "passed" | "failed" | "skipped" | "unmeasured";
  detail: string;
}

export interface AcceptanceRunView {
  id: string;
  deploy_id: string;
  deployed_url: string | null;
  status: "queued" | "running" | "passed" | "failed" | "degraded";
  verdict: { accepted: boolean; summary: string; checks: AcceptanceCheckView[] } | null;
  last_error: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<AcceptanceRunView["status"], string> = {
  queued: "Waiting to be checked",
  running: "Checking",
  passed: "Accepted",
  failed: "Not accepted",
  // Deliberately not "warning". A check that did not run tells you nothing
  // about the build, so it reads as the absence of a pass, not a soft one.
  degraded: "Could not be checked",
};

const CHECK_LABEL: Record<string, string> = {
  routes: "Pages respond",
  content: "Required content present",
  layout: "Matches the prototype",
  font: "Typeface matches",
};

export interface AcceptancePanelProps {
  siteId: string;
  /** Fired for analytics; the page owns the transport. */
  onAnalytics?: (event: string, metadata: Record<string, string | number | boolean>) => void;
}

export default function AcceptancePanel({ siteId, onAnalytics }: AcceptancePanelProps) {
  const [criteria, setCriteria] = useState<AcceptanceCriteriaView | null>(null);
  const [configured, setConfigured] = useState(false);
  const [runs, setRuns] = useState<AcceptanceRunView[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithRefresh(`/api/sites/${siteId}/acceptance`);
      if (!res.ok) throw new Error(`could not load acceptance (${res.status})`);
      const data = await res.json();
      setCriteria(data.criteria);
      setConfigured(Boolean(data.configured));
      setRuns(Array.isArray(data.runs) ? data.runs : []);
      setError(null);
    } catch (err) {
      // An unreadable contract is stated, never swallowed into an empty form
      // that would look like "nothing is required".
      setError(err instanceof Error ? err.message : "could not load acceptance");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (!criteria) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetchWithRefresh(`/api/sites/${siteId}/acceptance`, {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({ criteria }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The API refuses by field, so show the field rather than a generic
        // failure the operator cannot act on.
        setError(data?.field ? `${data.field}: ${data.error}` : (data?.error ?? "could not save"));
        return;
      }
      setCriteria(data.criteria);
      setConfigured(true);
      setError(null);
      setSaved(true);
      onAnalytics?.("site.acceptance_criteria_saved", { site_id: siteId });
    } finally {
      setSaving(false);
    }
  }

  const update = (patch: Partial<AcceptanceCriteriaView>) => {
    setSaved(false);
    setCriteria((c) => (c ? { ...c, ...patch } : c));
  };

  if (loading) return <p data-testid="acceptance-loading">Loading acceptance criteria…</p>;

  if (error && !criteria) {
    return (
      <p role="alert" data-testid="acceptance-error">
        {error}
      </p>
    );
  }

  const latest = runs[0] ?? null;

  return (
    <div data-testid="acceptance-panel">
      <h3>Acceptance criteria</h3>
      <p>
        What this build has to be true of before it counts as done. It is checked automatically against the deployed
        URL every time a deploy finishes.
      </p>

      {!configured && (
        <p role="status" data-testid="acceptance-unconfigured">
          Nobody has set criteria for this site yet. The defaults below are what will be enforced until you do.
        </p>
      )}

      {criteria && (
        <div>
          <label htmlFor="acceptance-prototype">Prototype URL</label>
          <input
            id="acceptance-prototype"
            data-testid="acceptance-prototype"
            value={criteria.prototypeUrl ?? ""}
            placeholder="https://prototype.example.com/home.html"
            onChange={(e) => update({ prototypeUrl: e.target.value || null })}
          />
          <p>The page this build is measured against, element by element. Leave it empty if there is no prototype.</p>

          <label htmlFor="acceptance-routes">Pages that must load</label>
          <input
            id="acceptance-routes"
            data-testid="acceptance-routes"
            value={criteria.requiredRoutes.join(", ")}
            onChange={(e) => update({ requiredRoutes: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          />
          <p>Paths, comma separated. Each must answer 2xx, so a redirect to a login counts as a failure.</p>

          <label htmlFor="acceptance-content">Text that must appear</label>
          <input
            id="acceptance-content"
            data-testid="acceptance-content"
            value={criteria.requiredContent.join(", ")}
            onChange={(e) => update({ requiredContent: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
          />

          <label htmlFor="acceptance-tolerance">Pixel tolerance</label>
          <input
            id="acceptance-tolerance"
            data-testid="acceptance-tolerance"
            type="number"
            min={0}
            step={0.5}
            value={criteria.tolerancePx}
            onChange={(e) => update({ tolerancePx: Number(e.target.value) })}
          />

          <label htmlFor="acceptance-max-diffs">Differences allowed</label>
          <input
            id="acceptance-max-diffs"
            data-testid="acceptance-max-diffs"
            type="number"
            min={0}
            value={criteria.maxLayoutDiffs}
            onChange={(e) => update({ maxLayoutDiffs: Number(e.target.value) })}
          />

          <label>
            <input
              type="checkbox"
              data-testid="acceptance-font-parity"
              checked={criteria.requireFontParity}
              onChange={(e) => update({ requireFontParity: e.target.checked })}
            />
            The build must serve the prototype&apos;s typeface
          </label>

          <button type="button" data-testid="acceptance-save" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save criteria"}
          </button>
          {saved && (
            <span role="status" data-testid="acceptance-saved">
              Saved
            </span>
          )}
          {error && (
            <p role="alert" data-testid="acceptance-error">
              {error}
            </p>
          )}
        </div>
      )}

      <h3>Result of the last check</h3>
      {!latest ? (
        <p role="status" data-testid="acceptance-no-runs">
          This build has not been checked yet. Nothing here has been verified.
        </p>
      ) : (
        <div data-testid="acceptance-latest">
          <p data-testid="acceptance-latest-status">{STATUS_LABEL[latest.status]}</p>
          <p data-testid="acceptance-latest-summary">{latest.verdict?.summary ?? latest.last_error ?? "No detail recorded."}</p>
          <ul>
            {(latest.verdict?.checks ?? []).map((c) => (
              <li key={c.id} data-testid={`acceptance-check-${c.id}`}>
                <strong>{CHECK_LABEL[c.id] ?? c.id}</strong>: {c.status} — {c.detail}
              </li>
            ))}
          </ul>
          {latest.deployed_url && (
            <a href={latest.deployed_url} target="_blank" rel="noreferrer" data-testid="acceptance-deployed-url">
              Open the build that was checked
            </a>
          )}
        </div>
      )}

      {runs.length > 1 && (
        <>
          <h3>Earlier checks</h3>
          <ul data-testid="acceptance-history">
            {runs.slice(1).map((r) => (
              <li key={r.id}>
                {STATUS_LABEL[r.status]} — {new Date(r.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
