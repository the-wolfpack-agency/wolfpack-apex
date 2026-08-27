/**
 * Something on screen while the playbook reads its figures.
 *
 * The page renders live readings on every request, so it is slower than a
 * static one however tight the queries get. The left-nav link calls
 * router.push, which shows nothing at all until the new page is ready, and a
 * silent wait is indistinguishable from a button that does not work. That is
 * exactly how it was reported: "the Client Playbook button does not function
 * on click, nothing happens."
 *
 * A loading state is the half of the fix that survives the next slow query.
 */
export default function PlaybookLoading() {
  return (
    <main className="wp-playbook" data-testid="playbook-loading">
      <header className="wp-playbook-head">
        <p className="wp-playbook-eyebrow">Internal</p>
        <h1>Client deployment playbook</h1>
        <p className="wp-playbook-sub">
          Reading the current figures from the running system…
        </p>
      </header>
    </main>
  );
}
