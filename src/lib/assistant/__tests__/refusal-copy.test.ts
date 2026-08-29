/**
 * A refusal is read by a person, not by a maintainer.
 *
 * MEASURED 2026-08-29 by asking as the roles a client actually has. A Center
 * user asked "brief me on my next meeting" and a Center manager asked "what is
 * waiting on me" and "run my morning". All three are reasonable questions.
 * All three were answered with our internals:
 *
 *   "That tool (meeting_prep) needs a higher-privilege role than yours."
 *   "This stopped at 'Reading today's calendar': tool good_morning_widget
 *    requires role * (you have dealer_manager)."
 *
 * The menu was already honest: neither role is OFFERED what it cannot run, and
 * the role-prompt lockdown covers that. This is the other path, when somebody
 * asks anyway, which they will. A tool name and a permission grade tell a
 * client nothing they can act on and read as a system error.
 */
import { sanitizeRefusal } from "@/lib/assistant";

describe("a refusal never shows our internals", () => {
  it.each([
    "tool good_morning_widget requires role * (you have dealer_manager)",
    "tool meeting_prep requires role settings.manage_team (you have dealer)",
    "tool task_list_widget requires role * (you have viewer)",
  ])("strips %j down to something readable", (raw) => {
    const out = sanitizeRefusal(raw);
    expect(out).not.toMatch(/_widget|meeting_prep|task_list|requires role/i);
    expect(out.length).toBeGreaterThan(3);
  });

  /* A GENUINE REASON SURVIVES INTACT. "Microsoft is not connected yet" is
     exactly what somebody needs to hear, and a sanitizer that ate it would
     trade one unhelpful message for another. */
  it("passes through a reason that has no internals in it", () => {
    const reason = "Microsoft is not connected yet, so I cannot read your mail.";
    expect(sanitizeRefusal(reason)).toBe(reason);
  });

  /* When stripping leaves nothing, say something useful rather than an empty
     string or a bare fragment of punctuation. */
  it("falls back to a next step when nothing readable remains", () => {
    const out = sanitizeRefusal("tool x_y requires role * (you have dealer)");
    expect(out).toMatch(/what can you do/i);
  });

  it("does not mangle ordinary prose containing underscores in words", () => {
    const reason = "The report could not be generated because the source was empty.";
    expect(sanitizeRefusal(reason)).toBe(reason);
  });
});
