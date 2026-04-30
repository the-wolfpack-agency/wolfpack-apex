"use client";

/**
 * /qr — QR generator + tracker.
 *
 * Lets the team mint short-link QR codes (slug → target URL) that they
 * can print on physical assets, and view per-code scan analytics.
 *
 * The slug never changes once minted — editing a code only updates its
 * target URL. That means a printed billboard never has to be reprinted
 * when the marketing landing page moves; the QR keeps working forever
 * (or until the team archives it).
 *
 * Auth: redirects unauthenticated visitors to /login?next=/qr BEFORE
 * rendering, per the dashboard convention. We never render an empty
 * 200 page when the user has no token.
 *
 * Charts: hand-rolled inline SVG/HTML — no Recharts dependency.
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchWithRefresh,
  jsonHeaders,
  getInstinctToken,
} from "@/lib/client-auth";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface QrCode {
  id: string;
  slug: string;
  targetUrl: string;
  label: string | null;
  utmCampaign: string | null;
  expiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  createdByUserId: string | null;
  createdByUserRole: string | null;
}

interface CreateResponse {
  code: QrCode;
  qrSvg: string;
  shortUrl: string;
  fullRedirectUrl: string;
}

interface QrAnalytics {
  total_scans: number;
  unique_visitors: number;
  blocked_scans: number;
  last_scanned_at: string | null;
  by_day: Array<{ day: string; count: number }>;
  by_country: Array<{ country: string; count: number }>;
  by_device: Array<{ device: string; count: number }>;
  by_browser: Array<{ browser: string; count: number }>;
  by_os?: Array<{ os: string; count: number }>;
  by_hour: Array<{ hour: number; count: number }>;
  top_referrers: Array<{ referrer: string; count: number }>;
  recent: Array<{
    scanned_at: string;
    country: string | null;
    device: string | null;
    browser: string | null;
    referrer: string | null;
  }>;
}

interface RowState {
  expanded: boolean;
  loadingAnalytics: boolean;
  analyticsError: string | null;
  analytics: QrAnalytics | null;
  scanCount: number | null; // lazy badge
  editing: boolean;
  editTargetUrl: string;
  savingEdit: boolean;
  editError: string | null;
  /* Cached SVG for non-newly-created codes (re-rendered client-side
     from a tiny lib so we don't need a server roundtrip). New codes
     keep the SVG returned by POST. Map keyed by code id. */
  qrSvg: string | null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function slugifyForUtm(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  window.location.href = "/login?next=/qr";
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function truncate(s: string, n = 56): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/* ------------------------------------------------------------------ */
/* Mini-chart components — all inline, zero deps                       */
/* ------------------------------------------------------------------ */

function LineChart({ data }: { data: Array<{ day: string; count: number }> }) {
  if (!data.length) {
    return (
      <div
        data-testid="qr-line-chart-empty"
        style={{ color: "var(--wp-text-muted)", fontSize: "0.85rem" }}
      >
        No scans in the last 30 days yet.
      </div>
    );
  }
  const w = 600;
  const h = 140;
  const pad = 24;
  const max = Math.max(1, ...data.map((d) => d.count));
  const stepX = data.length > 1 ? (w - pad * 2) / (data.length - 1) : 0;
  const points = data.map((d, i) => {
    const x = pad + i * stepX;
    const y = h - pad - (d.count / max) * (h - pad * 2);
    return { x, y, ...d };
  });
  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");
  return (
    <svg
      data-testid="qr-line-chart"
      role="img"
      aria-label="Scans over time"
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: "100%", height: "auto", maxHeight: 180 }}
    >
      <line
        x1={pad}
        y1={h - pad}
        x2={w - pad}
        y2={h - pad}
        stroke="var(--wp-dark-border)"
        strokeWidth={1}
      />
      <polyline
        fill="none"
        stroke="var(--wp-gold)"
        strokeWidth={2}
        points={polyline}
      />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={2.5}
          fill="var(--wp-gold)"
          data-testid="qr-line-chart-dot"
        >
          <title>{`${p.day}: ${p.count}`}</title>
        </circle>
      ))}
    </svg>
  );
}

function BarList({
  data,
  testId,
  labelKey,
}: {
  data: Array<Record<string, string | number>>;
  testId: string;
  labelKey: string;
}) {
  if (!data.length) {
    return (
      <div
        data-testid={`${testId}-empty`}
        style={{ color: "var(--wp-text-muted)", fontSize: "0.8rem" }}
      >
        No data yet.
      </div>
    );
  }
  const max = Math.max(1, ...data.map((d) => Number(d.count) || 0));
  return (
    <div data-testid={testId} style={{ display: "grid", gap: 4 }}>
      {data.slice(0, 10).map((d, i) => {
        const label = String(d[labelKey] ?? "—") || "—";
        const count = Number(d.count) || 0;
        const pct = (count / max) * 100;
        return (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns: "5.5rem 1fr 2.5rem",
              gap: 6,
              alignItems: "center",
              fontSize: "0.75rem",
            }}
          >
            <div
              style={{
                color: "var(--wp-text-dim)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={label}
            >
              {label}
            </div>
            <div
              style={{
                background: "var(--wp-dark-border)",
                borderRadius: 3,
                height: 8,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: "var(--wp-gold)",
                }}
              />
            </div>
            <div
              style={{
                color: "var(--wp-text)",
                textAlign: "right",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {count}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HourHeatmap({
  data,
}: {
  data: Array<{ hour: number; count: number }>;
}) {
  /* Normalise to 24 buckets so missing hours show empty cells. */
  const buckets: number[] = Array.from({ length: 24 }, () => 0);
  for (const d of data) {
    if (Number.isFinite(d.hour) && d.hour >= 0 && d.hour < 24) {
      buckets[d.hour] = d.count;
    }
  }
  const max = Math.max(1, ...buckets);
  return (
    <div
      data-testid="qr-hour-heatmap"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(24, minmax(0, 1fr))",
        gap: 2,
      }}
    >
      {buckets.map((count, h) => {
        const intensity = count / max; // 0..1
        const bg =
          count === 0
            ? "var(--wp-dark-border)"
            : `rgba(212, 168, 87, ${0.15 + intensity * 0.85})`;
        return (
          <div
            key={h}
            data-testid="qr-hour-cell"
            title={`${h.toString().padStart(2, "0")}:00 — ${count} scan${count === 1 ? "" : "s"}`}
            style={{
              aspectRatio: "1 / 1",
              background: bg,
              borderRadius: 2,
              fontSize: "0.55rem",
              color: "var(--wp-text-dim)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {h % 6 === 0 ? h : ""}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section card                                                        */
/* ------------------------------------------------------------------ */

function SectionCard({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border p-5"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <h2
        className="text-sm font-semibold mb-4"
        style={{ color: "var(--wp-gold)" }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function QrPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [codes, setCodes] = useState<QrCode[]>([]);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  /* Form state */
  const [label, setLabel] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [utmCampaign, setUtmCampaign] = useState("");
  const [utmTouched, setUtmTouched] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  /* Most-recently created code surface (so the user sees their SVG
     immediately above the list with a copy button). */
  const [latestCreated, setLatestCreated] = useState<CreateResponse | null>(
    null,
  );

  /* ── auth gate ────────────────────────────────────────────────── */
  useEffect(() => {
    if (!getInstinctToken()) {
      rerouteToLogin();
      return;
    }
    setAuthChecked(true);
  }, []);

  /* ── initial list ─────────────────────────────────────────────── */
  const loadList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await fetchWithRefresh("/api/qr");
      if (!res.ok) {
        setListError("We couldn't load your QR codes. Please refresh.");
        return;
      }
      const data = (await res.json()) as { codes: QrCode[] };
      setCodes(Array.isArray(data.codes) ? data.codes : []);
    } catch (err) {
      setListError(`Failed to load QR codes: ${(err as Error).message}`);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    void loadList();
  }, [authChecked, loadList]);

  /* ── create ───────────────────────────────────────────────────── */
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!targetUrl.trim()) {
      setCreateError("Target URL is required.");
      return;
    }
    setSubmitting(true);
    setCreateError(null);
    try {
      const body: Record<string, string> = { targetUrl: targetUrl.trim() };
      if (label.trim()) body.label = label.trim();
      const finalUtm = utmTouched
        ? utmCampaign.trim()
        : utmCampaign.trim() || (label.trim() ? slugifyForUtm(label) : "");
      if (finalUtm) body.utmCampaign = finalUtm;
      if (expiresAt) {
        /* HTML date input gives us YYYY-MM-DD; treat as end-of-day UTC
           so a printed code stays live through the chosen date. */
        body.expiresAt = `${expiresAt}T23:59:59Z`;
      }
      const res = await fetchWithRefresh("/api/qr", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setCreateError(errBody.error ?? "Failed to create QR code.");
        return;
      }
      const data = (await res.json()) as CreateResponse;
      setLatestCreated(data);
      setCodes((prev) => [data.code, ...prev]);
      setRowStates((prev) => ({
        ...prev,
        [data.code.id]: {
          expanded: false,
          loadingAnalytics: false,
          analyticsError: null,
          analytics: null,
          scanCount: 0,
          editing: false,
          editTargetUrl: data.code.targetUrl,
          savingEdit: false,
          editError: null,
          qrSvg: data.qrSvg,
        },
      }));
      /* Reset the form for the next code. */
      setLabel("");
      setTargetUrl("");
      setUtmCampaign("");
      setUtmTouched(false);
      setExpiresAt("");
    } catch (err) {
      setCreateError(`Network error: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  /* ── row helpers ──────────────────────────────────────────────── */
  function getRow(id: string): RowState {
    return (
      rowStates[id] ?? {
        expanded: false,
        loadingAnalytics: false,
        analyticsError: null,
        analytics: null,
        scanCount: null,
        editing: false,
        editTargetUrl: "",
        savingEdit: false,
        editError: null,
        qrSvg: null,
      }
    );
  }

  function patchRow(id: string, patch: Partial<RowState>) {
    setRowStates((prev) => {
      const current =
        prev[id] ?? {
          expanded: false,
          loadingAnalytics: false,
          analyticsError: null,
          analytics: null,
          scanCount: null,
          editing: false,
          editTargetUrl: "",
          savingEdit: false,
          editError: null,
          qrSvg: null,
        };
      return {
        ...prev,
        [id]: { ...current, ...patch },
      };
    });
  }

  async function loadAnalytics(code: QrCode) {
    patchRow(code.id, {
      loadingAnalytics: true,
      analyticsError: null,
    });
    try {
      const res = await fetchWithRefresh(
        `/api/qr/${encodeURIComponent(code.id)}/analytics`,
      );
      if (!res.ok) {
        patchRow(code.id, {
          loadingAnalytics: false,
          analyticsError: "Failed to load analytics.",
        });
        return;
      }
      const data = (await res.json()) as QrAnalytics;
      patchRow(code.id, {
        loadingAnalytics: false,
        analytics: data,
        scanCount: data.total_scans ?? 0,
      });
    } catch (err) {
      patchRow(code.id, {
        loadingAnalytics: false,
        analyticsError: `Network error: ${(err as Error).message}`,
      });
    }
  }

  function toggleAnalytics(code: QrCode) {
    const row = getRow(code.id);
    const next = !row.expanded;
    patchRow(code.id, { expanded: next });
    if (next && !row.analytics && !row.loadingAnalytics) {
      void loadAnalytics(code);
    }
  }

  async function copyShort(code: QrCode) {
    const base =
      typeof window !== "undefined" ? window.location.origin : "";
    const href = `${base}/q/${code.slug}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(href);
      }
    } catch {
      /* clipboard blocked — silently no-op. The href is visible inline
         already, so the user can long-press to copy. */
    }
  }

  function downloadSvg(svg: string, slug: string) {
    if (typeof window === "undefined") return;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qr-${slug}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function saveEdit(code: QrCode) {
    const row = getRow(code.id);
    if (!row.editTargetUrl.trim()) {
      patchRow(code.id, { editError: "Target URL is required." });
      return;
    }
    patchRow(code.id, { savingEdit: true, editError: null });
    try {
      const res = await fetchWithRefresh(
        `/api/qr/${encodeURIComponent(code.id)}`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify({ targetUrl: row.editTargetUrl.trim() }),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        patchRow(code.id, {
          savingEdit: false,
          editError: errBody.error ?? "Failed to update destination.",
        });
        return;
      }
      const data = (await res.json()) as { code: QrCode };
      setCodes((prev) =>
        prev.map((c) => (c.id === code.id ? data.code : c)),
      );
      patchRow(code.id, {
        savingEdit: false,
        editing: false,
        editError: null,
        editTargetUrl: data.code.targetUrl,
      });
    } catch (err) {
      patchRow(code.id, {
        savingEdit: false,
        editError: `Network error: ${(err as Error).message}`,
      });
    }
  }

  async function archiveCode(code: QrCode) {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `Archive "${code.label || code.slug}"? Scanners hitting this QR will be redirected to the "no longer active" page. This can't be undone from the UI.`,
      );
      if (!ok) return;
    }
    try {
      const res = await fetchWithRefresh(
        `/api/qr/${encodeURIComponent(code.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) return;
      setCodes((prev) => prev.filter((c) => c.id !== code.id));
    } catch {
      /* swallow — UI stays as-is on failure. */
    }
  }

  /* ── render ───────────────────────────────────────────────────── */

  if (!authChecked) {
    return (
      <div data-testid="qr-page-loading" style={{ color: "var(--wp-text-dim)" }}>
        Loading…
      </div>
    );
  }

  return (
    <div data-testid="qr-page" style={{ display: "grid", gap: "1.5rem" }}>
      <header>
        <h1
          className="text-2xl font-bold mb-1"
          style={{ color: "var(--wp-gold)" }}
        >
          QR Codes — generate, share, track
        </h1>
        <p
          style={{
            color: "var(--wp-text-dim)",
            fontSize: "0.875rem",
            margin: 0,
          }}
        >
          Mint short-link QR codes for billboards, business cards, and
          handouts. Edit the destination anytime — the printed QR keeps
          working.
        </p>
      </header>

      {/* ── Create form ─────────────────────────────────────────── */}
      <SectionCard title="Create new code" testId="qr-create-section">
        <form
          data-testid="qr-create-form"
          onSubmit={handleCreate}
          style={{ display: "grid", gap: "0.75rem" }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.75rem",
            }}
          >
            <label style={{ display: "grid", gap: 4 }}>
              <span
                style={{
                  fontSize: "0.75rem",
                  color: "var(--wp-text-dim)",
                }}
              >
                Label (optional)
              </span>
              <input
                data-testid="qr-create-label"
                type="text"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  if (!utmTouched) {
                    setUtmCampaign(slugifyForUtm(e.target.value));
                  }
                }}
                placeholder="Spring brochure"
                style={inputStyle}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span
                style={{
                  fontSize: "0.75rem",
                  color: "var(--wp-text-dim)",
                }}
              >
                UTM campaign (optional)
              </span>
              <input
                data-testid="qr-create-utm"
                type="text"
                value={utmCampaign}
                onChange={(e) => {
                  setUtmCampaign(e.target.value);
                  setUtmTouched(true);
                }}
                placeholder="spring-brochure"
                style={inputStyle}
              />
            </label>
          </div>
          <label style={{ display: "grid", gap: 4 }}>
            <span
              style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}
            >
              Target URL <span style={{ color: "var(--wp-error)" }}>*</span>
            </span>
            <input
              data-testid="qr-create-target-url"
              type="url"
              required
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="https://example.com/landing"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 4, maxWidth: 240 }}>
            <span
              style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}
            >
              Expires (optional)
            </span>
            <input
              data-testid="qr-create-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              style={inputStyle}
            />
          </label>
          {createError ? (
            <div
              data-testid="qr-create-error"
              style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}
            >
              {createError}
            </div>
          ) : null}
          <div>
            <button
              data-testid="qr-create-submit"
              type="submit"
              disabled={submitting}
              style={{
                background: "var(--wp-gold)",
                color: "#000",
                border: "none",
                padding: "0.55rem 1rem",
                borderRadius: 6,
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? "Creating…" : "Create QR code"}
            </button>
          </div>
        </form>

        {latestCreated ? (
          <div
            data-testid="qr-latest-created"
            style={{
              marginTop: "1.25rem",
              padding: "1rem",
              border: "1px solid var(--wp-dark-border)",
              borderRadius: 8,
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "1rem",
              alignItems: "start",
            }}
          >
            <div
              data-testid="qr-latest-svg"
              style={{
                background: "#fff",
                padding: 8,
                borderRadius: 6,
                width: 132,
                height: 132,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              dangerouslySetInnerHTML={{ __html: latestCreated.qrSvg }}
            />
            <div style={{ display: "grid", gap: 6, fontSize: "0.85rem" }}>
              <div style={{ color: "var(--wp-success)" }}>
                Created — slug{" "}
                <code style={{ color: "var(--wp-gold)" }}>
                  {latestCreated.code.slug}
                </code>
              </div>
              <div style={{ color: "var(--wp-text-dim)", wordBreak: "break-all" }}>
                {latestCreated.fullRedirectUrl || latestCreated.shortUrl}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                  data-testid="qr-latest-copy"
                  type="button"
                  onClick={() => copyShort(latestCreated.code)}
                  style={btnSecondary}
                >
                  Copy short link
                </button>
                <button
                  data-testid="qr-latest-download"
                  type="button"
                  onClick={() =>
                    downloadSvg(latestCreated.qrSvg, latestCreated.code.slug)
                  }
                  style={btnSecondary}
                >
                  Download SVG
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </SectionCard>

      {/* ── List ────────────────────────────────────────────────── */}
      <SectionCard title="Your QR codes" testId="qr-list-section">
        {loadingList ? (
          <div
            data-testid="qr-list-loading"
            style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}
          >
            Loading codes…
          </div>
        ) : listError ? (
          <div
            data-testid="qr-list-error"
            style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}
          >
            {listError}
          </div>
        ) : codes.length === 0 ? (
          <div
            data-testid="qr-list-empty"
            style={{ color: "var(--wp-text-muted)", fontSize: "0.9rem" }}
          >
            No codes yet — create your first one above.
          </div>
        ) : (
          <div data-testid="qr-list" style={{ display: "grid", gap: "0.5rem" }}>
            {codes.map((c) => {
              const row = getRow(c.id);
              return (
                <div
                  key={c.id}
                  data-testid={`qr-row-${c.slug}`}
                  style={{
                    border: "1px solid var(--wp-dark-border)",
                    borderRadius: 8,
                    padding: "0.85rem 1rem",
                    background: "var(--wp-dark-surface)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.75rem",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: "1 1 60%" }}>
                      <div
                        style={{
                          color: "var(--wp-text)",
                          fontWeight: 600,
                          fontSize: "0.9rem",
                        }}
                      >
                        {c.label || (
                          <span style={{ color: "var(--wp-text-muted)" }}>
                            (untitled)
                          </span>
                        )}{" "}
                        <span
                          style={{
                            color: "var(--wp-gold)",
                            fontFamily: "monospace",
                            fontWeight: 500,
                            marginLeft: 4,
                          }}
                          data-testid={`qr-row-slug-${c.slug}`}
                        >
                          /q/{c.slug}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--wp-text-dim)",
                          marginTop: 2,
                          wordBreak: "break-all",
                        }}
                        title={c.targetUrl}
                      >
                        → {truncate(c.targetUrl)}
                      </div>
                      <div
                        style={{
                          fontSize: "0.7rem",
                          color: "var(--wp-text-muted)",
                          marginTop: 2,
                        }}
                      >
                        Created {formatDate(c.createdAt)}
                        {c.expiresAt ? ` · Expires ${formatDate(c.expiresAt)}` : ""}
                        {c.utmCampaign ? ` · UTM ${c.utmCampaign}` : ""}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      {row.scanCount !== null ? (
                        <span
                          data-testid={`qr-row-scancount-${c.slug}`}
                          style={{
                            fontSize: "0.7rem",
                            padding: "2px 8px",
                            borderRadius: 999,
                            background: "var(--wp-dark-border)",
                            color: "var(--wp-text)",
                          }}
                        >
                          {row.scanCount} scan{row.scanCount === 1 ? "" : "s"}
                        </span>
                      ) : null}
                      <button
                        data-testid={`qr-row-copy-${c.slug}`}
                        type="button"
                        onClick={() => copyShort(c)}
                        style={btnSecondary}
                      >
                        Copy
                      </button>
                      <button
                        data-testid={`qr-row-edit-${c.slug}`}
                        type="button"
                        onClick={() =>
                          patchRow(c.id, {
                            editing: !row.editing,
                            editTargetUrl: c.targetUrl,
                            editError: null,
                          })
                        }
                        style={btnSecondary}
                      >
                        {row.editing ? "Cancel" : "Edit destination"}
                      </button>
                      <button
                        data-testid={`qr-row-analytics-${c.slug}`}
                        type="button"
                        onClick={() => toggleAnalytics(c)}
                        style={btnSecondary}
                      >
                        {row.expanded ? "Hide analytics" : "View analytics"}
                      </button>
                      <button
                        data-testid={`qr-row-archive-${c.slug}`}
                        type="button"
                        onClick={() => archiveCode(c)}
                        style={{
                          ...btnSecondary,
                          color: "var(--wp-error)",
                          borderColor: "var(--wp-error)",
                        }}
                      >
                        Archive
                      </button>
                    </div>
                  </div>

                  {row.editing ? (
                    <div
                      data-testid={`qr-row-edit-form-${c.slug}`}
                      style={{
                        marginTop: 10,
                        padding: 10,
                        border: "1px solid var(--wp-dark-border)",
                        borderRadius: 6,
                      }}
                    >
                      <div
                        style={{
                          fontSize: "0.7rem",
                          color: "var(--wp-text-dim)",
                          marginBottom: 6,
                        }}
                      >
                        The slug stays <code>/q/{c.slug}</code> — anything
                        already printed keeps working.
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <input
                          data-testid={`qr-row-edit-input-${c.slug}`}
                          type="url"
                          value={row.editTargetUrl}
                          onChange={(e) =>
                            patchRow(c.id, { editTargetUrl: e.target.value })
                          }
                          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
                        />
                        <button
                          data-testid={`qr-row-edit-save-${c.slug}`}
                          type="button"
                          disabled={row.savingEdit}
                          onClick={() => saveEdit(c)}
                          style={{
                            ...btnSecondary,
                            background: "var(--wp-gold)",
                            color: "#000",
                            borderColor: "var(--wp-gold)",
                            opacity: row.savingEdit ? 0.6 : 1,
                          }}
                        >
                          {row.savingEdit ? "Saving…" : "Save"}
                        </button>
                      </div>
                      {row.editError ? (
                        <div
                          style={{
                            color: "var(--wp-error)",
                            fontSize: "0.75rem",
                            marginTop: 6,
                          }}
                        >
                          {row.editError}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {row.expanded ? (
                    <div
                      data-testid={`qr-row-analytics-panel-${c.slug}`}
                      style={{
                        marginTop: 12,
                        padding: 12,
                        border: "1px solid var(--wp-dark-border)",
                        borderRadius: 6,
                        display: "grid",
                        gap: 14,
                      }}
                    >
                      {row.loadingAnalytics ? (
                        <div
                          data-testid={`qr-analytics-loading-${c.slug}`}
                          style={{ color: "var(--wp-text-dim)" }}
                        >
                          Loading analytics…
                        </div>
                      ) : row.analyticsError ? (
                        <div
                          data-testid={`qr-analytics-error-${c.slug}`}
                          style={{ color: "var(--wp-error)" }}
                        >
                          {row.analyticsError}
                        </div>
                      ) : row.analytics ? (
                        <AnalyticsPanel a={row.analytics} />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Analytics panel — split into a sub-component so the row map         */
/* stays readable.                                                     */
/* ------------------------------------------------------------------ */

function AnalyticsPanel({ a }: { a: QrAnalytics }) {
  return (
    <>
      {/* KPIs */}
      <div
        data-testid="qr-analytics-kpis"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
        }}
      >
        <KPI label="Total scans" value={a.total_scans} testId="qr-kpi-total" />
        <KPI
          label="Unique visitors"
          value={a.unique_visitors}
          testId="qr-kpi-unique"
        />
        <KPI
          label="Blocked"
          value={a.blocked_scans}
          testId="qr-kpi-blocked"
        />
        <KPI
          label="Last scan"
          value={a.last_scanned_at ? formatDate(a.last_scanned_at) : "—"}
          testId="qr-kpi-last"
        />
      </div>

      {/* Daily line chart */}
      <div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--wp-text-dim)",
            marginBottom: 4,
          }}
        >
          Scans over the last 30 days
        </div>
        <LineChart data={a.by_day ?? []} />
      </div>

      {/* 3 bar charts */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--wp-text-dim)",
              marginBottom: 4,
            }}
          >
            By country (top 10)
          </div>
          <BarList
            data={
              (a.by_country ?? []) as unknown as Array<
                Record<string, string | number>
              >
            }
            testId="qr-bar-country"
            labelKey="country"
          />
        </div>
        <div>
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--wp-text-dim)",
              marginBottom: 4,
            }}
          >
            By device
          </div>
          <BarList
            data={
              (a.by_device ?? []) as unknown as Array<
                Record<string, string | number>
              >
            }
            testId="qr-bar-device"
            labelKey="device"
          />
        </div>
        <div>
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--wp-text-dim)",
              marginBottom: 4,
            }}
          >
            By browser
          </div>
          <BarList
            data={
              (a.by_browser ?? []) as unknown as Array<
                Record<string, string | number>
              >
            }
            testId="qr-bar-browser"
            labelKey="browser"
          />
        </div>
      </div>

      {/* Hour heatmap */}
      <div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--wp-text-dim)",
            marginBottom: 4,
          }}
        >
          Scans by hour of day (0–23)
        </div>
        <HourHeatmap data={a.by_hour ?? []} />
      </div>

      {/* Top referrers */}
      <div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--wp-text-dim)",
            marginBottom: 4,
          }}
        >
          Top referrers
        </div>
        {(a.top_referrers ?? []).length === 0 ? (
          <div
            data-testid="qr-top-referrers-empty"
            style={{ color: "var(--wp-text-muted)", fontSize: "0.8rem" }}
          >
            No referrer data yet.
          </div>
        ) : (
          <ul
            data-testid="qr-top-referrers"
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              fontSize: "0.8rem",
              color: "var(--wp-text-dim)",
            }}
          >
            {a.top_referrers.slice(0, 8).map((r, i) => (
              <li
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "2px 0",
                  borderBottom: "1px dashed var(--wp-dark-border)",
                }}
              >
                <span
                  title={r.referrer}
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: "70%",
                  }}
                >
                  {r.referrer || "(direct)"}
                </span>
                <span style={{ color: "var(--wp-text)" }}>{r.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recent scans */}
      <div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--wp-text-dim)",
            marginBottom: 4,
          }}
        >
          Recent scans (last 20)
        </div>
        {(a.recent ?? []).length === 0 ? (
          <div
            data-testid="qr-recent-empty"
            style={{ color: "var(--wp-text-muted)", fontSize: "0.8rem" }}
          >
            No scans yet.
          </div>
        ) : (
          <table
            data-testid="qr-recent-table"
            style={{
              width: "100%",
              fontSize: "0.75rem",
              borderCollapse: "collapse",
              color: "var(--wp-text-dim)",
            }}
          >
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={thStyle}>When</th>
                <th style={thStyle}>Country</th>
                <th style={thStyle}>Device</th>
                <th style={thStyle}>Browser</th>
                <th style={thStyle}>Referrer</th>
              </tr>
            </thead>
            <tbody>
              {a.recent.slice(0, 20).map((r, i) => (
                <tr key={i}>
                  <td style={tdStyle}>{formatDate(r.scanned_at)}</td>
                  <td style={tdStyle}>{r.country || "—"}</td>
                  <td style={tdStyle}>{r.device || "—"}</td>
                  <td style={tdStyle}>{r.browser || "—"}</td>
                  <td
                    style={{
                      ...tdStyle,
                      maxWidth: 200,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={r.referrer || ""}
                  >
                    {r.referrer || "(direct)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function KPI({
  label,
  value,
  testId,
}: {
  label: string;
  value: string | number;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        background: "var(--wp-dark-border)",
        borderRadius: 6,
        padding: "8px 10px",
      }}
    >
      <div
        style={{
          fontSize: "0.65rem",
          color: "var(--wp-text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "1.1rem",
          fontWeight: 600,
          color: "var(--wp-text)",
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/* ── styles ──────────────────────────────────────────────────────── */

const inputStyle: React.CSSProperties = {
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-dark-border)",
  color: "var(--wp-text)",
  borderRadius: 6,
  padding: "0.45rem 0.6rem",
  fontSize: "0.85rem",
};

const btnSecondary: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--wp-dark-border)",
  color: "var(--wp-text)",
  padding: "0.35rem 0.7rem",
  borderRadius: 6,
  fontSize: "0.75rem",
  cursor: "pointer",
};

const thStyle: React.CSSProperties = {
  borderBottom: "1px solid var(--wp-dark-border)",
  padding: "4px 6px",
  fontWeight: 500,
  color: "var(--wp-text-muted)",
};

const tdStyle: React.CSSProperties = {
  borderBottom: "1px dashed var(--wp-dark-border)",
  padding: "4px 6px",
};
