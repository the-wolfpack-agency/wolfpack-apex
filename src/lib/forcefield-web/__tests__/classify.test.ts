/**
 * Web request classifier - the deterministic split between proof (a decoy trip),
 * a welcome-lane match, a weak hint, and a normal visitor.
 */
import { classifyWebRequest, type SiteForcefieldConfig } from "../classify";

const config: SiteForcefieldConfig = {
  trapPaths: ["/_ff/deadbeef", "/admin/secret-export"],
  knownAgents: [
    { id: "acme-assistant", uaMatch: "AcmeAssistant" },
    { id: "partner-bot", uaMatch: "PartnerBot/2" },
  ],
};

const req = (path: string, userAgent = "Mozilla/5.0", method = "GET") => ({ path, method, userAgent });

it("a decoy trip is the high-confidence signal and wins over everything", () => {
  // Even a known-agent UA is trapped if it follows a honeypot path - a hijacked
  // good agent is still contained.
  const v = classifyWebRequest(req("/_ff/deadbeef", "AcmeAssistant/1.0"), config);
  expect(v.class).toBe("trapped");
  expect(v.signal).toBe("high");
  expect(v.matchedTrapPath).toBe("/_ff/deadbeef");
});

it("a known agent on a normal path gets the welcome lane", () => {
  const v = classifyWebRequest(req("/pricing", "AcmeAssistant/1.0 (+https://acme.example)"), config);
  expect(v.class).toBe("known_agent");
  expect(v.matchedAgentId).toBe("acme-assistant");
  expect(v.signal).toBe("none");
});

it("a self-declared bot not on the allowlist is suspicious - a weak, report-only hint", () => {
  const v = classifyWebRequest(req("/pricing", "EvilScraperBot/9"), config);
  expect(v.class).toBe("suspicious");
  expect(v.signal).toBe("info"); // never "high": a page-level signal is not proof
});

it("a normal visitor is normal", () => {
  const v = classifyWebRequest(req("/pricing", "Mozilla/5.0 (Macintosh)"), config);
  expect(v.class).toBe("normal");
  expect(v.signal).toBe("none");
});

it("matching is case-insensitive on the user agent", () => {
  const v = classifyWebRequest(req("/x", "partnerbot/2.1"), config);
  expect(v.class).toBe("known_agent");
  expect(v.matchedAgentId).toBe("partner-bot");
});

it("is deterministic: same input yields the same verdict", () => {
  const a = classifyWebRequest(req("/_ff/deadbeef"), config);
  const b = classifyWebRequest(req("/_ff/deadbeef"), config);
  expect(a).toEqual(b);
});
