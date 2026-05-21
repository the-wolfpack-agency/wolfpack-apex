import type { Metadata } from "next";
import { HrDocsPanel } from "@/components/hr/HrDocsPanel";

export const metadata: Metadata = {
  title: "HR Documents — Wolfpack Instinct",
  description: "Scan and verify employee HR documents — IDs, tax forms, banking info.",
};

export default function HrDocumentsPage() {
  return (
    <main className="flex-1 p-4 md:p-6" data-testid="hr-documents-page">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
          HR Documents
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Upload an employee&apos;s ID, tax form, voided check, or other HR
          paperwork. License / passport / state ID fields are extracted
          automatically; other types are OCR&apos;d and searchable.
        </p>
      </header>
      <HrDocsPanel />
    </main>
  );
}
