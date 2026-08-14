/**
 * The customer-success diagrams.
 *
 * They carry an argument, so what is tested is that the argument is intact and
 * reachable: both flows present, the closing step that makes the loop a loop,
 * and a description in words for anyone who cannot see a picture of it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import CustomerSuccessLoop from "../CustomerSuccessLoop";
import { PAGES } from "../../../../scripts/seed-engineering-wiki";

const html = renderToStaticMarkup(<CustomerSuccessLoop />);

describe("the two flows", () => {
  it("shows the traditional path with every handoff named", () => {
    for (const who of ["Client", "CS manager", "Ticket queue", "Product", "Engineering"]) {
      expect(html).toContain(who);
    }
  });

  it("shows the closed loop ending where it began: the client sees the change", () => {
    // The last step reaching the first IS the mechanism; without it this is
    // just a shorter queue.
    expect(html).toContain("The client sees the change");
    expect(html).toContain("Reporting is worth doing again");
  });

  it("describes each flow in words, not only as boxes", () => {
    /* A picture of an argument is useless to a screen reader, and this page is
       the argument. */
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toHaveLength(2);
    for (const l of labels) expect(l.length).toBeGreaterThan(120);
    expect(labels[0]).toMatch(/nobody tells the client/i);
    expect(labels[1]).toMatch(/inside the product/i);
  });

  it("loads nothing and depends on nothing", () => {
    // Same rule as the pipeline diagram: no library, no SVG, no remote asset.
    expect(html).not.toMatch(/<img|<svg|https?:\/\//);
  });
});

describe("the wiki pages it belongs to", () => {
  const slugs = PAGES.map((p) => p.slug);

  it("adds a Customer success section with the CS layer beneath it", () => {
    expect(slugs).toContain("customer-success");
    const layer = PAGES.find((p) => p.slug === "cs-layer");
    expect(layer?.parentSlug).toBe("customer-success");
  });

  it("marks every tool as live or planned, so a roadmap is never read as a product", () => {
    /* The distinction is the point: presenting what we intend to build as what
       we have built is exactly what this layer exists to stop. */
    const body = PAGES.find((p) => p.slug === "cs-layer")!.body;
    const toolRows = body.split("\n").filter((l) => l.startsWith("| ") && !l.includes("---") && !l.includes("What it is for"));
    expect(toolRows.length).toBeGreaterThan(6);
    const unmarked = toolRows.filter((r) => !/\|\s*(live|planned)\s*\|/.test(r));
    expect(unmarked).toEqual([]);
  });

  it("names the client program it is being proved on", () => {
    expect(PAGES.find((p) => p.slug === "customer-success")!.body).toContain("A Weekend with Porsche");
  });
});
