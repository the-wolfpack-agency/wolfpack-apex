"use client";

/**
 * /portal/salesforce/accounts — accounts list with industry/owner.
 */

import SalesforceListPage from "@/components/SalesforceListPage";

export default function AccountsListPage() {
  return (
    <SalesforceListPage
      type="accounts"
      title="Accounts"
      description="All accounts. Click a row to view the full record."
      columns={[
        { key: "Name", label: "Name", primary: true },
        { key: "Industry", label: "Industry" },
        { key: "Phone", label: "Phone" },
        { key: "Owner.Name", label: "Owner", fallbackKey: "OwnerId" },
      ]}
    />
  );
}
