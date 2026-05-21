"use client";

/**
 * CodeDossierView — render the full per-code dossier.
 *
 * Read-only by design: editing routes through the index-page inline
 * editor + ReceiptUploadButton so all writes hit the cell-writer
 * safety gate. This view never PATCHes anything.
 *
 * Tabs are stateful, not URL-driven (no deep-linking needed for v1).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh } from "@/lib/client-auth";

interface DossierHeader {
  code: string;
  description: string;
  active: boolean;
  category: string | null;
  program: string | null;
  poNumber: string | null;
  poAmount: string | null;
  poAmountNumeric: number | null;
  lastSeenAt: string;
  webUrl: string | null;
}
interface DossierRollups {
  spendYtd: number;
  spendMtd: number;
  spendAllTime: number;
  receiptCount: number;
  poRemaining: number | null;
  lastActivityAt: string | null;
}
interface DossierReceipt {
  scanId: string;
  appliedAt: string;
  uploadedByEmail: string | null;
  merchant: string | null;
  transactionDate: string | null;
  total: number | null;
  currency: string | null;
  appliedProgram: string | null;
  appliedPoNumber: string | null;
  appliedPoAmount: string | null;
}
interface DossierActivity {
  kind: "cell_edit" | "event";
  at: string;
  summary: string;
  actor: string;
  detail: Record<string, string | number | boolean | null>;
}
interface CodeDossier {
  header: DossierHeader;
  rollups: DossierRollups;
  receipts: DossierReceipt[];
  activity: DossierActivity[];
}

function fmtMoney(n: number, currency: string | null = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

type Tab = "receipts" | "activity";

export interface CodeDossierViewProps {
  code: string;
}

export function CodeDossierView({ code }: CodeDossierViewProps) {
  const [dossier, setDossier] = useState<CodeDossier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("receipts");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/job-codes/${encodeURIComponent(code)}/dossier`,
      );
      if (res.status === 404) {
        setError("not_found");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { dossier: CodeDossier };
      setDossier(body.dossier);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  const poRemainingNegative = useMemo(
    () => (dossier?.rollups.poRemaining ?? 0) < 0,
    [dossier],
  );

  if (loading) {
    return (
      <div data-testid="dossier-loading" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
        Loading dossier for {code}…
      </div>
    );
  }

  if (error === "not_found") {
    return (
      <div data-testid="dossier-not-found" className="space-y-3">
        <h1 className="text-xl font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
          Code not found
        </h1>
        <p className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          No job code <code>{code}</code> in the cache. It may have been removed
          from the source workbook, or the cache hasn&apos;t been refreshed yet.
        </p>
        <Link
          href="/job-codes"
          data-testid="dossier-back-link"
          className="inline-block text-xs underline"
          style={{ color: "var(--wp-gold, #eab308)" }}
        >
          Back to all codes
        </Link>
      </div>
    );
  }

  if (error || !dossier) {
    return (
      <div
        data-testid="dossier-error"
        className="text-sm rounded px-3 py-2"
        style={{
          background: "rgba(248,113,113,0.08)",
          border: "1px solid #f87171",
          color: "#f87171",
        }}
      >
        Couldn&apos;t load dossier: {error ?? "unknown error"}.
      </div>
    );
  }

  const h = dossier.header;
  const r = dossier.rollups;
  const currency = dossier.receipts.find((x) => x.currency)?.currency ?? null;

  return (
    <div data-testid="code-dossier" className="space-y-4">
      <header className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            href="/job-codes"
            data-testid="dossier-back-link"
            className="text-xs underline"
            style={{ color: "var(--wp-text-dim, #aaa)" }}
          >
            ← All codes
          </Link>
          {!h.active && (
            <span
              data-testid="dossier-inactive-chip"
              className="text-[10px] rounded px-2 py-0.5"
              style={{
                background: "rgba(234,179,8,0.12)",
                color: "#eab308",
                border: "1px solid #eab308",
              }}
            >
              inactive
            </span>
          )}
        </div>
        <h1
          className="text-2xl font-semibold"
          style={{ color: "var(--wp-text, #eee)", fontFamily: "monospace" }}
          data-testid="dossier-code"
        >
          {h.code}
        </h1>
        <p className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }} data-testid="dossier-description">
          {h.description || "—"}
        </p>
        {h.category && (
          <p
            className="text-xs"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
            data-testid="dossier-category"
          >
            Client / Category: {h.category}
          </p>
        )}
        <div className="text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
          Last synced from SharePoint: {fmtWhen(h.lastSeenAt)}
          {h.webUrl && (
            <>
              {" · "}
              <a
                href={h.webUrl}
                target="_blank"
                rel="noreferrer"
                data-testid="dossier-source-link"
                className="underline"
                style={{ color: "var(--wp-text-dim, #aaa)" }}
              >
                Open source workbook
              </a>
            </>
          )}
        </div>
        {/* Current Program / PO Number / PO Amount — read-only;
            editing stays on the index page so all writes go through
            the cell-writer safety gate. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {[
            { label: "Program", value: h.program, testid: "dossier-program" },
            { label: "PO Number", value: h.poNumber, testid: "dossier-po-number" },
            { label: "PO Amount", value: h.poAmount, testid: "dossier-po-amount" },
          ].map((row) => (
            <div
              key={row.label}
              className="rounded p-2"
              style={{
                background: "var(--wp-dark-surface2, #1a1a1a)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                {row.label}
              </div>
              <div
                data-testid={row.testid}
                className="text-sm mt-1"
                style={{ color: "var(--wp-text, #eee)" }}
              >
                {row.value ?? "—"}
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px]" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
          To edit Program / PO Number / PO Amount, return to{" "}
          <Link href="/job-codes" className="underline" style={{ color: "var(--wp-text-dim, #aaa)" }}>
            the catalog
          </Link>{" "}
          — edits route through the SharePoint safety gate from there.
        </p>
      </header>

      {/* Rollup cards */}
      <section
        data-testid="dossier-rollups"
        className="grid grid-cols-2 md:grid-cols-5 gap-2"
      >
        <RollupCard
          label="Spend YTD"
          value={fmtMoney(r.spendYtd, currency)}
          testid="rollup-spend-ytd"
        />
        <RollupCard
          label="Spend MTD"
          value={fmtMoney(r.spendMtd, currency)}
          testid="rollup-spend-mtd"
        />
        <RollupCard
          label="PO Remaining"
          value={
            r.poRemaining == null
              ? "—"
              : fmtMoney(r.poRemaining, currency)
          }
          tone={poRemainingNegative ? "red" : "default"}
          testid="rollup-po-remaining"
        />
        <RollupCard
          label="Receipts"
          value={String(r.receiptCount)}
          testid="rollup-receipt-count"
        />
        <RollupCard
          label="Last activity"
          value={fmtWhen(r.lastActivityAt)}
          testid="rollup-last-activity"
        />
      </section>

      {/* Tabs */}
      <div className="flex gap-2" role="tablist">
        <TabBtn label={`Receipts (${dossier.receipts.length})`} active={tab === "receipts"} onClick={() => setTab("receipts")} testid="tab-receipts" />
        <TabBtn label={`Activity (${dossier.activity.length})`} active={tab === "activity"} onClick={() => setTab("activity")} testid="tab-activity" />
      </div>

      {tab === "receipts" && <ReceiptsTab receipts={dossier.receipts} />}
      {tab === "activity" && <ActivityTab activity={dossier.activity} />}

      {/* Mentions tab deferred — TODO: when src/lib/search exposes a
          unified per-entity result type, render a third tab here that
          calls runSearch({ q: code, types: ALL }) and groups by
          provider. The current provider helpers each return their
          own shape; rolling them into a uniform "this code was
          mentioned here" stream is its own feature. */}
    </div>
  );
}

function RollupCard({
  label,
  value,
  tone,
  testid,
}: {
  label: string;
  value: string;
  tone?: "default" | "red";
  testid: string;
}) {
  return (
    <div
      data-testid={testid}
      className="rounded p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
        {label}
      </div>
      <div
        className="text-lg font-semibold mt-1"
        style={{ color: tone === "red" ? "#f87171" : "var(--wp-text, #eee)" }}
      >
        {value}
      </div>
    </div>
  );
}

function TabBtn({
  label,
  active,
  onClick,
  testid,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testid}
      onClick={onClick}
      className="text-xs px-3 py-1.5 rounded"
      style={{
        background: active ? "var(--wp-gold, #eab308)" : "var(--wp-dark-surface2, #1a1a1a)",
        color: active ? "var(--wp-dark, #111)" : "var(--wp-text-dim, #aaa)",
        border: "1px solid var(--wp-dark-border, #333)",
        cursor: "pointer",
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}

function ReceiptsTab({ receipts }: { receipts: DossierReceipt[] }) {
  if (receipts.length === 0) {
    return (
      <div data-testid="receipts-empty" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
        No receipts applied to this code yet.
      </div>
    );
  }
  return (
    <div className="rounded overflow-x-auto" style={{ border: "1px solid var(--wp-dark-border, #333)" }}>
      <table data-testid="receipts-table" className="w-full text-sm">
        <thead style={{ background: "var(--wp-dark-surface2, #1a1a1a)" }}>
          <tr>
            {["Applied", "Merchant", "Receipt date", "Total", "Applied by", "Committed values"].map((h) => (
              <th key={h} className="text-left px-3 py-2 whitespace-nowrap" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {receipts.map((r) => (
            <tr
              key={r.scanId}
              data-testid={`receipt-row-${r.scanId}`}
              style={{ borderTop: "1px solid var(--wp-dark-border, #333)" }}
            >
              <td className="px-3 py-2 align-top" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                {fmtWhen(r.appliedAt)}
              </td>
              <td className="px-3 py-2 align-top" style={{ color: "var(--wp-text, #eee)" }}>
                {r.merchant ?? "—"}
              </td>
              <td className="px-3 py-2 align-top" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                {r.transactionDate ?? "—"}
              </td>
              <td className="px-3 py-2 align-top" style={{ color: "var(--wp-text, #eee)" }}>
                {r.total != null ? fmtMoney(r.total, r.currency) : "—"}
              </td>
              <td className="px-3 py-2 align-top" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                {r.uploadedByEmail ?? "—"}
              </td>
              <td className="px-3 py-2 align-top" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                <div className="space-y-0.5 text-[11px]">
                  {r.appliedProgram && <div>Program: {r.appliedProgram}</div>}
                  {r.appliedPoNumber && <div>PO #: {r.appliedPoNumber}</div>}
                  {r.appliedPoAmount && <div>PO Amt: {r.appliedPoAmount}</div>}
                  {!r.appliedProgram && !r.appliedPoNumber && !r.appliedPoAmount && <div>—</div>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityTab({ activity }: { activity: DossierActivity[] }) {
  if (activity.length === 0) {
    return (
      <div data-testid="activity-empty" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
        No activity recorded for this code yet.
      </div>
    );
  }
  return (
    <ul data-testid="activity-list" className="space-y-2">
      {activity.map((a, i) => (
        <li
          key={`${a.at}-${i}`}
          data-testid={`activity-item-${i}`}
          className="rounded p-2 text-xs"
          style={{
            background: "var(--wp-dark-surface2, #1a1a1a)",
            border: "1px solid var(--wp-dark-border, #333)",
          }}
        >
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span style={{ color: "var(--wp-text, #eee)" }}>{a.summary}</span>
            <span style={{ color: "var(--wp-text-muted, #6b7280)" }}>{fmtWhen(a.at)}</span>
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
            {a.kind === "cell_edit" ? "edit" : "event"} · {a.actor}
            {a.detail.status === "failed" && a.detail.graph_error ? (
              <> · failed: {String(a.detail.graph_error).slice(0, 80)}</>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
