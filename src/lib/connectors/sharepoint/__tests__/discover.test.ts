/** @jest-environment node */
/**
 * Finding what we can reach but have not connected.
 *
 * The gap this exists for, measured 2026-09-02: sources for two SharePoint
 * sites out of nine, each pointing at a folder several levels down, one whole
 * site contributing ten documents. If a client hands over twenty libraries and
 * we index one folder of one of them, every answer we give is confident and
 * drawn from a fraction of what they gave us, and they have no way to tell.
 *
 * The rules worth testing are not the Graph call. They are: what counts as a
 * site, how several accounts combine into one picture, and what happens when an
 * account cannot be asked at all.
 */

import { discoverReach, describeDiscovery, type SearchAs } from "../discover";

const TENANT = "https://tenant.sharepoint.com";
const A = `${TENANT}/sites/PCNAINTERNAL`;
const B = `${TENANT}/sites/WolfpackxPCNA`;
const C = `${TENANT}/sites/OGIAM`;

const nick = { email: "nick@example.test" };
const alicia = { email: "alicia@example.test" };

/** Answers with fixed hits per account. */
const searching = (byAccount: Record<string, string[]>): SearchAs =>
  async (account) => ({ ok: true, hits: (byAccount[account.email] ?? []).map((url) => ({ url })) });

describe("what an account can reach", () => {
  it("reduces file URLs to the sites they belong to", async () => {
    const r = await discoverReach(
      [nick],
      searching({ [nick.email]: [`${A}/Shared Documents/one.docx`, `${A}/Shared Documents/two.xlsx`] }),
      [],
    );
    expect(r.reachable).toHaveLength(1);
    expect(r.reachable[0]).toMatchObject({ site: A.toLowerCase(), filesSeen: 2 });
  });

  it("counts a file once even when two accounts can see it", async () => {
    const r = await discoverReach(
      [nick, alicia],
      searching({ [nick.email]: [`${A}/x.docx`], [alicia.email]: [`${A}/x.docx`] }),
      [],
    );
    expect(r.reachable[0].filesSeen).toBe(1);
    expect(r.reachable[0].reachableBy).toEqual([alicia.email, nick.email]);
  });

  /* Reach is the union of what people can open, because that is what the
     product can read on their behalf. One person's access is not the org's. */
  it("takes the union across accounts", async () => {
    const r = await discoverReach(
      [nick, alicia],
      searching({ [nick.email]: [`${A}/x.docx`], [alicia.email]: [`${C}/y.pptx`] }),
      [],
    );
    /* Sorted, so the assertion is about the SET rather than the order the
       accounts happened to be asked in. OGIAM sorts before PCNAINTERNAL. */
    expect(r.reachable.map((s) => s.site).sort()).toEqual([C.toLowerCase(), A.toLowerCase()].sort());
  });

  it("ignores hits that are not in a site, such as personal OneDrive", async () => {
    const r = await discoverReach(
      [nick],
      searching({ [nick.email]: [`${TENANT}/personal/nick/Documents/x.docx`] }),
      [],
    );
    expect(r.reachable).toEqual([]);
  });

  it("orders by how much was seen, so the biggest gap reads first", async () => {
    const r = await discoverReach(
      [nick],
      searching({ [nick.email]: [`${A}/1`, `${A}/2`, `${A}/3`, `${B}/1`] }),
      [],
    );
    expect(r.reachable[0].site).toBe(A.toLowerCase());
  });
});

describe("the gap", () => {
  it("is what we can reach and hold no source for", async () => {
    const r = await discoverReach(
      [nick],
      searching({ [nick.email]: [`${A}/x.docx`, `${C}/y.docx`] }),
      [`${A}/Shared%20Documents/General/Ad-hoc`],
    );
    expect(r.unconnected.map((s) => s.site)).toEqual([C.toLowerCase()]);
  });

  /* A source pointing three folders deep still connects the SITE. The depth
     problem is real and is the coverage report's job; conflating them here
     would report a connected site as missing every time. */
  it("counts a site as connected however deep the source points", async () => {
    const r = await discoverReach(
      [nick],
      searching({ [nick.email]: [`${A}/Shared Documents/a/b/c/x.docx`] }),
      [`${A}/Shared%20Documents/a/b/c`],
    );
    expect(r.unconnected).toEqual([]);
  });

  it("reports nothing missing when everything reachable is connected", async () => {
    const r = await discoverReach([nick], searching({ [nick.email]: [`${A}/x`] }), [A]);
    expect(r.unconnected).toEqual([]);
  });
});

describe("an account we could not ask", () => {
  /* THE FAILURE THAT MATTERS MOST. Treating an unanswerable account as one
     that reaches nothing shrinks the reported gap exactly when the connection
     is broken, so the report would say "you are connected to everything" on
     the day it stopped working. That is the shape of every defect found this
     week: an absence reported as a healthy zero. */
  it("is recorded, not counted as reaching nothing", async () => {
    const searchAs: SearchAs = async (account) =>
      account.email === alicia.email
        ? { ok: false, reason: "no_token" }
        : { ok: true, hits: [{ url: `${A}/x.docx` }] };

    const r = await discoverReach([nick, alicia], searchAs, [A]);
    expect(r.couldNotAsk).toEqual([{ email: alicia.email, reason: "no_token" }]);
    expect(r.unconnected).toEqual([]);
  });

  it("says so in the report, so the gap is not read as complete", async () => {
    const r = await discoverReach([alicia], async () => ({ ok: false, reason: "no_token" }), []);
    const text = describeDiscovery(r).join("\n");
    expect(text).toContain("COULD NOT ASK");
    expect(text).toMatch(/may be larger than it looks/i);
  });
});

describe("what the report says", () => {
  it("names each unconnected site, its size and who can reach it", async () => {
    const r = await discoverReach([nick], searching({ [nick.email]: [`${C}/a`, `${C}/b`] }), []);
    const text = describeDiscovery(r).join("\n");
    expect(text).toContain("NOT CONNECTED");
    expect(text).toContain(C.toLowerCase());
    expect(text).toContain("2+ files");
    expect(text).toContain(nick.email);
  });

  /* Search returns what the index holds for that account, so a site whose
     files nobody has touched recently can be reachable and absent here. Saying
     that every time stops the number being read as an inventory. */
  it("always says the number is a floor", async () => {
    const r = await discoverReach([nick], searching({ [nick.email]: [] }), []);
    expect(describeDiscovery(r).join("\n")).toMatch(/floor rather than a full inventory/i);
  });
});
