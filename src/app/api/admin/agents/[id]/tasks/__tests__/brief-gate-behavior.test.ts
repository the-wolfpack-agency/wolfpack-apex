/** @jest-environment node */
/**
 * What the brief check does when work reaches an agent.
 *
 * Behavioral only. An earlier draft of this file asserted the panel was ABSENT
 * from the page it used to sit on, which is a snapshot of a decision rather
 * than a property of the system: do that for every relocated feature and you
 * accumulate assertions that can only ever fail for the wrong reason.
 *
 * What is worth pinning is that the check is advisory, that its questions reach
 * the caller, and that it never records the brief text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "src/app/api/admin/agents/[id]/tasks/route.ts"),
  "utf8",
);

test("the task is created whether or not the brief is thin", () => {
  /* Refusing work over a missing sentence would make the agent unusable, and a
     gate people route around teaches them to write less. */
  const reviewAt = SRC.indexOf("reviewPrompt(goal)");
  const createAt = SRC.indexOf("await createTask(");
  expect(reviewAt).toBeGreaterThan(-1);
  expect(createAt).toBeGreaterThan(reviewAt);
  expect(SRC).not.toMatch(
    /briefReview[\s\S]{0,200}return NextResponse\.json\([\s\S]{0,120}status: 4\d\d/,
  );
});

test("the questions reach the caller, or the check is invisible", () => {
  expect(SRC).toContain("briefReview");
});

test("the event records dimensions and counts, never the brief text", () => {
  /* A brief can name a client. The surface promised never to store one. */
  expect(SRC).toContain('trackEvent("agent.brief_reviewed"');
  expect(SRC).toContain("missing_count");
  expect(SRC).toContain("dimensions");
  expect(SRC).not.toMatch(/trackEvent\("agent\.brief_reviewed"[\s\S]{0,400}\bgoal\b/);
});
