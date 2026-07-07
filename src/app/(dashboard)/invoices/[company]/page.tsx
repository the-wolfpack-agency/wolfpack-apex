/**
 * /invoices/{company} — one company's read-only invoice tracker (e.g. PCNA).
 * Thin server shell; the client table fetches /api/invoices/{company}, which is
 * the real access gate (per-tracker email allowlist). Unknown companies still
 * render — the table shows a clean forbidden/empty state.
 */
import { InvoiceTrackerTable } from "@/components/invoices/InvoiceTrackerTable";
import { getTracker } from "@/lib/invoice-tracker/config";

export default async function InvoiceTrackerPage({
  params,
}: {
  params: Promise<{ company: string }>;
}) {
  const { company } = await params;
  const tracker = getTracker(company);
  const title = tracker?.company ?? company.toUpperCase();

  return (
    <main className="flex-1 p-4 md:p-6" data-testid="invoice-tracker-page">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
          {title} Invoices
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Live, read-only mirror of the {title} budget &amp; SOW workbook (Summary tab).
          Edits are made in SharePoint; Instinct reflects them here.
        </p>
      </header>
      <InvoiceTrackerTable company={company} />
    </main>
  );
}
