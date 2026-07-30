import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { listProducts } from "@/lib/products";

/**
 * GET /api/products returns the Wolfpack product catalog.
 *
 * Org-wide read (products.view). Powers the /products page. The catalog is
 * curated reference content in src/lib/products.ts; this route gates access and
 * records the view so the learning loop sees which products the team explores.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "products.view");
  if (!auth.ok) return auth.response;

  const products = listProducts();

  trackEvent("products.viewed", auth.user.id, auth.user.role, {
    count: products.length,
  });

  return NextResponse.json({ products });
}
