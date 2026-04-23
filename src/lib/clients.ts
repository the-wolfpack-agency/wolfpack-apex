/**
 * Client Context Library — Manage client records and linked documents.
 *
 * Tracks client information, links generated docs to clients,
 * feeds analytics for proposal generation and relationship management.
 */

import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export interface Client {
  id: string;
  name: string;
  industry: string | null;
  contact_email: string | null;
  contact_name: string | null;
  notes: string | null;
  docs: unknown[];
  created_at: string;
  updated_at: string;
}

export interface ClientUpdate {
  name?: string;
  industry?: string;
  contact_email?: string;
  contact_name?: string;
  notes?: string;
}

/**
 * Create a new client record.
 */
export async function createClient(
  name: string,
  industry?: string,
  contactEmail?: string,
  contactName?: string,
  notes?: string,
): Promise<Client | null> {
  const { rows } = await safeQuery<Client>(
    `INSERT INTO instinct_clients (name, industry, contact_email, contact_name, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, industry || null, contactEmail || null, contactName || null, notes || null],
  );

  if (rows.length > 0) {
    trackEvent("client.doc_generated", rows[0].id, "unknown", {
      action: "client_created",
      client_name: name,
    });
    return rows[0];
  }

  // Shadow mode
  return {
    id: `demo-client-${Date.now()}`,
    name,
    industry: industry || null,
    contact_email: contactEmail || null,
    contact_name: contactName || null,
    notes: notes || null,
    docs: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Update a client record.
 */
export async function updateClient(
  clientId: string,
  updates: ClientUpdate,
): Promise<Client | null> {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    setClauses.push(`name = $${idx++}`);
    params.push(updates.name);
  }
  if (updates.industry !== undefined) {
    setClauses.push(`industry = $${idx++}`);
    params.push(updates.industry);
  }
  if (updates.contact_email !== undefined) {
    setClauses.push(`contact_email = $${idx++}`);
    params.push(updates.contact_email);
  }
  if (updates.contact_name !== undefined) {
    setClauses.push(`contact_name = $${idx++}`);
    params.push(updates.contact_name);
  }
  if (updates.notes !== undefined) {
    setClauses.push(`notes = $${idx++}`);
    params.push(updates.notes);
  }

  if (setClauses.length === 0) return null;

  setClauses.push("updated_at = NOW()");
  params.push(clientId);

  const { rows } = await safeQuery<Client>(
    `UPDATE instinct_clients SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
    params,
  );

  if (rows.length > 0) {
    // Fire a generic edit event so the learning loop can grade which
    // fields sales tweaks most often. Keep the event tight — no
    // before/after values, just the column names.
    trackEvent("clients.edited", clientId, "unknown", {
      client_id: clientId,
      fields: Object.keys(updates).join(","),
    });
    return rows[0];
  }
  return null;
}

/**
 * List all clients.
 */
export async function getClients(): Promise<Client[]> {
  const { rows } = await safeQuery<Client>(
    `SELECT * FROM instinct_clients ORDER BY name ASC`,
  );
  return rows;
}

/**
 * Get a single client by ID.
 */
export async function getClient(clientId: string): Promise<Client | null> {
  const { rows } = await safeQuery<Client>(
    `SELECT * FROM instinct_clients WHERE id = $1`,
    [clientId],
  );
  return rows[0] || null;
}

/**
 * Delete a client record. Hard delete — instinct_clients has no
 * soft-delete column yet; if/when it does, swap to UPDATE SET deleted_at.
 * Fires `clients.deleted`. Returns true when a row was removed.
 */
export async function deleteClient(
  clientId: string,
  userId: string,
): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    trackEvent("clients.deleted", userId, "unknown", { client_id: clientId });
    return true;
  }
  const result = await safeQuery(
    `DELETE FROM instinct_clients WHERE id = $1`,
    [clientId],
  );
  const affected = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  if (affected > 0) {
    trackEvent("clients.deleted", userId, "unknown", { client_id: clientId });
    return true;
  }
  return false;
}

/**
 * Link a document to a client by appending to the docs JSONB array.
 */
export async function linkDocToClient(
  clientId: string,
  docId: string,
): Promise<Client | null> {
  const { rows } = await safeQuery<Client>(
    `UPDATE instinct_clients
     SET docs = docs || $1::jsonb, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [JSON.stringify([docId]), clientId],
  );

  if (rows.length > 0) {
    trackEvent("client.doc_generated", clientId, "unknown", {
      action: "doc_linked",
      doc_id: docId,
    });
    return rows[0];
  }
  return null;
}
