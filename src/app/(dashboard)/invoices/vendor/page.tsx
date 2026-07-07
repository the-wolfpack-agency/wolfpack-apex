import type { Metadata } from "next";
import Link from "next/link";
import { InvoicesPanel } from "@/components/finance/InvoicesPanel";

/**
 * /invoices/vendor — the AP invoice upload/scan queue, now a sub-page of the
 * Invoices hub. Reuses the exact InvoicesPanel that /finance/invoices renders
 * (single source of truth for the AP surface — no fork). A breadcrumb returns
 * to the hub.
 */
export const metadata: Metadata = {
  title: "Vendor Invoices — Wolfpack Instinct",
  description: "AP invoice queue: upload, review extracted fields, approve, mark paid.",
};

export default function VendorInvoicesPage() {
  return (
    <main className="flex-1 p-4 md:p-6" data-testid="vendor-invoices-page">
      <Link
        href="/invoices"
        data-testid="vendor-invoices-breadcrumb"
        className="text-xs inline-block"
        style={{ color: "var(--wp-text-dim, #aaa)", textDecoration: "none", padding: "0.4rem 0.4rem", margin: "-0.4rem -0.4rem 0.4rem" }}
      >
        ← Invoices
      </Link>
      <header className="mb-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
          Vendor Invoices
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Vendor invoices extracted by Azure Document Intelligence. Drop a PDF or
          photo; review fields; approve or reject. Every status change is audited.
        </p>
      </header>
      <InvoicesPanel />
    </main>
  );
}
