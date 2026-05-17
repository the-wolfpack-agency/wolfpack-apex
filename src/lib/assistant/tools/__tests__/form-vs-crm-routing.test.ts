/**
 * Routing regression — bare "create <object>" phrases must route to the
 * form-trigger tool, not the legacy CRM create_external_record tool.
 *
 * 2026-05-17: shipped a fix where "create task" was being swallowed by
 * the CRM tool's loose regex (/\b(?:create|add|new)\b.*\b(?:task|activity)\b/)
 * because the legacy CRM tool was imported BEFORE the form-trigger
 * tools in tools/index.ts. Re-ordered. This test pins the order via
 * a real-registry dispatch so the regression can't come back via a
 * future re-shuffle.
 */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

/* Importing the barrel triggers registerTool() for every tool in the
 * project, in the order tools/index.ts imports them. */
import "@/lib/assistant/tools";
import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => mockTrackEvent.mockClear());

describe("create-<object> routing", () => {
  test.each([
    ["create task", "create_task_form"],
    ["add a task", "create_task_form"],
    ["new task", "create_task_form"],
    ["create todo", "create_task_form"],
    ["create feature", "create_feature_form"],
    ["new feature request", "create_feature_form"],
    ["create okr", "create_okr_form"],
    ["create email", "create_email_form"],
    ["create message", "create_message_form"],
    /* "schedule a meeting" is intentionally claimed by
     * get_calendar_availability (free/busy check) — pre-existing
     * behavior unrelated to the CRM-vs-form routing fix. */
  ])("'%s' → %s (not legacy CRM)", async (phrase, expectedTool) => {
    const r = await tryDispatchTool(phrase, ctx);
    expect(r).not.toBeNull();
    expect(r!.tool).toBe(expectedTool);
  });

  /* The legacy CRM create_external_record is still the right home for
   * action-verb CRM phrasings — keep it wired up. */
  test("'log a call with Acme about Q3' still routes to legacy CRM create", async () => {
    const r = await tryDispatchTool("log a call with Acme about Q3", ctx);
    expect(r).not.toBeNull();
    expect(r!.tool).toBe("create_external_record");
  });
});
