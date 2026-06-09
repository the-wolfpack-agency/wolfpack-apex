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
 *
 * Apr 30, 2026: per-scan attribution detail panel ("View all scans")
 * surfaces every column captured by migrations 110+112 — country,
 * region, city, postal, lat/lng (with map link), language, UTMs from
 * the incoming URL, bot/blocked flags, the matched-client name (if
 * the heuristic in scans.ts.matchClient correlated geo/referrer to
 * an instinct_clients row), and the visitor_hash so repeat scans are
 * recognisable. Sortable columns + group-by-visitor toggle.
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchWithRefresh,
  jsonHeaders,
  getInstinctToken,
} from "@/lib/client-auth";
import { downloadQr, QR_FORMATS, type QrFormat } from "./download";

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

/* One row per scan, rendered in the "View all scans" detail panel.
   Mirrors `ScanRow` exported by src/lib/qr/scans.ts — kept structurally
   similar so the API contract is obvious from the UI side too. */
interface ScanDetail {
  id: string;
  scanned_at: string;
  visitor_hash: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  postal_code: string | null;
  latitude: string | null;
  longitude: string | null;
  device: string | null;
  os: string | null;
  browser: string | null;
  language: string | null;
  timezone_offset_minutes: number | null;
  screen_size: string | null;
  is_bot: boolean;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  blocked: boolean;
  client_id: string | null;
  client_match_score: number | null;
  client_name: string | null;
}

type ScanSortKey =
  | "scanned_at"
  | "country"
  | "city"
  | "device"
  | "browser"
  | "client_name";

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
  /* QR SVG for an existing (non-just-created) code. Lazily fetched
     from GET /api/qr/[id]/svg when the user clicks "Show QR". null =
     not fetched; "" = fetched-but-failed (let the user retry). */
  qrSvg: string | null;
  showingQr: boolean;
  loadingQr: boolean;
  /* All-scans detail state — lazy-loaded the first time the user opens
     the modal so we don't pay the egress for codes nobody drills into. */
  detailOpen: boolean;
  loadingDetail: boolean;
  detailError: string | null;
  scans: ScanDetail[] | null;
  scanSort: { key: ScanSortKey; dir: "asc" | "desc" };
  groupByVisitor: boolean;
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

function relativeTime(iso: string): string {
  try {
    const d = new Date(iso).getTime();
    const now = Date.now();
    const diffSec = Math.round((now - d) / 1000);
    const abs = Math.abs(diffSec);
    if (abs < 60) return `${diffSec}s ago`;
    if (abs < 3600) return `${Math.round(diffSec / 60)}m ago`;
    if (abs < 86400) return `${Math.round(diffSec / 3600)}h ago`;
    return `${Math.round(diffSec / 86400)}d ago`;
  } catch {
    return "";
  }
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

/**
 * DownloadMenu — single-line: format <select> + size <select> (raster
 * formats only) + Download button. Pure client; no analytics tokens
 * burned. Defaults to PNG @ 1024 — the size most people want for
 * print + slides without thinking.
 */
function DownloadMenu({
  testId,
  svg,
  slug,
}: {
  testId: string;
  svg: string;
  slug: string;
}) {
  const [format, setFormat] = useState<QrFormat>("png");
  const [size, setSize] = useState<number>(1024);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isRaster = format === "png" || format === "jpg";

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await downloadQr({
        svg,
        slug,
        format,
        size: isRaster ? (size as 256 | 512 | 1024 | 2048) : undefined,
      });
    } catch (e) {
      setErr((e as Error).message || "Download failed");
    }
    setBusy(false);
  }

  const selectStyle: React.CSSProperties = {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--wp-dark-border)",
    background: "var(--wp-dark-surface2)",
    color: "var(--wp-text)",
    fontSize: 12,
    /* The widest option ("PDF (printable Letter page)") is long in the
       brand font; cap each control at the container width so it wraps to
       its own line and truncates, never pushing the row past the
       viewport. */
    minWidth: 0,
    maxWidth: "100%",
    flex: "1 1 auto",
    boxSizing: "border-box",
  };

  return (
    <div data-testid={testId} style={{ display: "grid", gap: 6, maxWidth: "100%", minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxWidth: "100%", minWidth: 0 }}>
        <select
          data-testid={`${testId}-format`}
          value={format}
          onChange={(e) => setFormat(e.target.value as QrFormat)}
          style={selectStyle}
          aria-label="Download format"
        >
          {QR_FORMATS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {isRaster ? (
          <select
            data-testid={`${testId}-size`}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            style={selectStyle}
            aria-label="Image size"
          >
            <option value={256}>256 px</option>
            <option value={512}>512 px</option>
            <option value={1024}>1024 px</option>
            <option value={2048}>2048 px (print)</option>
          </select>
        ) : null}
        <button
          type="button"
          data-testid={`${testId}-go`}
          onClick={go}
          disabled={busy}
          style={{
            padding: "6px 14px",
            borderRadius: 6,
            border: "1px solid var(--wp-gold)",
            background: "var(--wp-gold)",
            color: "var(--wp-dark)",
            fontSize: 12,
            fontWeight: 600,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          {busy ? "Saving…" : "Download"}
        </button>
      </div>
      {err ? (
        <span style={{ color: "var(--wp-error)", fontSize: 11 }}>{err}</span>
      ) : null}
    </div>
  );
}

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

function defaultRowState(): RowState {
  return {
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
    showingQr: false,
    loadingQr: false,
    detailOpen: false,
    loadingDetail: false,
    detailError: null,
    scans: null,
    scanSort: { key: "scanned_at", dir: "desc" },
    groupByVisitor: false,
  };
}

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
          ...defaultRowState(),
          editTargetUrl: data.code.targetUrl,
          qrSvg: data.qrSvg,
          scanCount: 0,
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
    return rowStates[id] ?? defaultRowState();
  }

  function patchRow(id: string, patch: Partial<RowState>) {
    setRowStates((prev) => {
      const current = prev[id] ?? defaultRowState();
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

  async function loadScanDetails(code: QrCode) {
    patchRow(code.id, { loadingDetail: true, detailError: null });
    try {
      const res = await fetchWithRefresh(
        `/api/qr/${encodeURIComponent(code.id)}/scans`,
      );
      if (!res.ok) {
        patchRow(code.id, {
          loadingDetail: false,
          detailError: "Failed to load scan details.",
        });
        return;
      }
      const data = (await res.json()) as { scans: ScanDetail[] };
      patchRow(code.id, {
        loadingDetail: false,
        scans: Array.isArray(data.scans) ? data.scans : [],
      });
    } catch (err) {
      patchRow(code.id, {
        loadingDetail: false,
        detailError: `Network error: ${(err as Error).message}`,
      });
    }
  }

  function toggleScanDetail(code: QrCode) {
    const row = getRow(code.id);
    const next = !row.detailOpen;
    patchRow(code.id, { detailOpen: next });
    if (next && !row.scans && !row.loadingDetail) {
      void loadScanDetails(code);
    }
  }

  function setScanSort(codeId: string, key: ScanSortKey) {
    const row = getRow(codeId);
    if (row.scanSort.key === key) {
      patchRow(codeId, {
        scanSort: { key, dir: row.scanSort.dir === "asc" ? "desc" : "asc" },
      });
    } else {
      patchRow(codeId, { scanSort: { key, dir: "asc" } });
    }
  }

  async function toggleQr(code: QrCode) {
    const row = rowStates[code.id];
    if (row?.showingQr) {
      patchRow(code.id, { showingQr: false });
      return;
    }
    if (row?.qrSvg) {
      patchRow(code.id, { showingQr: true });
      return;
    }
    patchRow(code.id, { showingQr: true, loadingQr: true });
    try {
      const res = await fetchWithRefresh(
        `/api/qr/${encodeURIComponent(code.id)}/svg?size=192`,
      );
      if (!res.ok) {
        patchRow(code.id, { loadingQr: false, qrSvg: "" });
        return;
      }
      const svg = await res.text();
      patchRow(code.id, { loadingQr: false, qrSvg: svg });
    } catch {
      patchRow(code.id, { loadingQr: false, qrSvg: "" });
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
    <div
      data-testid="qr-page"
      style={{
        display: "grid",
        gap: "1.5rem",
        maxWidth: "100%",
        minWidth: 0,
        overflowX: "hidden",
        padding: "0 1rem",
      }}
    >
      <style jsx global>{`
        [data-testid="qr-page"] h1 {
          font-size: 1.5rem;
          line-height: 1.2;
          word-break: break-word;
          overflow-wrap: anywhere;
        }
        [data-testid="qr-page"] input,
        [data-testid="qr-page"] textarea {
          max-width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        [data-testid="qr-page"] .qr-create-grid {
          display: grid;
          gap: 0.75rem;
          grid-template-columns: 1fr 1fr;
        }
        @media (max-width: 640px) {
          [data-testid="qr-page"] {
            padding: 0 0.75rem;
          }
          [data-testid="qr-page"] h1 {
            font-size: 1.25rem;
          }
          [data-testid="qr-page"] .qr-create-grid {
            grid-template-columns: 1fr;
          }
          /* Show-QR panel: stack the SVG above the Download button on
             narrow screens. The wrapper sizing (192px capped at 100% of
             its container) is set inline on the element itself so it can
             never exceed the viewport — no rule needed here. */
          [data-testid="qr-page"] .qr-row-svg-panel {
            flex-direction: column;
            align-items: flex-start;
          }
          /* Force long slugs / URLs in row headers + edit form to wrap
             instead of pushing the row past viewport. */
          [data-testid="qr-page"] code,
          [data-testid="qr-page"] strong {
            word-break: break-all;
            overflow-wrap: anywhere;
          }
        }
      `}</style>
      <header>
        <h1
          className="text-2xl font-bold mb-1"
          style={{ color: "var(--wp-gold)" }}
        >
          QR Codes
        </h1>
        <p
          style={{
            color: "var(--wp-text-dim)",
            fontSize: "0.875rem",
            margin: 0,
          }}
        >
          Generate, share, and track. Create QR codes for posters,
          business cards, and handouts. Change the destination anytime.
          The printed code keeps working.
        </p>
      </header>

      {/* ── Create form ─────────────────────────────────────────── */}
      <SectionCard title="Create new code" testId="qr-create-section">
        <form
          data-testid="qr-create-form"
          onSubmit={handleCreate}
          style={{ display: "grid", gap: "0.75rem" }}
        >
          <div className="qr-create-grid">
            <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
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
                <DownloadMenu
                  testId="qr-latest-download"
                  svg={latestCreated.qrSvg}
                  slug={latestCreated.code.slug}
                />
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
                        /* Allow this button cluster to shrink to the
                           available width so the buttons wrap instead of
                           running off the right edge in the wide brand
                           font. */
                        minWidth: 0,
                        maxWidth: "100%",
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
                        data-testid={`qr-row-show-qr-${c.slug}`}
                        type="button"
                        onClick={() => toggleQr(c)}
                        style={btnSecondary}
                      >
                        {row.showingQr ? "Hide QR" : "Show QR"}
                      </button>
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

                  {row.showingQr ? (
                    <div
                      data-testid={`qr-row-svg-${c.slug}`}
                      className="qr-row-svg-panel"
                      style={{
                        marginTop: 10,
                        padding: 12,
                        border: "1px solid var(--wp-dark-border)",
                        borderRadius: 6,
                        background: "var(--wp-dark-surface2)",
                        display: "flex",
                        gap: 16,
                        /* flex-start (not center): with the wide brand font
                           the controls can make this panel taller/wider, and
                           centering pushed the QR off the right edge on
                           mobile. Left-align so the full QR is always visible
                           from the left. */
                        alignItems: "flex-start",
                        flexWrap: "wrap",
                        width: "100%",
                        maxWidth: "100%",
                        minWidth: 0,
                        boxSizing: "border-box",
                      }}
                    >
                      {row.loadingQr ? (
                        <div style={{ color: "var(--wp-text-dim)", fontSize: 13 }}>
                          Loading QR…
                        </div>
                      ) : row.qrSvg ? (
                        <>
                          <div
                            data-testid={`qr-row-svg-render-${c.slug}`}
                            className="qr-row-svg-wrapper"
                            style={{
                              /* 192px at most, but never wider than the
                                 container — so the full QR always fits on
                                 mobile. maxWidth is inline so no stylesheet
                                 rule can blow it past the viewport. */
                              width: 192,
                              maxWidth: "100%",
                              aspectRatio: "1 / 1",
                              background: "#fff",
                              padding: 8,
                              borderRadius: 4,
                              boxSizing: "border-box",
                              overflow: "hidden",
                              // Center the (square) QR inside the white box so it
                              // can never sit top-aligned with an asymmetric gap.
                              // Matches the just-created panel above; robust even
                              // if height:100% can't resolve (aspect-ratio fallback).
                              boxSizing: "border-box",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                            dangerouslySetInnerHTML={{
                              __html: row.qrSvg.replace(
                                /<svg([^>]*)>/,
                                '<svg$1 style="max-width:100%;max-height:100%;height:auto;display:block">',
                              ),
                            }}
                          />
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: 8,
                              /* Let the download controls shrink/wrap within
                                 the panel instead of forcing it wider than
                                 the viewport (the wide brand font makes the
                                 format/size <select>s long). */
                              flex: "1 1 auto",
                              minWidth: 0,
                              maxWidth: "100%",
                            }}
                          >
                            {row.qrSvg ? (
                              <DownloadMenu
                                testId={`qr-row-svg-download-${c.slug}`}
                                svg={row.qrSvg}
                                slug={c.slug}
                              />
                            ) : null}
                            <span style={{ fontSize: 12, color: "var(--wp-text-dim)" }}>
                              Scans to <strong>/q/{c.slug}</strong>
                            </span>
                          </div>
                        </>
                      ) : (
                        <div style={{ color: "var(--wp-error)", fontSize: 13 }}>
                          Couldn&apos;t load QR.{" "}
                          <button
                            type="button"
                            onClick={() => toggleQr(c)}
                            style={{ ...btnSecondary, padding: "2px 8px" }}
                          >
                            Retry
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}

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
                      {row.analytics ? (
                        <div style={{ marginTop: 12 }}>
                          <button
                            type="button"
                            data-testid={`qr-toggle-scan-detail-${c.slug}`}
                            onClick={() => toggleScanDetail(c)}
                            style={{
                              fontSize: "0.8rem",
                              padding: "6px 10px",
                              background: "transparent",
                              color: "var(--wp-gold)",
                              border: "1px solid var(--wp-dark-border)",
                              borderRadius: 4,
                              cursor: "pointer",
                            }}
                          >
                            {row.detailOpen
                              ? "Hide all scans"
                              : "View all scans (full detail)"}
                          </button>
                          {row.detailOpen ? (
                            <ScanDetailPanel
                              codeSlug={c.slug}
                              row={row}
                              onSort={(k) => setScanSort(c.id, k)}
                              onToggleGrouping={() =>
                                patchRow(c.id, {
                                  groupByVisitor: !row.groupByVisitor,
                                })
                              }
                            />
                          ) : null}
                        </div>
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

/* ------------------------------------------------------------------ */
/* ScanDetailPanel — every captured datapoint per scan, sortable, with */
/* a "Group by visitor" toggle so the team can answer "did the same    */
/* anonymous person scan twice?" at a glance.                          */
/* ------------------------------------------------------------------ */

function ScanDetailPanel({
  codeSlug,
  row,
  onSort,
  onToggleGrouping,
}: {
  codeSlug: string;
  row: RowState;
  onSort: (key: ScanSortKey) => void;
  onToggleGrouping: () => void;
}) {
  if (row.loadingDetail) {
    return (
      <div
        data-testid={`qr-scan-detail-loading-${codeSlug}`}
        style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}
      >
        Loading every-scan detail…
      </div>
    );
  }
  if (row.detailError) {
    return (
      <div
        data-testid={`qr-scan-detail-error-${codeSlug}`}
        style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}
      >
        {row.detailError}
      </div>
    );
  }
  const scans = row.scans ?? [];
  if (scans.length === 0) {
    return (
      <div
        data-testid={`qr-scan-detail-empty-${codeSlug}`}
        style={{ color: "var(--wp-text-muted)", fontSize: "0.85rem" }}
      >
        No scans yet — once someone scans this code the per-scan
        attribution will appear here.
      </div>
    );
  }

  /* Client-side sort. Server already returns scanned_at DESC; users
     can re-sort by another column if they want to spot e.g. all
     scans from one country. */
  const sorted = [...scans].sort((a, b) => {
    const k = row.scanSort.key;
    const dir = row.scanSort.dir === "asc" ? 1 : -1;
    const av = (a[k] ?? "") as string;
    const bv = (b[k] ?? "") as string;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  /* Group-by-visitor toggle. Maintains sort order WITHIN each group
     by visitor_hash; visitors with no hash bucket together in
     "(unknown visitor)". */
  const groups: Array<{ visitor: string; rows: ScanDetail[] }> = [];
  if (row.groupByVisitor) {
    const map = new Map<string, ScanDetail[]>();
    for (const s of sorted) {
      const key = s.visitor_hash ?? "(unknown)";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    for (const [visitor, rows] of map) {
      groups.push({ visitor, rows });
    }
    /* Sort groups by row count desc — busiest visitors first. */
    groups.sort((a, b) => b.rows.length - a.rows.length);
  }

  return (
    <div
      data-testid={`qr-scan-detail-${codeSlug}`}
      style={{
        marginTop: 8,
        padding: 10,
        border: "1px solid var(--wp-dark-border)",
        borderRadius: 6,
        background: "var(--wp-dark)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          fontSize: "0.75rem",
          color: "var(--wp-text-dim)",
        }}
      >
        <div>
          Showing {scans.length} of last 500 scans · click a column header
          to sort
        </div>
        <label
          style={{ display: "flex", gap: 6, alignItems: "center" }}
          data-testid={`qr-scan-detail-group-toggle-${codeSlug}`}
        >
          <input
            type="checkbox"
            checked={row.groupByVisitor}
            onChange={onToggleGrouping}
          />
          Group by visitor
        </label>
      </div>

      <div style={{ overflowX: "auto", maxHeight: 480, overflowY: "auto" }}>
        <table
          data-testid={`qr-scan-detail-table-${codeSlug}`}
          style={{
            width: "100%",
            fontSize: "0.72rem",
            borderCollapse: "collapse",
            color: "var(--wp-text-dim)",
          }}
        >
          <thead style={{ position: "sticky", top: 0, background: "var(--wp-dark)" }}>
            <tr style={{ textAlign: "left" }}>
              <SortableTh
                label="When"
                k="scanned_at"
                row={row}
                onSort={onSort}
              />
              <SortableTh label="Country" k="country" row={row} onSort={onSort} />
              <th style={thStyle}>Region</th>
              <SortableTh label="City" k="city" row={row} onSort={onSort} />
              <th style={thStyle}>Postal</th>
              <th style={thStyle}>Coords</th>
              <SortableTh label="Device" k="device" row={row} onSort={onSort} />
              <th style={thStyle}>OS</th>
              <SortableTh label="Browser" k="browser" row={row} onSort={onSort} />
              <th style={thStyle}>Lang</th>
              <th style={thStyle}>Referrer</th>
              <th style={thStyle}>UTM</th>
              <th style={thStyle}>Flags</th>
              <SortableTh
                label="Client match"
                k="client_name"
                row={row}
                onSort={onSort}
              />
              <th style={thStyle}>Visitor</th>
            </tr>
          </thead>
          <tbody>
            {row.groupByVisitor
              ? groups.map((g, gi) => (
                  <GroupBlock key={`${g.visitor}-${gi}`} group={g} />
                ))
              : sorted.map((s) => <ScanDetailRow key={s.id} s={s} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SortableTh({
  label,
  k,
  row,
  onSort,
}: {
  label: string;
  k: ScanSortKey;
  row: RowState;
  onSort: (key: ScanSortKey) => void;
}) {
  const active = row.scanSort.key === k;
  const arrow = active ? (row.scanSort.dir === "asc" ? " ↑" : " ↓") : "";
  return (
    <th
      style={{
        ...thStyle,
        cursor: "pointer",
        userSelect: "none",
        color: active ? "var(--wp-gold)" : thStyle.color,
      }}
      onClick={() => onSort(k)}
      data-testid={`qr-scan-detail-sort-${k}`}
    >
      {label}
      {arrow}
    </th>
  );
}

function GroupBlock({
  group,
}: {
  group: { visitor: string; rows: ScanDetail[] };
}) {
  const short =
    group.visitor === "(unknown)"
      ? "(unknown)"
      : group.visitor.slice(0, 8);
  return (
    <>
      <tr>
        <td
          colSpan={15}
          style={{
            padding: "8px 6px 4px 6px",
            color: "var(--wp-gold)",
            fontWeight: 600,
            background: "var(--wp-dark-surface)",
          }}
        >
          Visitor {short} · {group.rows.length} scan
          {group.rows.length === 1 ? "" : "s"}
        </td>
      </tr>
      {group.rows.map((s) => (
        <ScanDetailRow key={s.id} s={s} />
      ))}
    </>
  );
}

function ScanDetailRow({ s }: { s: ScanDetail }) {
  const utmText = [s.utm_source, s.utm_medium, s.utm_campaign]
    .filter(Boolean)
    .join("·");
  const flags: string[] = [];
  if (s.is_bot) flags.push("BOT");
  if (s.blocked) flags.push("BLOCKED");
  return (
    <tr data-testid={`qr-scan-row-${s.id}`}>
      <td style={tdStyle}>
        <div style={{ whiteSpace: "nowrap" }}>{formatDate(s.scanned_at)}</div>
        <div style={{ fontSize: "0.65rem", color: "var(--wp-text-muted)" }}>
          {relativeTime(s.scanned_at)}
        </div>
      </td>
      <td style={tdStyle}>{s.country || "—"}</td>
      <td style={tdStyle}>{s.region || "—"}</td>
      <td style={tdStyle}>{s.city || "—"}</td>
      <td style={tdStyle}>{s.postal_code || "—"}</td>
      <td style={tdStyle}>
        {s.latitude && s.longitude ? (
          <a
            data-testid={`qr-scan-map-${s.id}`}
            href={`https://www.openstreetmap.org/?mlat=${encodeURIComponent(
              s.latitude,
            )}&mlon=${encodeURIComponent(
              s.longitude,
            )}#map=14/${encodeURIComponent(s.latitude)}/${encodeURIComponent(s.longitude)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--wp-gold)" }}
            title="View on map"
          >
            map
          </a>
        ) : (
          "—"
        )}
      </td>
      <td style={tdStyle}>{s.device || "—"}</td>
      <td style={tdStyle}>{s.os || "—"}</td>
      <td style={tdStyle}>{s.browser || "—"}</td>
      <td style={tdStyle}>{s.language || "—"}</td>
      <td
        style={{
          ...tdStyle,
          maxWidth: 160,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={s.referrer || ""}
      >
        {s.referrer || "(direct)"}
      </td>
      <td
        style={{
          ...tdStyle,
          maxWidth: 140,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={utmText || ""}
      >
        {utmText || "—"}
      </td>
      <td style={tdStyle}>
        {flags.length === 0 ? (
          "—"
        ) : (
          <span
            data-testid={`qr-scan-flags-${s.id}`}
            style={{ color: "var(--wp-error)", fontWeight: 600 }}
          >
            {flags.join(" ")}
          </span>
        )}
      </td>
      <td style={tdStyle}>
        {s.client_id && s.client_name ? (
          <a
            data-testid={`qr-scan-client-${s.id}`}
            href={`/clients/${encodeURIComponent(s.client_id)}`}
            style={{ color: "var(--wp-gold)" }}
            title={`Match score ${s.client_match_score ?? "?"}`}
          >
            {s.client_name}
          </a>
        ) : (
          <span style={{ color: "var(--wp-text-muted)" }}>no match</span>
        )}
      </td>
      <td
        style={{ ...tdStyle, fontFamily: "monospace", color: "var(--wp-text-muted)" }}
      >
        {s.visitor_hash ? s.visitor_hash.slice(0, 8) : "—"}
      </td>
    </tr>
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
