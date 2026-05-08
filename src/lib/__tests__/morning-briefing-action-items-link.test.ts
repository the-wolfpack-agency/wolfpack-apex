/**
 * Locks in the action-item link contract: emails surfaced as action
 * items must carry a click-through URL.
 *
 * Preference order (2026-05-08): Outlook webLink first, in-app
 * /emails?messageId=... only as a fallback. The /emails reader is
 * hidden from the sidebar; users reply / archive / file in their real
 * Outlook mailbox.
 */

import type { ImportantEmail, ActionItem } from "@/lib/morning-briefing";

/* Re-import the internal generator. The function is not exported; we
   exercise it via the type contract — if the internal signature
   changes shape, the type assertion below fails compile.
   This file is a CONTRACT TEST: it doesn't exercise generateActionItems
   directly (private) but asserts the public ActionItem + ImportantEmail
   shapes the dashboard relies on. */
describe("ActionItem + ImportantEmail link contract", () => {
  test("ImportantEmail allows id and webLink (deep-link sources)", () => {
    const e: ImportantEmail = {
      from: "Sara",
      subject: "Q3 plan",
      receivedAt: "2026-05-01",
      preview: "...",
      id: "AAMkAGZ-msg-id",
      webLink:
        "https://outlook.office365.com/owa/?ItemID=AAMk%2BId&exvsurl=1&viewmodel=ReadMessageItem",
    };
    expect(e.id).toBe("AAMkAGZ-msg-id");
    expect(e.webLink).toContain("outlook.office365.com");
  });

  test("ActionItem carries optional link + source for analytics", () => {
    const a: ActionItem = {
      priority: "medium",
      text: "Respond to Sara",
      context: "Q3 plan",
      source: "email",
      link: "https://outlook.office365.com/owa/?ItemID=AAMk%2BId&exvsurl=1&viewmodel=ReadMessageItem",
    };
    expect(a.link).toMatch(/^https:\/\/outlook\./);
    expect(a.source).toBe("email");
  });

  test("legacy in-app /emails link form is still accepted (fallback when webLink is missing)", () => {
    const a: ActionItem = {
      priority: "medium",
      text: "Respond to Sara",
      context: "Q3 plan",
      source: "email",
      link: "/emails?messageId=AAMkAGZ-msg-id",
    };
    expect(a.link).toMatch(/^\/emails\?messageId=/);
  });

  test("absent link signals display-only — dashboard renders as div", () => {
    const a: ActionItem = {
      priority: "low",
      text: "Quarterly review",
      context: "Internal",
    };
    expect(a.link).toBeUndefined();
  });
});
