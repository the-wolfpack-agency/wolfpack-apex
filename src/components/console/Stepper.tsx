/**
 * Stepper — a horizontal staged-progress primitive for the command center.
 *
 * Renders an ordered sequence of steps with connectors, each tinted by the one
 * severity vocabulary (severity.ts) so a "passed" / "failed" / "running" step
 * reads the same as every StatusPill elsewhere. A step glyph encodes its state
 * at a glance; the label sits beside it and an optional detail shows on hover.
 * A step with a `url` is a click-through. Pure presentational, theme-aware via
 * --wp-* tokens; no data fetching.
 *
 * Built for the deployment pipeline (CI -> merge -> build -> promote -> verify
 * -> health), but generic: any ordered {label,status} list works.
 */

"use client";

import { TONE_VAR, toneForStatus } from "./severity";

export type StepStatus =
  | "passed"
  | "running"
  | "failed"
  | "pending"
  | "skipped";

export interface StepperStep {
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
  url?: string;
}

export interface StepperProps {
  steps: StepperStep[];
  testId?: string;
}

/** A compact glyph per state. Aria-hidden; the status is conveyed textually too. */
const STEP_GLYPH: Record<StepStatus, string> = {
  passed: "✓",
  running: "●",
  failed: "✕",
  pending: "○",
  skipped: "–",
};

export function Stepper({ steps, testId = "stepper" }: StepperProps) {
  return (
    <ol
      data-testid={testId}
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.15rem",
      }}
    >
      {steps.map((step, i) => {
        const tone = TONE_VAR[toneForStatus(step.status)];
        const filled = step.status === "passed" || step.status === "failed";
        const dot = (
          <span
            data-testid={`${testId}-dot-${step.key}`}
            aria-hidden
            style={{
              width: 18,
              height: 18,
              flexShrink: 0,
              borderRadius: "50%",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              color: filled ? "var(--wp-dark, #0b0d11)" : tone,
              background: filled ? tone : "transparent",
              border: `1.5px solid ${tone}`,
              boxShadow:
                step.status === "running" ? `0 0 7px ${tone}` : "none",
            }}
          >
            {STEP_GLYPH[step.status]}
          </span>
        );

        const body = (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.2rem 0.4rem",
              borderRadius: 6,
            }}
          >
            {dot}
            <span
              data-testid={`${testId}-label-${step.key}`}
              data-status={step.status}
              style={{
                fontSize: "0.76rem",
                fontWeight: 600,
                color:
                  step.status === "skipped"
                    ? "var(--wp-text-dim, #b4bcc8)"
                    : "var(--wp-text, #e9edf4)",
                whiteSpace: "nowrap",
              }}
            >
              {step.label}
            </span>
          </span>
        );

        return (
          <li
            key={step.key}
            data-testid={`${testId}-step-${step.key}`}
            data-status={step.status}
            title={step.detail ?? `${step.label}: ${step.status}`}
            style={{ display: "inline-flex", alignItems: "center" }}
          >
            {step.url ? (
              <a
                href={step.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none" }}
              >
                {body}
              </a>
            ) : (
              body
            )}
            {i < steps.length - 1 && (
              <span
                aria-hidden
                data-testid={`${testId}-connector-${i}`}
                style={{
                  width: 14,
                  height: 2,
                  flexShrink: 0,
                  margin: "0 0.05rem",
                  borderRadius: 2,
                  background: "var(--wp-dark-border, #333)",
                }}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default Stepper;
