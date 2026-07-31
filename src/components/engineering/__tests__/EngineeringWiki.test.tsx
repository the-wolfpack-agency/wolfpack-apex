/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";

// The component imports only the client-safe half (@/lib/engineering-tree: types
// + buildTree, no db, no sanitizer) and renders `bodyHtml` (pre-rendered +
// sanitized on the server). The sanitizer's real output is covered by markdown's
// own node-env tests; here we just supply the already-rendered HTML the API
// would have produced, so no module needs stubbing.

import { render, screen, fireEvent, within } from "@testing-library/react";
import EngineeringWiki from "@/components/engineering/EngineeringWiki";
import type { WikiPage } from "@/lib/engineering-tree";

const PAGES: WikiPage[] = [
  {
    id: "1",
    slug: "overview",
    parentSlug: null,
    title: "Overview",
    body: "## Hello\n\nWelcome text.",
    bodyHtml: "<h2>Hello</h2>\n<p>Welcome text.</p>",
    position: 0,
    published: true,
    createdBy: null,
    updatedAt: "",
  },
  {
    id: "2",
    slug: "tools",
    parentSlug: "overview",
    title: "Tools",
    body: "- TypeScript\n- Next.js",
    bodyHtml: "<ul><li>TypeScript</li><li>Next.js</li></ul>",
    position: 0,
    published: true,
    createdBy: null,
    updatedAt: "",
  },
  {
    id: "3",
    slug: "testing-and-quality",
    parentSlug: null,
    title: "Testing and quality",
    body: "## How a change is verified",
    bodyHtml: "<h2>How a change is verified</h2>",
    position: 1,
    published: true,
    createdBy: null,
    updatedAt: "",
  },
];

describe("EngineeringWiki", () => {
  beforeEach(() => {
    // Reset the URL between tests so the ?page= deep-link state does not leak.
    window.history.replaceState(null, "", "/engineering");
  });

  it("reflects the selected page in the URL and reads it back on mount", () => {
    const { unmount } = render(<EngineeringWiki pages={PAGES} />);
    // Selecting a page deep-links it.
    fireEvent.click(screen.getByTestId("wiki-nav-tools"));
    expect(window.location.search).toContain("page=tools");
    unmount();
    // A fresh mount with that URL opens the same page.
    render(<EngineeringWiki pages={PAGES} />);
    const content = screen.getByTestId("wiki-content");
    expect(within(content).getByText(/TypeScript/)).toBeInTheDocument();
  });

  it("copies a shareable link to the current page", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<EngineeringWiki pages={PAGES} />);
    fireEvent.click(screen.getByTestId("wiki-nav-tools"));
    fireEvent.click(screen.getByTestId("wiki-copy-link"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/engineering?page=tools"));
  });

  it("renders nav buttons for both pages", () => {
    render(<EngineeringWiki pages={PAGES} />);
    expect(screen.getByTestId("wiki-nav-overview")).toBeInTheDocument();
    expect(screen.getByTestId("wiki-nav-tools")).toBeInTheDocument();
  });

  it("shows the first page's rendered body by default", () => {
    render(<EngineeringWiki pages={PAGES} />);
    const content = screen.getByTestId("wiki-content");
    expect(within(content).getByText(/Welcome text/)).toBeInTheDocument();
  });

  it("shows the clicked page's body after selecting it", () => {
    render(<EngineeringWiki pages={PAGES} />);
    fireEvent.click(screen.getByTestId("wiki-nav-tools"));
    const content = screen.getByTestId("wiki-content");
    expect(within(content).getByText(/TypeScript/)).toBeInTheDocument();
  });

  it("renders the empty state when there are no pages", () => {
    render(<EngineeringWiki pages={[]} />);
    expect(screen.getByTestId("wiki-empty")).toBeInTheDocument();
  });

  it("toggles the mobile nav and collapses it when a page is selected", () => {
    render(<EngineeringWiki pages={PAGES} />);
    const toggle = screen.getByTestId("wiki-nav-toggle");
    // Collapsed by default (content-first on mobile).
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Opens the nav.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Selecting a page collapses the nav again (so content is shown on mobile).
    fireEvent.click(screen.getByTestId("wiki-nav-tools"));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the AgenticQA pipeline diagram only on the testing-and-quality page", () => {
    render(<EngineeringWiki pages={PAGES} />);
    // Default page (overview) has no diagram.
    expect(screen.queryByTestId("agenticqa-pipeline")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("wiki-nav-testing-and-quality"));
    expect(screen.getByTestId("agenticqa-pipeline")).toBeInTheDocument();
  });
});
