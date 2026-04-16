/**
 * Sites detail page — status copy regression suite.
 *
 * The detail page got redesigned 2026-04-16 from a confusing 2-column
 * layout into a single-column guided flow with a status banner that
 * tells non-technical users (Max + Meghan) what to do next. The visible
 * copy is the entire UX of the banner, so it gets pinned here.
 *
 * Full UI render of the page can't go through Testing Library cleanly:
 * Next.js 16's `use(params: Promise)` suspends, and RTL's waitFor never
 * gets the scheduler tick that would resume it. When Instinct gains a
 * Playwright suite (per .ai/conventions.md), the full guided-flow E2E
 * (load → edit → save → deploy → poll → preview iframe → archive →
 * back to /sites) belongs there. This file owns the copy contract.
 */

import { statusCopy } from "@/app/(dashboard)/sites/[id]/page";

describe("statusCopy — guided-flow banner copy", () => {
  test("draft: tells the user what to do next", () => {
    const c = statusCopy("draft", false);
    expect(c.tone).toBe("info");
    expect(c.title).toBe("Draft — not yet deployed");
    expect(c.hint).toMatch(/Edit the brief/);
    expect(c.hint).toMatch(/Generate preview/);
  });

  test("provisioning: warns + sets the right expectation", () => {
    const c = statusCopy("provisioning", false);
    expect(c.tone).toBe("warning");
    expect(c.title).toMatch(/Provisioning/);
    expect(c.hint).toMatch(/refreshes automatically/);
  });

  test("deploying: warns + sets the right expectation", () => {
    const c = statusCopy("deploying", false);
    expect(c.tone).toBe("warning");
    expect(c.title).toMatch(/Deploying.*1 min/);
    expect(c.hint).toMatch(/Open button will appear/);
  });

  test("ready + has preview: success + Open/copy hint", () => {
    const c = statusCopy("ready", true);
    expect(c.tone).toBe("success");
    expect(c.title).toBe("Live — preview is ready");
    expect(c.hint).toMatch(/Click Open/);
  });

  test("ready without preview: tells user to generate", () => {
    const c = statusCopy("ready", false);
    expect(c.tone).toBe("success");
    expect(c.title).toBe("Ready");
    expect(c.hint).toMatch(/Generate preview/);
  });

  test("failed: error + recovery hint pointing at GitHub Actions", () => {
    const c = statusCopy("failed", false);
    expect(c.tone).toBe("error");
    expect(c.title).toBe("Last deploy failed");
    expect(c.hint).toMatch(/GitHub Actions logs/);
  });

  test("unknown status: passes through as info, no crash", () => {
    const c = statusCopy("frobnicating", false);
    expect(c.tone).toBe("info");
    expect(c.title).toBe("frobnicating");
  });
});
