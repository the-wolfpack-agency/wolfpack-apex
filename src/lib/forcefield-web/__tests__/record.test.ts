/**
 * Watch-and-report recorder - emits a workspace-scoped inspection event with the
 * class/action, uses the identified agent as actor when there is one, and never
 * throws into the caller.
 */
import { recordWebInspection, FORCEFIELD_WEB_EVENT } from "../record";
import type { WebVerdict } from "../classify";
import type { WebPostureDecision } from "../posture";

const v = (over: Partial<WebVerdict>): WebVerdict => ({ class: "normal", reason: "r", signal: "none", ...over });
const d = (over: Partial<WebPostureDecision>): WebPostureDecision => ({ action: "allow", blocked: false, recorded: false, reason: "r", ...over });

it("emits a workspace-scoped event with class/action and the agent as actor", () => {
  const trackEvent = jest.fn();
  recordWebInspection(
    { workspaceId: "w1", site: "acme.com", verdict: v({ class: "known_agent", matchedAgentId: "acme-bot" }), decision: d({ action: "welcome" }) },
    { trackEvent },
  );
  expect(trackEvent).toHaveBeenCalledWith(
    FORCEFIELD_WEB_EVENT,
    "acme-bot",
    "web",
    expect.objectContaining({ workspace_id: "w1", site: "acme.com", class: "known_agent", action: "welcome", blocked: false }),
  );
});

it("uses a stable sentinel actor for an anonymous request", () => {
  const trackEvent = jest.fn();
  recordWebInspection({ workspaceId: "w1", site: "s", verdict: v({}), decision: d({}) }, { trackEvent });
  expect(trackEvent.mock.calls[0][1]).toBe("web.anonymous");
});

it("never throws into the caller if recording fails", () => {
  const trackEvent = jest.fn(() => { throw new Error("db down"); });
  expect(() =>
    recordWebInspection({ workspaceId: "w1", site: "s", verdict: v({ class: "trapped" }), decision: d({ action: "block", blocked: true }) }, { trackEvent }),
  ).not.toThrow();
});
