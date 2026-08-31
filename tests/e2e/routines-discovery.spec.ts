/**
 * E2E: can somebody FIND any of this?
 *
 * The rest of the arc is tested. This asks the only question that decides
 * whether any of it gets used: does a person who does not already know these
 * features exist come across them?
 *
 * The starter-prompt catalog is real application code here, not a stub. A
 * chain missing from the panel, or a chip that does not populate the composer,
 * fails this spec. That is the difference between a feature that exists and one
 * anybody runs.
 */
import { test, expect } from "@playwright/test";
import { resolveSmokeTarget, stubInstinctSession } from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

/** The panel's chips are slugged from the prompt text. */
const chip = (text: string) => `starter-prompt-whole-jobs-in-one-command-${text.slice(0, 20).replace(/\W+/g, "-")}`;


test.describe("finding the chains", () => {
  test.beforeEach(async ({ page }) => {
    await stubInstinctSession(page, { role: "cto" });
    /* THE WELCOME MODAL IS ALREADY SEEN.
     *
     * It mounts in an effect and covers the page, so clicking it closed races
     * its own appearance: the click lands before it mounts, the backdrop then
     * arrives, and everything underneath becomes unclickable. Forcing a click
     * through it is worse than useless, which this spec proved before the flag
     * was seeded: the forced click landed on a MODAL prompt and filled the
     * composer with "what's our MRR", so the assertion would have passed while
     * testing something else entirely.
     *
     * The modal has its own tests. This spec is about what somebody finds
     * afterwards. */
    await page.addInitScript(() => localStorage.setItem("instinct_welcome_seen", "1"));
    /* The assistant's own endpoint is stubbed so this spec is about DISCOVERY
       and never about whether a model answered. */
    await page.route("**/api/assistant**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          response: "Here is your day as I understand it.",
          source: "tool",
          tokensUsed: 0,
          conversationId: "c-1",
          messageId: "m-1",
        }),
      });
    });
  });

  test("a first-time visitor meets the chains without clicking anything", async ({ page }) => {
    /* THE ACTUAL FIRST-RUN PATH. The starter prompts render inline on an empty
       chat, so this is what somebody sees on the morning they have never used
       the product. Testing the header button instead would test a re-entry
       point that only matters to people who already know the panel exists. */
    await page.goto(`${target.baseUrl}/assistant`, { waitUntil: "domcontentloaded" });

    const panel = page.getByTestId("assistant-starter-prompts");
    await expect(panel).toBeVisible({ timeout: 20_000 });

    /* Somebody scanning this for the first time should meet the thing that
       saves them twenty minutes before they meet the weather. */
    await expect(panel).toContainText("Whole jobs, in one command");
    await expect(panel).toContainText("run my morning");
    await expect(panel).toContainText("what can you do");
  });

  test("clicking a chain chip puts it in the composer, ready to send", async ({ page }) => {
    /* A chip that looks clickable and does nothing is worse than no chip: it
       teaches somebody the product is broken on their first try. */
    await page.goto(`${target.baseUrl}/assistant`, { waitUntil: "domcontentloaded" });

    const panel = page.getByTestId("assistant-starter-prompts");
    await expect(panel).toBeVisible({ timeout: 20_000 });

    /* No toggling. The first category opens on arrival, which is the point of
       the change this spec forced: a new person meets the commands, not a
       closed header. Clicking the toggle here would CLOSE it. */
    const target_chip = page.getByTestId(chip("run my morning")).first();
    await expect(target_chip).toBeVisible({ timeout: 20_000 });
    await target_chip.click();

    /* The composer holds the command. Whether it then runs is the assistant's
       job and is covered by the unit and contract tests. */
    await expect(page.getByTestId("assistant-composer-input")).toHaveValue(/run my morning/i);
  });

  test("the routines page is reachable and names the chains", async ({ page }) => {
    await page.route("**/api/routines**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          builtIn: [{ command: "run my morning", description: "Your day.", steps: 5, humanSteps: 1 }],
          saved: [],
          schedules: [],
          runs: [],
          findings: [],
        }),
      });
    });

    const res = await page.goto(`${target.baseUrl}/routines`, { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId("routines-chains")).toContainText("run my morning");
  });
});
