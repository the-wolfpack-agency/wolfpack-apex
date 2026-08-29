/**
 * The first screen a client's staff sees must not carry our domain.
 *
 * The email field was placeholdered "you@wolfpack.dev". Two things wrong with
 * that: it puts our name on the first screen of somebody else's deployment, and
 * wolfpack.dev is a parked seed domain we do not even own (Null MX). A
 * placeholder exists to show the SHAPE of an input, so any real domain in one
 * is either wrong for the reader or an advert.
 *
 * WHY THIS IS A SOURCE TEST AND NOT A DEPLOYED ONE. The deployed smoke asserts
 * facts about production, and a test that asserts a fix cannot gate the pull
 * request that ships the fix: production does not have it yet. Placeholder copy
 * is a property of the code, so it is checked in the code. The demo-credentials
 * guardrail stays in the deployed suite, because whether that block renders
 * depends on an environment variable and only production can answer it.
 */
import { readFileSync } from "node:fs";

const LOGIN = "src/app/login/page.tsx";

describe("the login screen", () => {
  const source = readFileSync(LOGIN, "utf8");

  /* Placeholders only. The gated demo-credentials block legitimately contains
     wolfpack.dev seed accounts, and it is guarded separately by the deployed
     smoke, so matching the whole file would force a false choice between the
     two checks. */
  it("has no placeholder carrying our domain", () => {
    const placeholders = [...source.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]!);
    expect(placeholders.length).toBeGreaterThan(0);
    for (const p of placeholders) {
      expect(`${p}:${/wolfpack/i.test(p)}`).toBe(`${p}:false`);
    }
  });

  /* The demo-credentials block must stay behind its flag. Without the gate it
     publishes five working logins on a page needing no authentication, and a
     comment reading "local dev only" is not a control. */
  it("keeps the demo-credentials block behind an explicit flag", () => {
    const idx = source.indexOf("login-demo-credentials");
    expect(idx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, idx - 400), idx);
    expect(before).toContain("NEXT_PUBLIC_SHOW_DEMO_CREDS");
  });
});
