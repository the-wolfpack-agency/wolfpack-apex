"use client";

/**
 * /portal/salesforce/contacts — searchable contact list.
 * Thin wrapper over SalesforceListPage. Defines only the columns this
 * surface cares about; everything else (fetch, debounce, modal, load
 * more) lives in the shared component so changing a column doesn't
 * fork the data layer.
 */

import SalesforceListPage from "@/components/SalesforceListPage";

export default function ContactsListPage() {
  return (
    <SalesforceListPage
      type="contacts"
      title="Contacts"
      description="Search Salesforce contacts. Click a row to drill in, edit, or open the record in Salesforce."
      columns={[
        { key: "Name", label: "Name", primary: true },
        { key: "Email", label: "Email" },
        { key: "Phone", label: "Phone" },
        { key: "Account.Name", label: "Account", fallbackKey: "AccountId" },
        {
          key: "LastModifiedDate",
          label: "Last modified",
          render: (r) => {
            const v = r.LastModifiedDate;
            return typeof v === "string" ? new Date(v).toLocaleString() : "—";
          },
        },
      ]}
    />
  );
}
