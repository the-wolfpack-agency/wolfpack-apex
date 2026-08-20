/**
 * Write one router call into the compliance chain.
 *
 * Separated from audit-record.ts so the SHAPE of a row stays pure and testable
 * while the write, which needs a database, lives behind one function that can
 * be stubbed. It also keeps router.ts free of audit plumbing: the router calls
 * one thing and does not care how the chain works.
 *
 * NEVER THROWS, and never blocks the answer. An audit write failing is worth
 * knowing about; it is not worth turning a completed answer into an error for
 * the person waiting on it. recordAudit already reports its own failures.
 */
import { recordAudit } from "@/lib/audit-log";
import { buildRouterAuditEntry, type RouterAuditFacts } from "./audit-record";

export async function recordRouterCall(facts: RouterAuditFacts): Promise<void> {
  try {
    await recordAudit(buildRouterAuditEntry(facts));
  } catch {
    /* Deliberately silent here: recordAudit reports its own failures, and a
       second report from the hot path would be noise on every call when the
       database is unreachable. */
  }
}
