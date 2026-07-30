"use client";

/**
 * ProductCatalog: the /products catalog, organized for scanning.
 *
 * Cards are grouped by lifecycle (Live in production / In flight) with section
 * headers and laid out in a responsive equal-height grid. Each card stacks
 * vertically (status chip, then name, then body) so it never squeezes on a
 * phone, and the body has real hierarchy: a bright summary, then softer bullet
 * lists with coloured dot markers, so it reads as sections rather than a wall of
 * text. A lightweight status filter + live/in-flight counts sit on top (also the
 * current-engagements read).
 */

import { useMemo, useState } from "react";
import { STATUS_LABELS, type Product, type ProductStatus } from "@/lib/products";
import {
  ConsoleGrid,
  SectionHeader,
  StatusPill,
  type SeverityTone,
} from "@/components/console";

/** Product lifecycle -> console severity tone (drives the StatusPill colour). */
const STATUS_TONE: Record<ProductStatus, SeverityTone> = {
  live: "success",
  in_flight: "warning",
  preview: "info",
  platform: "neutral",
  client: "info",
};

const isInFlight = (s: ProductStatus) => s === "in_flight" || s === "preview";

type Filter = "all" | "live" | "in_flight";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "live", label: "Live in production" },
  { key: "in_flight", label: "In flight" },
];

function matches(p: Product, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "live") return p.status === "live";
  return isInFlight(p.status);
}

/** Ordered groups for the "All" view: live first, then in flight, then the rest. */
const GROUPS: { key: string; label: string; test: (s: ProductStatus) => boolean }[] = [
  { key: "live", label: "Live in production", test: (s) => s === "live" },
  { key: "in_flight", label: "In flight", test: (s) => isInFlight(s) },
  { key: "other", label: "Other", test: (s) => s !== "live" && !isInFlight(s) },
];

/** A labelled bullet list with coloured dot markers, dimmer than the summary so
 *  the card reads as distinct sections instead of one block of text. */
function Section({ title, items, marker }: { title: string; items: string[]; marker: string }) {
  if (!items.length) return null;
  return (
    <div>
      <div
        style={{
          fontSize: "0.66rem",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "var(--wp-text-dim, #8a909c)",
          marginBottom: "0.45rem",
        }}
      >
        {title}
      </div>
      <div style={{ display: "grid", gap: "0.45rem" }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: "flex", gap: "0.55rem" }}>
            <span
              aria-hidden="true"
              style={{ marginTop: "0.45rem", flexShrink: 0, width: 5, height: 5, borderRadius: 999, background: marker }}
            />
            <span style={{ color: "#c2c6cd", fontSize: "0.86rem", lineHeight: 1.5 }}>{it}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductCard({ p }: { p: Product }) {
  return (
    <article
      id={p.id}
      data-testid={`product-card-${p.id}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.85rem",
        height: "100%",
        background: "var(--wp-card, #16181d)",
        border: "1px solid var(--wp-dark-border, #23262e)",
        borderRadius: 14,
        padding: "1.15rem 1.2rem",
      }}
    >
      {/* Header stacks: status chip on its own line, then name + tagline full
          width, so nothing collides or wraps one-word-per-line on a phone. */}
      <header style={{ display: "flex", flexDirection: "column", gap: "0.45rem", alignItems: "flex-start" }}>
        <StatusPill status={p.status} label={STATUS_LABELS[p.status]} tone={STATUS_TONE[p.status]} size="sm" />
        <div>
          <h2 style={{ margin: 0, fontSize: "1.2rem", fontWeight: 800, color: "var(--wp-text, #e8eaed)", lineHeight: 1.2 }}>
            {p.name}
          </h2>
          <div style={{ color: "var(--wp-gold, #e8b528)", fontSize: "0.88rem", fontWeight: 600, marginTop: "0.2rem" }}>
            {p.tagline}
          </div>
        </div>
        {p.url ? (
          <a
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`product-link-${p.id}`}
            aria-label={`Open ${p.name} (opens in a new tab)`}
            style={{
              color: "var(--wp-text-dim, #9aa0aa)",
              fontSize: "0.8rem",
              fontWeight: 600,
              textDecoration: "none",
              borderBottom: "1px solid var(--wp-dark-border, #23262e)",
            }}
          >
            {p.url.replace(/^https?:\/\//, "")} &#8599;
          </a>
        ) : null}
      </header>

      <p style={{ margin: 0, color: "var(--wp-text, #e8eaed)", fontSize: "0.92rem", lineHeight: 1.6 }}>{p.summary}</p>

      <Section title="What it delivers" items={p.highlights} marker="var(--wp-gold, #e8b528)" />
      <Section title="Where its parts could be reused" items={p.potentialUses} marker="#5b6472" />

      <footer
        style={{
          marginTop: "auto",
          paddingTop: "0.8rem",
          borderTop: "1px solid var(--wp-dark-border, #23262e)",
          fontSize: "0.8rem",
          color: "var(--wp-text-dim, #9aa0aa)",
        }}
      >
        <strong style={{ color: "var(--wp-text, #e8eaed)" }}>Who it is for:</strong> {p.audience}
      </footer>
    </article>
  );
}

export default function ProductCatalog({ products }: { products: Product[] }) {
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(() => products.filter((p) => matches(p, filter)), [products, filter]);

  const counts = useMemo(
    () => ({
      total: products.length,
      live: products.filter((p) => p.status === "live").length,
      inFlight: products.filter((p) => isInFlight(p.status)).length,
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
      {/* At-a-glance counts, doubles as the engagements read. */}
      <div
        data-testid="products-counts"
        style={{ display: "flex", gap: "1.2rem", marginBottom: "1rem", color: "var(--wp-text-dim, #9aa0aa)", fontSize: "0.85rem", flexWrap: "wrap" }}
      >
        <span><strong style={{ color: "var(--wp-text, #e8eaed)" }}>{counts.total}</strong> products</span>
        <span><strong style={{ color: "var(--wp-success, #22c55e)" }}>{counts.live}</strong> live</span>
        <span><strong style={{ color: "var(--wp-warning, #f97316)" }}>{counts.inFlight}</strong> in flight</span>
      </div>

      {/* Status filter. */}
      <div role="tablist" aria-label="Filter products by status" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.4rem" }}>
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
      ) : filter === "all" ? (
        <div style={{ display: "grid", gap: "1.8rem" }}>
          {GROUPS.map((g) => {
            const inGroup = visible.filter((p) => g.test(p.status));
            if (inGroup.length === 0) return null;
            return (
              <section key={g.key} data-testid={`products-group-${g.key}`}>
                <SectionHeader title={g.label} subtitle={`${inGroup.length} ${inGroup.length === 1 ? "product" : "products"}`} />
                <ConsoleGrid minColWidth={330} gap={16}>
                  {inGroup.map((p) => (
                    <ProductCard key={p.id} p={p} />
                  ))}
                </ConsoleGrid>
              </section>
            );
          })}
        </div>
      ) : (
        <ConsoleGrid minColWidth={330} gap={16}>
          {visible.map((p) => (
            <ProductCard key={p.id} p={p} />
          ))}
        </ConsoleGrid>
      )}
    </div>
  );
}
