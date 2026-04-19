/**
 * @jest-environment jsdom
 */

/**
 * SeoFields — React Testing Library coverage.
 *
 * The component is controlled; we assert that user interaction produces
 * the right `onChange` payload (a full new SiteBrief). Parent owns
 * persistence + analytics — those aren't tested here.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { SeoFields } from "@/components/sites/SeoFields";
import type { SiteBrief } from "@/lib/sites-schema";

function twoPageBrief(): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme", tagline: "We ship" },
    pages: [
      { route: "/", title: "Home", sections: [] },
      { route: "/about", title: "About", sections: [] },
    ],
  };
}

describe("SeoFields", () => {
  it("renders a row per page + defaults panel + favicon panel", () => {
    render(<SeoFields brief={twoPageBrief()} onChange={() => {}} />);
    expect(screen.getByTestId("seo-page-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("seo-page-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("seo-default-panel")).toBeInTheDocument();
    expect(screen.getByTestId("seo-favicon-panel")).toBeInTheDocument();
  });

  it("firing input into page 0 title bubbles an onChange with updated seo", () => {
    const onChange = jest.fn<void, [SiteBrief]>();
    render(<SeoFields brief={twoPageBrief()} onChange={onChange} />);
    // Page 0 is open by default; its title input is the first one.
    const row0 = screen.getByTestId("seo-page-row-0");
    const titleInput = row0.querySelector(
      'input[id*="title"]',
    ) as HTMLInputElement;
    expect(titleInput).toBeTruthy();
    fireEvent.change(titleInput, { target: { value: "Hello world" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.pages[0].seo?.title).toBe("Hello world");
    // Page 1 untouched
    expect(next.pages[1].seo).toBeUndefined();
  });

  it("toggling noIndex on a page emits a boolean onto page.seo.noIndex", () => {
    const onChange = jest.fn<void, [SiteBrief]>();
    render(<SeoFields brief={twoPageBrief()} onChange={onChange} />);
    const row0 = screen.getByTestId("seo-page-row-0");
    const noIndex = row0.querySelector(
      'input[type="checkbox"][id*="noindex"]',
    ) as HTMLInputElement;
    fireEvent.click(noIndex);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].pages[0].seo?.noIndex).toBe(true);
  });

  it("editing defaultSeo.description bubbles a brief.defaultSeo change", () => {
    const onChange = jest.fn<void, [SiteBrief]>();
    render(<SeoFields brief={twoPageBrief()} onChange={onChange} />);
    const panel = screen.getByTestId("seo-default-panel");
    const descInput = panel.querySelector(
      'textarea[id*="description"]',
    ) as HTMLTextAreaElement;
    fireEvent.change(descInput, { target: { value: "Site-wide default" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0];
    expect(next.defaultSeo?.description).toBe("Site-wide default");
  });

  it("editing favicon.src bubbles a brief.favicon change", () => {
    const onChange = jest.fn<void, [SiteBrief]>();
    render(<SeoFields brief={twoPageBrief()} onChange={onChange} />);
    const panel = screen.getByTestId("seo-favicon-panel");
    const srcInput = panel.querySelector(
      'input[id*="src"]',
    ) as HTMLInputElement;
    fireEvent.change(srcInput, {
      target: { value: "https://cdn.example.com/fav.ico" },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].favicon?.src).toBe(
      "https://cdn.example.com/fav.ico",
    );
  });

  it("toggling favicon.autoGenerate bubbles true", () => {
    const onChange = jest.fn<void, [SiteBrief]>();
    render(<SeoFields brief={twoPageBrief()} onChange={onChange} />);
    const panel = screen.getByTestId("seo-favicon-panel");
    const autoToggle = panel.querySelector(
      'input[type="checkbox"][id*="auto"]',
    ) as HTMLInputElement;
    fireEvent.click(autoToggle);
    expect(onChange.mock.calls[0][0].favicon?.autoGenerate).toBe(true);
  });

  it("clearing the title removes seo.title entirely (no empty-string persist)", () => {
    const onChange = jest.fn<void, [SiteBrief]>();
    const brief = twoPageBrief();
    brief.pages[0].seo = { title: "Hello" };
    render(<SeoFields brief={brief} onChange={onChange} />);
    const row0 = screen.getByTestId("seo-page-row-0");
    const titleInput = row0.querySelector(
      'input[id*="title"]',
    ) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: "" } });
    const next = onChange.mock.calls[0][0];
    // After stripping empties, the seo object should no longer carry a
    // `title` key (and may be absent altogether if nothing else survived).
    expect(next.pages[0].seo?.title).toBeUndefined();
  });
});
