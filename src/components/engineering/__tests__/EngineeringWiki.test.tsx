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
];

describe("EngineeringWiki", () => {
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
});
