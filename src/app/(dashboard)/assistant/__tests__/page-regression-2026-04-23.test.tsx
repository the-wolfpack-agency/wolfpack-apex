/**
 * @jest-environment jsdom
 *
 * REGRESSIONS — bugs reported by the user on 2026-04-23 afternoon that
 * the original page.test.tsx tests did NOT catch because they ran the
 * page in isolation with pre-shaped payloads.
 *
 *   1. /assistant replaced the reusable <InstinctChat/> with an inline
 *      rewrite, dropping the left-panel conversation history. This test
 *      asserts page.tsx still delegates to InstinctChat.
 *   2. The related-pages map did not include Settings, so responses
 *      that said "go to Settings" rendered NO chip. This test locks in
 *      a handful of pages we know the assistant names by hand.
 *   3. The old inline page.tsx called scrollIntoView without
 *      `block: "nearest"`, which caused the whole page to jump on every
 *      submit. InstinctChat uses block: "nearest"; this test locks
 *      that in so a future refactor can't silently regress it.
 */

import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

jest.mock("@/components/InstinctChat", () => ({
  __esModule: true,
  default: () => <div data-testid="instinct-chat-mount" />,
}));

import { render, screen } from "@testing-library/react";
import AssistantPage from "@/app/(dashboard)/assistant/page";
import {
  detectRelatedPages,
  detectRelatedPagesFromExchange,
} from "@/lib/assistant/related-pages";

describe("/assistant page.tsx — bug #1: must mount the reusable InstinctChat", () => {
  it("renders <InstinctChat />, not an inline rewrite", () => {
    render(<AssistantPage />);
    expect(screen.getByTestId("instinct-chat-mount")).toBeInTheDocument();
  });

  it("page.tsx is the thin shim — no inline CHAT state or chat fetches", () => {
    // Read the page source off disk so we catch any future inline
    // rewrite that removes the InstinctChat import. The page has ONE
    // job for chat: import InstinctChat and render it. The page MAY
    // host small local UI state for the support-mode pill (added
    // 2026-04-29 — semantic Q&A cache), but it MUST NOT recreate
    // chat-side state (messages / conversationId / input) or call
    // fetchWithRefresh — those belong inside InstinctChat where the
    // left-panel conversation history is wired.
    const source = readFileSync(
      resolve(__dirname, "../page.tsx"),
      "utf8",
    );
    expect(source).toMatch(/import\s+InstinctChat\s+from\s+["']@\/components\/InstinctChat["']/);
    /* Forbid the chat-state names that previously caused the regression. */
    expect(source).not.toMatch(/setMessages\b/);
    expect(source).not.toMatch(/conversationId\b/);
    expect(source).not.toMatch(/setInput\b/);
    expect(source).not.toMatch(/fetchWithRefresh/);
  });
});

describe("related-pages map — bug #2: keywords the assistant actually uses in responses", () => {
  const expectations: Array<{ text: string; domain: string; label: string }> = [
    { text: "Go to Settings in the sidebar", domain: "settings", label: "Settings" },
    { text: "Under Integrations, connect Microsoft 365", domain: "settings", label: "Settings" },
    { text: "You can disconnect at any time from the same Settings page", domain: "settings", label: "Settings" },
    { text: "Check your morning briefing on the Dashboard", domain: "dashboard", label: "Dashboard" },
    { text: "Open the Notifications center", domain: "notifications", label: "Notifications" },
    { text: "Click the Admin panel to manage workspace settings", domain: "admin", label: "Admin" },
    { text: "See Reports for the weekly report", domain: "reports", label: "Reports" },
    { text: "Use the Planner to lay out this week's plan", domain: "planner", label: "Planner" },
    { text: "Browse the team Directory", domain: "directory", label: "Directory" },
  ];

  it.each(expectations)(
    "'%p' is detected (via response-text scanning)",
    ({ text, domain, label }) => {
      const hits = detectRelatedPagesFromExchange("tell me more", text);
      const match = hits.find((h) => h.domain === domain);
      expect(match).toBeDefined();
      expect(match?.label).toBe(label);
    },
  );

  it("response-text detection unions with question detection (both sources contribute)", () => {
    const hits = detectRelatedPagesFromExchange(
      "what's on my calendar",
      "Go to Settings to connect Microsoft 365 first",
    );
    expect(hits.find((h) => h.domain === "settings")).toBeDefined();
    expect(hits.find((h) => h.domain === "calendar")).toBeDefined();
  });

  it("bare keyword map (detectRelatedPages) covers the previously-missed pages too", () => {
    expect(detectRelatedPages("open Settings").some((p) => p.domain === "settings")).toBe(true);
    expect(detectRelatedPages("Dashboard please").some((p) => p.domain === "dashboard")).toBe(true);
    expect(detectRelatedPages("Notifications center").some((p) => p.domain === "notifications")).toBe(true);
  });
});

describe("InstinctChat scroll behavior — bug #3: no page-jump on submit", () => {
  it("InstinctChat.tsx source uses scrollIntoView with block: 'nearest'", () => {
    // Lock in the anti-page-jump fix from commit 6874bc3. Any future
    // refactor that drops `block: "nearest"` re-introduces the bug.
    const source = readFileSync(
      resolve(__dirname, "../../../../components/InstinctChat.tsx"),
      "utf8",
    );
    // Every scrollIntoView call in this component MUST include
    // block: "nearest" — that's what keeps the page from scrolling the
    // whole viewport on each new message.
    const calls = [...source.matchAll(/scrollIntoView\(([^)]*)\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c[1]).toMatch(/block:\s*["']nearest["']/);
    }
  });
});
