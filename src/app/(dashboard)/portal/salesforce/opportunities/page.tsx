"use client";

/**
 * /portal/salesforce/opportunities — pipeline view with stage chips.
 * Stage filter is a client-side multi-select that round-trips through
 * the API; the API applies it server-side after the SOQL search
 * (vendor preset's basic name-search doesn't compose stage clauses).
 */

import SalesforceListPage from "@/components/SalesforceListPage";

/* Canonical SF opportunity stages. Workspaces with custom stage names
   will still see them in the table — the chip set is just the most
   common shortcut so users don't have to type. */
const STAGES = [
  "Prospecting",
  "Qualification",
  "Needs Analysis",
  "Value Proposition",
  "Proposal",
  "Negotiation",
  "Closed Won",
  "Closed Lost",
];

export default function OpportunitiesListPage() {
  return (
    <SalesforceListPage
      type="opportunities"
      title="Opportunities"
      description="Pipeline view across all stages. Filter by stage with the chips below."
      stages={STAGES}
      columns={[
        { key: "Name", label: "Name", primary: true },
        {
          key: "Amount",
          label: "Amount",
          render: (r) => {
            const v = r.Amount;
            if (typeof v !== "number") return "—";
            if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
            if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
            return `$${v.toFixed(0)}`;
          },
        },
        { key: "StageName", label: "Stage" },
        { key: "CloseDate", label: "Close date" },
        { key: "Account.Name", label: "Account", fallbackKey: "AccountId" },
      ]}
    />
  );
}
