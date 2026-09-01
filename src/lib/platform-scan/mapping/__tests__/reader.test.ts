/**
 * @jest-environment jsdom
 *
 * Reading a surface, using the plumbing that already existed.
 *
 * NOTHING HERE ACQUIRES A BROWSER OR INVENTS A SAFETY RULE. ScanPage,
 * installReadOnlyFloor and createSpecDiffBrowser all already exist and are
 * used elsewhere in this product. This adds only the harvest, and the harvest
 * is written self-contained precisely so jsdom can call it directly, which is
 * the pattern capture.ts already established.
 */

import { harvestSurface, judgeForm } from "@/lib/platform-scan/mapping/reader";

function render(html: string) {
  document.body.innerHTML = html;
}

describe("reading the shape of a page", () => {
  it("names the screen from its headings", () => {
    document.title = "Forms · Cognito";
    render("<h1>Your Forms</h1><h2>Recent</h2>");
    const h = harvestSurface();
    expect(h.title).toBe("Forms · Cognito");
    expect(h.headings).toEqual(["Your Forms", "Recent"]);
  });

  it("resolves links to absolute urls", () => {
    render('<a href="/forms">Forms</a><a href="https://other.example/x">Away</a>');
    const links = harvestSurface().links;
    expect(links[0]).toMatch(/\/forms$/);
    expect(links[1]).toBe("https://other.example/x");
  });

  /* A table is how a business object shows itself: the columns describe the
     entity, the row count describes how much of it there is. */
  it("reads a table as an entity's shape", () => {
    render(
      `<table><caption>Responses</caption>
        <thead><tr><th>Name</th><th>Submitted</th></tr></thead>
        <tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody>
      </table>`,
    );
    const t = harvestSurface().tables[0];
    expect(t.caption).toBe("Responses");
    expect(t.columns).toEqual(["Name", "Submitted"]);
    expect(t.rowCount).toBe(2);
  });

  /* A form is where information ENTERS a system, and the list of them is the
     part a client most often cannot produce about themselves. */
  it("reads a form without submitting it", () => {
    render(
      `<form method="post"><legend>Invite a user</legend>
        <input name="email" type="email" required><input type="submit" value="Send invite">
      </form>`,
    );
    const f = harvestSurface().forms[0];
    expect(f.name).toBe("Invite a user");
    expect(f.method).toBe("post");
    expect(f.fields).toEqual([{ name: "email", type: "email", required: true }]);
  });

  it("falls back to a submit label when a form has no legend", () => {
    render('<form><button>Search</button></form>');
    expect(harvestSurface().forms[0].name).toBe("Search");
  });

  /* A hidden control is not on screen, so flagging it would be a finding about
     something nobody can see. */
  it("skips invisible elements", () => {
    render('<button style="display:none">Delete</button><button>Next</button>');
    const controls = harvestSurface().controls;
    expect(controls.map((c) => c.text)).toEqual(["Next"]);
  });

  /* EVERY control, unfiltered: the policy decides what may be touched, not the
     reader. A reader that pre-filtered would hide what it declined. */
  it("returns controls the policy will refuse, rather than dropping them", () => {
    render("<button>Delete everything</button><button>Next</button>");
    expect(harvestSurface().controls).toHaveLength(2);
  });

  it("carries the attributes the policy needs to judge", () => {
    render('<button role="tab" aria-expanded="false" aria-label="Details" disabled></button>');
    const c = harvestSurface().controls[0];
    expect(c.role).toBe("tab");
    expect(c.ariaExpanded).toBe(false);
    expect(c.label).toBe("Details");
    expect(c.disabled).toBe(true);
  });
});

/**
 * REUSES THE CLICK POLICY rather than restating its word list. Two copies of
 * "what counts as mutating" would drift apart the first time one was updated.
 */
describe("deciding whether a form changes something", () => {
  const form = (over: Partial<Parameters<typeof judgeForm>[0]> = {}) =>
    judgeForm({ name: "f", method: "get", fields: [], submitLabel: "", ...over });

  it("treats a non-GET method as mutating on its own", () => {
    expect(form({ method: "post" }).mutating).toBe(true);
  });

  it("reads a mutating submit label even on a GET form", () => {
    expect(form({ method: "get", submitLabel: "Create form" }).mutating).toBe(true);
  });

  /* A search box is a GET form with a harmless submit, and calling it mutating
     would put every search on a client's estate into the report as a risk. */
  it("does not call a search form mutating", () => {
    expect(form({ method: "get", submitLabel: "Search" }).mutating).toBe(false);
  });

  it("keeps the fields it was given", () => {
    const f = form({ fields: [{ name: "q", type: "text", required: false }] });
    expect(f.fields).toHaveLength(1);
  });
});

/**
 * Fields that live outside a form element, which on a modern application is
 * most of them.
 *
 * Mapping a real tenant reported "3 distinct forms" on a system with fifteen,
 * and the three were furniture. The fifteen are built in a canvas editor that
 * renders inputs inside plain divs, which is ordinary practice in every React
 * application written in the last decade. That is the difference between a map
 * somebody can act on and a list of names that leaves them opening fifteen
 * screens by hand.
 */
describe("a screen that collects data without a form element", () => {
  const render = (html: string) => {
    document.body.innerHTML = html;
    return harvestSurface();
  };

  it("finds the fields anyway", () => {
    const out = render(`
      <h1>Brand Ambassador Change Management Plan</h1>
      <div class="builder">
        <input name="centerNumber" type="text" required />
        <input name="emailAddress" type="email" />
        <select name="region"><option>East</option></select>
        <textarea name="notes"></textarea>
      </div>`);
    const loose = out.forms.find((f) => f.method === "none")!;
    expect(loose.fields.map((f) => f.name)).toEqual([
      "centerNumber",
      "emailAddress",
      "region",
      "notes",
    ]);
  });

  it("names the record after the screen, since there is no legend to use", () => {
    const out = render(`<h1>Porsche CRM</h1><div><input name="a" /></div>`);
    expect(out.forms.find((f) => f.method === "none")!.name).toBe("Porsche CRM");
  });

  /* NOT GUESSED INTO FORMS. With no form element there is no reliable
     boundary between one form and the next, and inventing one would file
     fields under headings they do not belong to. */
  it("reports one record per screen rather than inventing form boundaries", () => {
    const out = render(`
      <h1>Settings</h1>
      <div><h2>Profile</h2><input name="a" /></div>
      <div><h2>Billing</h2><input name="b" /></div>`);
    const loose = out.forms.filter((f) => f.method === "none");
    expect(loose).toHaveLength(1);
    expect(loose[0].fields.map((f) => f.name)).toEqual(["a", "b"]);
  });

  /* A field already inside a form is that form's, and counting it twice would
     inflate every count drawn from this. */
  it("does not count a field that belongs to a real form", () => {
    const out = render(`
      <form><input name="inside" /></form>
      <div><input name="outside" /></div>`);
    const loose = out.forms.find((f) => f.method === "none")!;
    expect(loose.fields.map((f) => f.name)).toEqual(["outside"]);
  });

  it("ignores buttons and hidden state, which are not data somebody enters", () => {
    const out = render(`
      <div>
        <input name="real" />
        <input type="hidden" name="csrf" />
        <input type="submit" value="Save" />
        <input type="button" value="Cancel" />
      </div>`);
    expect(out.forms.find((f) => f.method === "none")!.fields.map((f) => f.name)).toEqual(["real"]);
  });

  /* An unnamed field still says the screen collects something, which is the
     question being asked. */
  it("falls back to the accessible label when there is no name", () => {
    const out = render(`<div><input aria-label="Center number" /><input placeholder="VIN" /></div>`);
    expect(out.forms.find((f) => f.method === "none")!.fields.map((f) => f.name)).toEqual([
      "Center number",
      "VIN",
    ]);
  });

  it("says nothing about a screen that collects nothing", () => {
    const out = render(`<h1>Read only</h1><p>Just text.</p>`);
    expect(out.forms.filter((f) => f.method === "none")).toEqual([]);
  });

  /* "none" is the discriminator: nothing was declared, so nothing may be
     assumed about what pressing a button on this screen would do. */
  it("marks the record so nobody reads a method into it", () => {
    const out = render(`<div><input name="a" /></div>`);
    expect(out.forms.find((f) => f.name.length > 0)!.method).toBe("none");
  });
});
