/**
 * /s/[slug] — PUBLIC survey responder page.
 *
 * NO auth. Lives OUTSIDE the (dashboard) route group so anonymous
 * respondents with no Instinct session can fill the survey — same
 * precedent as /qr-missing and /q/[slug].
 *
 * Server component: resolves the published survey by slug. If it's not
 * published (or doesn't exist) we render a friendly "unavailable" card
 * rather than leaking whether the slug ever existed. Otherwise we hand
 * the public-safe fields to the client <ResponderForm>, which renders
 * each question and POSTs answers to /api/s/[slug].
 */

import type { Metadata } from "next";
import { getPublishedSurveyBySlug } from "@/lib/surveys/store";
import ResponderForm from "./ResponderForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Survey — Wolfpack Instinct",
  description: "Share your response.",
  robots: { index: false, follow: false },
};

const pageShell: React.CSSProperties = {
  minHeight: "100dvh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "2rem 1rem",
  background: "var(--wp-dark, #0b0b10)",
  color: "var(--wp-text, #f4f4f5)",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

export default async function SurveyResponderPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const survey = await getPublishedSurveyBySlug(slug);

  if (!survey) {
    return (
      <div data-testid="survey-page" style={pageShell}>
        <div
          data-testid="survey-unavailable"
          style={{
            maxWidth: "32rem",
            width: "100%",
            background: "var(--wp-dark-surface, #16161d)",
            border: "1px solid var(--wp-dark-border, #2a2a35)",
            borderRadius: "12px",
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 700,
              marginBottom: "0.75rem",
              color: "var(--wp-gold, #d4a857)",
            }}
          >
            This survey isn&apos;t available
          </h1>
          <p
            style={{
              fontSize: "1rem",
              lineHeight: 1.6,
              color: "var(--wp-text-dim, #a1a1aa)",
              margin: 0,
            }}
          >
            The survey you&apos;re looking for may have closed or the link may
            be incorrect. If you believe this is a mistake, please reach out to
            whoever shared it with you.
          </p>
          <div
            style={{
              marginTop: "1.5rem",
              fontSize: "0.75rem",
              color: "var(--wp-text-muted, #71717a)",
            }}
          >
            Wolfpack Instinct
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="survey-page" style={pageShell}>
      <ResponderForm
        slug={survey.slug}
        title={survey.title}
        description={survey.description}
        schema={survey.schema}
      />
    </div>
  );
}
