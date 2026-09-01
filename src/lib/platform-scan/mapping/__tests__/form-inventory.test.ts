/**
 * Telling a system's furniture from its content.
 *
 * WHY THE FORM COUNT LIED. Mapping a real tenant on 2026-08-30 reported "94
 * forms" across 40 surfaces. Reading them, most were the same four things on
 * every screen: the vendor's support-chat widget ("New Chat", "Upload File",
 * "Submit Prompt"), a "Connect Form" panel, and a payment account chooser. The
 * client's actual forms were a minority of the number carrying their name.
 *
 * A report that says 94 when the answer is closer to a dozen is worse than one
 * that says nothing, because somebody will quote it.
 */

import { inventoryForms, CHROME_SHARE } from "@/lib/platform-scan/mapping/form-inventory";
import type { MappedForm } from "@/lib/platform-scan/mapping/types";

const form = (name: string, over: Partial<MappedForm> = {}): MappedForm => ({
  name,
  method: "get",
  fields: [],
  mutating: false,
  ...over,
});

/** n surfaces, each carrying the given forms. */
const estate = (n: number, per: (i: number) => MappedForm[]) =>
  Array.from({ length: n }, (_, i) => ({ signature: `/s${i}`, forms: per(i) }));

describe("furniture is what is on every screen", () => {
  it("moves a widget seen on the whole estate into chrome", () => {
    const inv = inventoryForms(estate(20, () => [form("New Chat")]));
    expect(inv.chrome.map((c) => c.form.name)).toEqual(["New Chat"]);
    expect(inv.content).toEqual([]);
  });

  it("keeps a form seen on one screen as content", () => {
    const inv = inventoryForms(estate(20, (i) => (i === 0 ? [form("Invoice and W9")] : [])));
    expect(inv.content.map((c) => c.form.name)).toEqual(["Invoice and W9"]);
    expect(inv.chrome).toEqual([]);
  });

  /* A genuine form sometimes appears on a list AND a detail screen. Nothing
     real is on two thirds of an estate except the frame. */
  it("keeps a form on a few screens as content", () => {
    const inv = inventoryForms(estate(20, (i) => (i < 4 ? [form("Search entries")] : [])));
    expect(inv.content.map((c) => c.form.name)).toEqual(["Search entries"]);
  });

  it("splits a real mixture the way a reader would", () => {
    const inv = inventoryForms(
      estate(20, (i) => [
        form("New Chat"),
        form("Connect Form"),
        ...(i === 3 ? [form("Video Release")] : []),
        ...(i === 7 ? [form("Change Management Plan")] : []),
      ]),
    );
    expect(inv.chrome.map((c) => c.form.name).sort()).toEqual(["Connect Form", "New Chat"]);
    expect(inv.content.map((c) => c.form.name).sort()).toEqual([
      "Change Management Plan",
      "Video Release",
    ]);
  });
});

describe("counting a form once", () => {
  /* A page with three identical inline rows has not tripled anything. */
  it("counts a form repeated on one surface as one sighting", () => {
    const inv = inventoryForms([
      { signature: "/a", forms: [form("Row"), form("Row"), form("Row")] },
    ]);
    expect(inv.content).toHaveLength(1);
    expect(inv.content[0].surfaces).toEqual(["/a"]);
  });

  /* Same name is not the same form if it asks for different things: a "Search"
     over entries and a "Search" over users are two entry points. */
  it("treats same-named forms with different fields as different forms", () => {
    const inv = inventoryForms([
      { signature: "/a", forms: [form("Search", { fields: [{ name: "q", type: "text", required: false }] })] },
      { signature: "/b", forms: [form("Search", { fields: [{ name: "user", type: "text", required: false }] })] },
    ]);
    expect(inv.content).toHaveLength(2);
  });

  it("records every surface a form was seen on", () => {
    const inv = inventoryForms(estate(3, () => [form("Everywhere")]));
    expect(inv.content[0].surfaces).toEqual(["/s0", "/s1", "/s2"]);
  });
});

describe("refusing to judge too early", () => {
  /* On a handful of surfaces there is no "most screens" to speak of, and
     calling a form furniture because it appeared on two of three would be
     arithmetic rather than a finding. */
  it("calls everything content on a small estate", () => {
    const inv = inventoryForms(estate(3, () => [form("New Chat")]));
    expect(inv.chrome).toEqual([]);
    expect(inv.content).toHaveLength(1);
  });

  it("handles an estate with no forms at all", () => {
    expect(inventoryForms(estate(10, () => []))).toEqual({ content: [], chrome: [] });
  });

  it("uses a threshold a reader can reason about", () => {
    expect(CHROME_SHARE).toBeGreaterThan(0.5);
    expect(CHROME_SHARE).toBeLessThan(1);
  });
});
