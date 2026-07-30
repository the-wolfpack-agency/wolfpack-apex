"use client";

/**
 * ProductCatalog: renders the product catalog as a set of cards, one per
 * product, with a lightweight status filter (all / live / in flight). Each card
 * explains what the product is, the value it delivers, who it is for, and where
 * its parts could be reused. Status chips also give an at-a-glance read of what
 * is live versus in flight (the current-engagements view builds on the same
 * data).
 */

import { useMemo, useState } from "react";
import { STATUS_LABELS, type Product, type ProductStatus } from "@/lib/products";

const STATUS_COLOR: Record<ProductStatus, string> = {
  live: "#22c55e",
  in_flight: "#e8b528",
  preview: "#38bdf8",
  platform: "#9aa0aa",
  client: "#a78bfa",
};

type Filter = "all" | "live" | "in_flight";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "live", label: "Live in production" },
  { key: "in_flight", label: "In flight" },
];

function matches(p: Product, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "live") return p.status === "live";
  // "In flight" groups everything actively being built but not yet generally live.
  return p.status === "in_flight" || p.status === "preview";
}

function StatusChip({ status }: { status: ProductStatus }) {
  const color = STATUS_COLOR[status];
  return (
    <span
      data-testid={`product-status-${status}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        fontSize: "0.72rem",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color,
        border: `1px solid ${color}`,
        background: `${color}1a`,
        borderRadius: 999,
        padding: "0.15rem 0.6rem",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: color }} aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: "0.9rem" }}>
      <div style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--wp-text-dim, #9aa0aa)", marginBottom: "0.4rem" }}>
        {title}
      </div>
      <ul style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.35rem" }}>
        {items.map((it, i) => (
          <li key={i} style={{ color: "var(--wp-text, #e8eaed)", fontSize: "0.9rem", lineHeight: 1.5 }}>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ProductCatalog({ products }: { products: Product[] }) {
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(() => products.filter((p) => matches(p, filter)), [products, filter]);

  const counts = useMemo(
    () => ({
      total: products.length,
      live: products.filter((p) => p.status === "live").length,
      inFlight: products.filter((p) => p.status === "in_flight" || p.status === "preview").length,
    }),
    [products],
  );

  if (products.length === 0) {
    return (
      <div
        data-testid="products-empty"
        style={{
          border: "1px dashed var(--wp-dark-border, #23262e)",
          borderRadius: 12,
          padding: "2rem",
          textAlign: "center",
          color: "var(--wp-text-dim, #9aa0aa)",
        }}
      >
        No products to show yet.
      </div>
    );
  }

  return (
    <div data-testid="products-catalog">
      {/* At-a-glance counts, doubles as a quick engagements read. */}
      <div data-testid="products-counts" style={{ display: "flex", gap: "1.2rem", marginBottom: "1rem", color: "var(--wp-text-dim, #9aa0aa)", fontSize: "0.85rem" }}>
        <span><strong style={{ color: "var(--wp-text, #e8eaed)" }}>{counts.total}</strong> products</span>
        <span><strong style={{ color: STATUS_COLOR.live }}>{counts.live}</strong> live</span>
        <span><strong style={{ color: STATUS_COLOR.in_flight }}>{counts.inFlight}</strong> in flight</span>
      </div>

      {/* Status filter. */}
      <div role="tablist" aria-label="Filter products by status" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.2rem" }}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`products-filter-${f.key}`}
              onClick={() => setFilter(f.key)}
              style={{
                cursor: "pointer",
                fontSize: "0.82rem",
                fontWeight: 700,
                borderRadius: 999,
                padding: "0.35rem 0.9rem",
                border: `1px solid ${active ? "var(--wp-gold, #e8b528)" : "var(--wp-dark-border, #23262e)"}`,
                background: active ? "var(--wp-gold, #e8b528)" : "transparent",
                color: active ? "#1a1a1a" : "var(--wp-text, #e8eaed)",
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <div data-testid="products-filter-empty" style={{ color: "var(--wp-text-dim, #9aa0aa)", padding: "1.5rem 0" }}>
          No products in this status.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {visible.map((p) => (
            <article
              key={p.id}
              id={p.id}
              data-testid={`product-card-${p.id}`}
              style={{
                background: "var(--wp-card, #16181d)",
                border: "1px solid var(--wp-dark-border, #23262e)",
                borderRadius: 14,
                padding: "1.2rem 1.3rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.75rem", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 800, color: "var(--wp-text, #e8eaed)" }}>{p.name}</h2>
                  <div style={{ color: "var(--wp-gold, #e8b528)", fontSize: "0.9rem", fontWeight: 600, marginTop: "0.15rem" }}>{p.tagline}</div>
                  {p.url ? (
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid={`product-link-${p.id}`}
                      aria-label={`Open ${p.name} (opens in a new tab)`}
                      style={{
                        display: "inline-block",
                        marginTop: "0.4rem",
                        color: "var(--wp-text-dim, #9aa0aa)",
                        fontSize: "0.82rem",
                        fontWeight: 600,
                        textDecoration: "none",
                        borderBottom: "1px solid var(--wp-dark-border, #23262e)",
                      }}
                    >
                      {p.url.replace(/^https?:\/\//, "")} &#8599;
                    </a>
                  ) : null}
                </div>
                <StatusChip status={p.status} />
              </div>

              <p style={{ margin: "0.8rem 0 0", color: "var(--wp-text, #e8eaed)", fontSize: "0.95rem", lineHeight: 1.6 }}>{p.summary}</p>

              <Bullets title="What it delivers" items={p.highlights} />
              <Bullets title="Where its parts could be reused" items={p.potentialUses} />

              <div style={{ marginTop: "0.9rem", fontSize: "0.85rem", color: "var(--wp-text-dim, #9aa0aa)" }}>
                <strong style={{ color: "var(--wp-text, #e8eaed)" }}>Who it is for:</strong> {p.audience}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
