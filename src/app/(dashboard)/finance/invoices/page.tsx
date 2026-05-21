import type { Metadata } from "next";
import { InvoicesPanel } from "@/components/finance/InvoicesPanel";

export const metadata: Metadata = {
  title: "Invoices — Wolfpack Instinct",
  description: "AP invoice queue: upload, review extracted fields, approve, mark paid.",
};

export default function InvoicesPage() {
  return (
    <main className="flex-1 p-4 md:p-6" data-testid="invoices-page">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
          Invoices
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Vendor invoices extracted by Azure Document Intelligence. Drop a
          PDF or photo; review fields; approve or reject. Every status change
          is audited.
        </p>
      </header>
      <InvoicesPanel />
    </main>
  );
}
