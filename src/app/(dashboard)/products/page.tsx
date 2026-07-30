"use client";

/**
 * /products: the product catalog.
 *
 * Reads /api/products (org-wide, products.view) and renders a plain-language
 * explanation of every Wolfpack product: what it is, the value it delivers, who
 * it is for, where its parts could be reused, and whether it is live or in
 * flight. Content is curated in src/lib/products.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { Product } from "@/lib/products";
import ProductCatalog from "@/components/products/ProductCatalog";

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/products");
      if (!res.ok) {
        setError(`Could not load products (${res.status}).`);
        setProducts([]);
        return;
      }
      const data = (await res.json()) as { products?: Product[] };
      setProducts(Array.isArray(data.products) ? data.products : []);
    } catch {
      setError("Could not load products. Check your connection and try again.");
      setProducts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "1.5rem 1rem 3rem" }}>
      <header style={{ marginBottom: "1.4rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.6rem", fontWeight: 800, color: "var(--wp-text, #e8eaed)" }}>
          Products
        </h1>
        <p style={{ margin: "0.4rem 0 0", color: "var(--wp-text-dim, #9aa0aa)", fontSize: "0.95rem", lineHeight: 1.5 }}>
          What the team has built, the value each product delivers, and where its parts could be reused.
        </p>
      </header>

      {error ? (
        <div
          data-testid="products-error"
          style={{
            border: "1px solid var(--wp-error, #ef4444)",
            background: "rgba(239,68,68,0.08)",
            color: "var(--wp-text, #e8eaed)",
            borderRadius: 10,
            padding: "0.8rem 1rem",
            marginBottom: "1rem",
            fontSize: "0.9rem",
          }}
        >
          {error}{" "}
          <button
            type="button"
            onClick={() => void load()}
            style={{ all: "unset", cursor: "pointer", color: "var(--wp-gold, #e8b528)", fontWeight: 700 }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {products === null ? (
        <div data-testid="products-loading" style={{ color: "var(--wp-text-dim, #9aa0aa)", padding: "2rem 0" }}>
          Loading products…
        </div>
      ) : (
        <ProductCatalog products={products} />
      )}
    </div>
  );
}
