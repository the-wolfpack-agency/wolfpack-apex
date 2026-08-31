/**
 * The consent document must agree with the consent screen.
 *
 * A client's security review approves one list and the Microsoft sign-in shows
 * another: that is the moment trust goes, and it happens by drift rather than
 * by intent. microsoft-graph.ts holds the only real scope list, so this reads
 * it from source and fails when this pack disagrees.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ACCESS_REQUESTS,
  adminConsentRequests,
  coveredScopes,
  accessPackMarkdown,
} from "../access-pack";

const SOURCE = path.resolve(__dirname, "..", "..", "microsoft-graph.ts");

/** Scopes actually requested today: quoted strings, excluding commented lines. */
function activeScopes(): Set<string> {
  const src = fs.readFileSync(SOURCE, "utf-8");
  const block = src.slice(src.indexOf("const MS_SCOPES"), src.indexOf("const MS_SCOPES_STRING"));
  const out = new Set<string>();
  for (const line of block.split("\n")) {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
    const m = /^"([A-Za-z._]+)",?$/.exec(code);
    if (m) out.add(m[1]);
  }
  return out;
}

/** Scopes named in the file but commented out, i.e. deliberately switched off. */
function disabledScopes(): Set<string> {
  const src = fs.readFileSync(SOURCE, "utf-8");
  const block = src.slice(src.indexOf("const MS_SCOPES"), src.indexOf("const MS_SCOPES_STRING"));
  const out = new Set<string>();
  for (const line of block.split("\n")) {
    const m = /^\s*\/\/\s*"([A-Za-z._]+)",?\s*$/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

describe("the pack agrees with what is actually requested", () => {
  it("reads a real scope list, or the rest of this file proves nothing", () => {
    const active = activeScopes();
    expect(active.size).toBeGreaterThan(10);
    expect(active.has("Files.ReadWrite.All")).toBe(true);
    expect(disabledScopes().size).toBeGreaterThan(0);
  });

  /* A scope we request and do not disclose is the failure this exists for. */
  it("accounts for every scope currently requested", () => {
    const missing = [...activeScopes()].filter((s) => !coveredScopes().has(s));
    expect(missing).toEqual([]);
  });

  /* And the reverse: a pack claiming a permission nobody asks for inflates
     what the client thinks they approved. */
  it("claims no scope the product does not request", () => {
    const known = new Set([...activeScopes(), ...disabledScopes()]);
    const invented = [...coveredScopes()].filter((s) => !known.has(s));
    expect(invented).toEqual([]);
  });

  /* Admin consent is the axis the whole conversation turns on. Marking an
     active self-consent scope as needing an administrator would send a client
     into a tenant-wide approval they never needed. */
  it("marks as admin-consent only the scopes that are switched off for that reason", () => {
    const disabled = disabledScopes();
    for (const r of adminConsentRequests()) {
      for (const s of r.scopes) {
        expect({ scope: s, disabled: disabled.has(s) }).toEqual({ scope: s, disabled: true });
      }
    }
  });

  it("does not mark a self-consent scope as needing an administrator", () => {
    const active = activeScopes();
    for (const r of ACCESS_REQUESTS.filter((r) => !r.needsAdminConsent)) {
      for (const s of r.scopes) {
        expect({ scope: s, active: active.has(s) }).toEqual({ scope: s, active: true });
      }
    }
  });
});

describe("what the document says", () => {
  it("states the consequence of declining, for every request", () => {
    for (const r of ACCESS_REQUESTS) {
      expect(r.ifDeclined.length).toBeGreaterThan(20);
      expect(r.unlocks.length).toBeGreaterThan(20);
    }
  });

  it("shows the administrator the exact permission strings they will see", () => {
    const md = accessPackMarkdown("all");
    for (const r of adminConsentRequests()) {
      for (const s of r.scopes) expect(md).toContain(s);
    }
  });

  /* A phase one conversation stays a phase one conversation. A client asked
     for CRM access during a document pilot reasonably wonders what else is
     coming. */
  it("keeps later phases out of the phase one document", () => {
    const md = accessPackMarkdown(1);
    expect(md).not.toMatch(/dealer management/i);
    expect(accessPackMarkdown("all")).toMatch(/dealer management/i);
  });

  /* NOTHING HERE PROMISES WHAT IS NOT SHIPPED. MFA on admin is not shipped and
     Neo4j has never been configured, so the deployment is a double write. A
     readiness document that oversells is a liability at the moment somebody
     checks. */
  it("claims no security posture the product does not have", () => {
    const md = accessPackMarkdown("all").toLowerCase();
    expect(md).not.toMatch(/multi-factor|\bmfa\b/);
    expect(md).not.toMatch(/triple.write/);
    expect(md).not.toMatch(/quantum.safe/);
  });

  it("says plainly that a person sees only what they already can", () => {
    expect(accessPackMarkdown(1)).toMatch(/only what their existing Microsoft 365/i);
  });
});
