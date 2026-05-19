/**
 * Shared limit constants for the `/feedback` capture flow.
 *
 * Lives in its own file (instead of `record-feedback.ts`) so the
 * widget (a `"use client"` React component) can import the cap
 * without dragging the `pg` driver into the client bundle / the
 * jsdom test environment. The server-side lib re-exports the
 * same constant so existing imports keep working.
 */

/** Maximum number of characters accepted in a single feedback message.
 *  Enforced symmetrically by:
 *    - The assistant tool's zod paramSchema (intent path).
 *    - The /api/feedback route handler (REST path).
 *    - The recordUserFeedback() lib (last-line server guard).
 *    - The FeedbackWidget textarea (live character counter + slice). */
export const MAX_FEEDBACK_LENGTH = 2000;
