/**
 * widget-coverage.test.ts — STUB (skipped).
 *
 * Planned guardrail: every tool that returns a `widget: WidgetSpec` in
 * its ToolSuccess must have its `kind` registered in the ChatWidget
 * renderer dispatcher (`src/components/ChatWidget.tsx`), OR appear in
 * the `WIDGET_EXEMPT_TOOLS` allowlist below with a one-phrase reason.
 *
 * Mirrors:
 *   - `src/lib/search/__tests__/provider-coverage.test.ts`
 *   - `src/lib/auth/__tests__/capability-coverage.test.ts`
 *   - `src/lib/audit-log/__tests__/audit-coverage.test.ts`
 *
 * Why skipped (today): the existing widget surface is small (5 kinds)
 * and exhaustively covered by hand. Land the full enforcement the
 * next time a new widget gets added — the walk costs nothing and the
 * explicit allowlist matches the rest of the coverage tests in the
 * repo. The stub itself documents intent and reserves the file path
 * so the convention doc's reference resolves.
 *
 * See `.ai/conventions.md` section "Widget interfaces" → "Coverage
 * guardrail (planned, not yet enforced)" for context.
 */

/** Tools that legitimately return no widget, with the reason. New
 *  entries MUST include a one-phrase reason so reviewers see WHY the
 *  tool stays text-only. */
export const WIDGET_EXEMPT_TOOLS: Record<string, string> = {
  /* All current text-only tools live here implicitly until the
   *  guardrail goes live. Documented as part of the planned rollout. */
};

describe.skip("widget-coverage (planned)", () => {
  it("placeholder — every tool returning widget has a kind registered in ChatWidget", () => {
    /* When this lands:
     *  1. Walk src/lib/assistant/tools/*.ts for files whose handler
     *     returns a `widget: {` literal in a ToolSuccess return.
     *  2. Parse the `kind:` literal from each.
     *  3. Read src/components/ChatWidget.tsx and parse the switch's
     *     case labels.
     *  4. Assert every produced kind has a matching case (or its tool
     *     file is in WIDGET_EXEMPT_TOOLS).
     */
    expect(true).toBe(true);
  });
});
