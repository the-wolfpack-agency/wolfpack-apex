/**
 * /playbook - how a client engagement is actually run.
 *
 * A page rather than a document in a folder, because the people who need it
 * are the people already in here, and a plan nobody opens is a plan nobody
 * follows. It is expected to change as capability changes: the phases are the
 * argument and the dates inside them move.
 *
 * Server-rendered from a module rather than read from disk. A page that reads
 * a markdown file at request time depends on that file being traced into the
 * serverless bundle, and this repo has already lost /engineering to a markdown
 * path that did not survive the build.
 */
import type { Metadata } from "next";
import { renderMarkdown } from "@/lib/markdown";
import { CLIENT_DEPLOYMENT_PLAYBOOK, PLAYBOOK_UPDATED } from "@/lib/playbook";

export const metadata: Metadata = {
  title: "Client deployment playbook · Wolfpack Instinct",
  description:
    "How a client engagement is run: what has to exist first, the order the phases ship in, and when to stop and re-plan.",
};

export default function PlaybookPage() {
  /* The page owns the title and the updated date, so the document's own H1 and
     status line would be the same words twice. Dropped here rather than
     removed from the source, because the source is still readable as a
     document and should not be shaped around one surface that renders it. */
  const body = CLIENT_DEPLOYMENT_PLAYBOOK.replace(
    /^#\s+Client Deployment Playbook[^\n]*\n+Status:[^\n]*\n[^\n]*\n/,
    "",
  );
  const html = renderMarkdown(body);
  return (
    <main className="wp-playbook" data-testid="client-deployment-playbook">
      <header className="wp-playbook-head">
        <p className="wp-playbook-eyebrow">Internal</p>
        <h1>Client deployment playbook</h1>
        <p className="wp-playbook-sub">
          Living document. Last updated {PLAYBOOK_UPDATED}. The order of the phases is the
          argument; the dates inside them move as capability does.
        </p>
      </header>
      {/* renderMarkdown escapes every piece of text and emits only a fixed tag
          whitelist, so there is no caller-supplied HTML to sanitize here. */}
      <article
        className="wp-playbook-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </main>
  );
}
