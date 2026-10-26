/** @jest-environment node */
import { recipientDomains, isRecipientAllowed, isBuildPhase, emailDomain, WOLFPACK_RECIPIENT_DOMAINS } from "@/lib/forcefield-web/recipient-allowlist";

const env = (v?: string) => (v === undefined ? {} : { FORCEFIELD_RECIPIENT_DOMAINS: v }) as NodeJS.ProcessEnv;

describe("recipient allowlist", () => {
  it("defaults to the Wolfpack domain and the build phase", () => {
    expect(recipientDomains(env())).toEqual([...WOLFPACK_RECIPIENT_DOMAINS]);
    expect(WOLFPACK_RECIPIENT_DOMAINS).toEqual(["thewolfpack.agency"]);
    expect(isBuildPhase(env())).toBe(true);
    expect(isBuildPhase(env(""))).toBe(true);
  });

  it("allows only an exact Wolfpack domain match by default", () => {
    expect(isRecipientAllowed("QA@TheWolfpack.Agency", env())).toBe(true);
    for (const bad of ["a@client.example", "a@thewolfpack.agency.evil.com", "a@sub.thewolfpack.agency", "a@notthewolfpack.agency", "a@wolfpack.dev", "thewolfpack.agency", "a@@thewolfpack.agency", " ", ""]) {
      expect([bad, isRecipientAllowed(bad, env())]).toEqual([bad, false]);
    }
  });

  it("a comma list opens exactly those domains; garbage falls back to the Wolfpack default", () => {
    expect(recipientDomains(env("thewolfpack.agency, Pilot.Example "))).toEqual(["thewolfpack.agency", "pilot.example"]);
    expect(isRecipientAllowed("x@pilot.example", env("pilot.example"))).toBe(true);
    expect(isRecipientAllowed("x@thewolfpack.agency", env("pilot.example"))).toBe(false);
    expect(recipientDomains(env("not a domain, ;;"))).toEqual(["thewolfpack.agency"]);
  });

  it("'*' is the one switch that ends the build phase", () => {
    expect(isBuildPhase(env("*"))).toBe(false);
    expect(isRecipientAllowed("owner@client.example", env("*"))).toBe(true);
    expect(isRecipientAllowed("not-an-email", env("*"))).toBe(false);
  });

  it("emailDomain parses or returns null", () => {
    expect(emailDomain("a@B.com")).toBe("b.com");
    expect(emailDomain("nope")).toBeNull();
  });
});
