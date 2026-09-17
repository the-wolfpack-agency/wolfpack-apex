import SignupForm from "./SignupForm";

export const dynamic = "force-dynamic";

/**
 * Public self-serve signup. No auth: a prospective client registers their org
 * and gets a tenant. Deliberately minimal - name + admin email - because OGIAM
 * only ever needs access to the client's own environment to function.
 */
export default function SignupPage() {
  return (
    <main data-testid="signup-page" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem 1rem", background: "var(--wp-bg, #0e1014)" }}>
      <div style={{ width: "100%", maxWidth: 440, background: "var(--wp-panel, #14171d)", border: "1px solid var(--wp-border, #2a2f3a)", borderRadius: 14, padding: "1.75rem" }}>
        <p style={{ margin: "0 0 0.4rem", fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--wp-accent, #4c8bf5)" }}>
          Get started
        </p>
        <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem", color: "var(--wp-text, #e6e9ef)" }}>Create your organization</h1>
        <p style={{ margin: "0 0 1.25rem", fontSize: "0.92rem", color: "var(--wp-text-dim, #b4bcc8)", lineHeight: 1.5 }}>
          Register to begin. Your organization gets its own isolated environment; you connect your systems after sign-in. We only ever need access to your own data.
        </p>
        <SignupForm />
        <p style={{ margin: "1.1rem 0 0", fontSize: "0.88rem", color: "var(--wp-text-dim, #b4bcc8)" }}>
          Already have an account? <a href="/login" style={{ color: "var(--wp-accent, #4c8bf5)" }}>Sign in</a>.
        </p>
      </div>
    </main>
  );
}
