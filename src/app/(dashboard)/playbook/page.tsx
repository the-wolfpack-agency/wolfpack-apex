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
 *
 * WHY IT LOOKS LIKE THIS. It shipped with the right words and no styling at
 * all: every heading at body weight, tables run together into "Microsoft 365
 * tenant consentTheir IT", and the two architecture diagrams collapsed into
 * prose because they were indented rather than fenced. Read end to end it was
 * one grey block, which is a document nobody finishes.
 *
 * A long document also needs somewhere to stand. The contents rail is built
 * from the headings themselves rather than hand-listed, so a section added to
 * the source appears in the rail without anybody remembering to add it. That
 * matters more here than on a normal page: this document is explicitly
 * expected to grow.
 */
import type { Metadata } from "next";
import { renderMarkdown, headingSlug } from "@/lib/markdown";
import { CLIENT_DEPLOYMENT_PLAYBOOK, PLAYBOOK_UPDATED } from "@/lib/playbook";
import { readPlaybookReadiness } from "@/lib/playbook/readiness";

export const metadata: Metadata = {
  title: "Client deployment playbook · Wolfpack Instinct",
  description:
    "How a client engagement is run: what has to exist first, the order the phases ship in, and when to stop and re-plan.",
};

/** The h2s, in document order. The rail is the document's own shape. */
function sections(md: string): { id: string; label: string }[] {
  return md
    .split("\n")
    .filter((l) => /^##\s+/.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim())
    .map((label) => ({ id: headingSlug(label), label }));
}

/* Read at request time, not at build time. A number baked into a bundle is a
   number that was true when somebody deployed, and this page is handed to
   clients weeks after a deploy. */
export const dynamic = "force-dynamic";

export default async function PlaybookPage() {
  /* The page owns the title and the updated date, so the document's own H1 and
     status line would be the same words twice. Dropped here rather than
     removed from the source, because the source is still readable as a
     document and should not be shaped around one surface that renders it. */
  const body = CLIENT_DEPLOYMENT_PLAYBOOK.replace(
    /^#\s+Client Deployment Playbook[^\n]*\n+Status:[^\n]*\n[^\n]*\n/,
    "",
  );
  const html = renderMarkdown(body);
  const toc = sections(body);
  const readiness = await readPlaybookReadiness();

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

      {/* ABOVE THE LAYOUT, NOT INSIDE IT.

          .wp-playbook-layout is display:flex, so a third child there does not
          sit above the article, it sits BESIDE it and takes a share of the
          row. Measured on the deployed page at a 1440px viewport: the shell is
          1120px, the contents rail 232px, and the article had been squeezed to
          366px, roughly 48 characters a line, when it should have had about
          848px. A long document at 48 characters a line is the heavy scroll
          that was reported, and it was a nesting mistake rather than a type
          choice. */}
      <div className="wp-playbook-readiness-wrap">
        {/* MEASURED, NOT ASSERTED. Every number below is read when the page is
            requested. The document used to say "eighteen integrations" while
            twelve had ever run, and told clients a second model reviewed every
            answer while it had reviewed none in ninety days. A figure that
            cannot be read says so rather than showing a zero, because this is
            the last page on which a zero should be allowed to mean
            "unmeasured". */}
        <section className="wp-playbook-readiness" data-testid="playbook-readiness">
          {/* No `id`. An id here makes it an anchor target, and the contents
              rail is built from the markdown's own headings, so it would be a
              section of the document that the rail cannot reach. */}
          <h2 className="wp-playbook-readiness-title">Where this stands, measured</h2>
          <p className="wp-playbook-sub">
            Read from the running system when you loaded this page, not written down. A line that
            could not be measured says so; none of them will ever show a zero to mean
            &quot;we did not look&quot;.
          </p>
          <dl>
            {readiness.lines.map((l) => (
              <div key={l.label} data-testid={`readiness-${l.label.toLowerCase().replace(/\W+/g, "-")}`}>
                <dt>{l.label}</dt>
                <dd>
                  <strong data-unmeasured={l.value === null ? "true" : undefined}>
                    {l.value ?? "not measurable right now"}
                  </strong>
                  <span>{l.detail}</span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <div className="wp-playbook-layout">
        <nav className="wp-playbook-toc" aria-label="Sections">
          <p className="wp-playbook-toc-title">Contents</p>
          <ol>
            {toc.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.label}</a>
              </li>
            ))}
          </ol>
        </nav>

        {/* renderMarkdown escapes every piece of text and emits only a fixed tag
            whitelist, so there is no caller-supplied HTML to sanitize here. */}
        <article
          className="wp-playbook-body wp-md"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </main>
  );
}
