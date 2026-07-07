import { redirect } from "next/navigation";

/**
 * The AP invoice queue moved under the unified Invoices hub at
 * /invoices/vendor (single home for every invoice surface). This route is kept
 * as a permanent redirect so existing deep links — the ScanInvoiceWidget "open
 * queue" button, the scan-invoice assistant tool, bookmarks — keep working.
 * InvoicesPanel is now mounted in exactly one place: /invoices/vendor.
 */
export default function LegacyInvoicesRedirect() {
  redirect("/invoices/vendor");
}
