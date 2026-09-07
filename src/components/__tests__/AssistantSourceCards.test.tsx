/**
 * @jest-environment jsdom
 *
 * Source cards: the clean replacement for the raw-URL "Sources retrieved" dump.
 *
 * What matters: a document opens in its own source (new tab for an external
 * SharePoint link), the open fires the learning-loop callback, an in-app link
 * stays in-app, an unsafe/empty URL never becomes a clickable link, and the
 * filename is shown (not the giant percent-encoded URL).
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AssistantSourceCards from "@/components/AssistantSourceCards";

const sharePointUrl =
  "https://netorg9503444.sharepoint.com/sites/WolfpackxPCNA/Shared%20Documents/General/viaPeople%20Work%20Order.docx.pdf";

describe("AssistantSourceCards", () => {
  it("shows the filename, not the raw URL, and opens the doc in its source", () => {
    render(
      <AssistantSourceCards
        sources={[{ id: "s1", title: "viaPeople Work Order.docx.pdf", url: sharePointUrl, type: "sharepoint" }]}
      />,
    );
    const card = screen.getByTestId("source-card-s1");
    // Shows a readable, cleaned document title (not the raw filename or URL).
    expect(card).toHaveTextContent("viaPeople Work Order");
    // The giant encoded URL is not rendered as visible text.
    expect(card).not.toHaveTextContent("Shared%20Documents");
    // External link opens in a new tab, in the source system.
    expect(card).toHaveAttribute("href", sharePointUrl);
    expect(card).toHaveAttribute("target", "_blank");
    expect(card).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("fires onOpen when a card is opened", async () => {
    const onOpen = jest.fn();
    render(
      <AssistantSourceCards
        sources={[{ id: "s1", title: "Report.pdf", url: sharePointUrl, type: "sharepoint" }]}
        onOpen={onOpen}
      />,
    );
    await userEvent.click(screen.getByTestId("source-card-s1"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", type: "sharepoint" }));
  });

  it("keeps an in-app link in-app (no new tab)", () => {
    render(
      <AssistantSourceCards
        sources={[{ id: "s2", title: "Sites", url: "/sites", type: "site" }]}
      />,
    );
    const card = screen.getByTestId("source-card-s2");
    expect(card).toHaveAttribute("href", "/sites");
    expect(card).not.toHaveAttribute("target");
  });

  it("renders an unsafe/empty URL as a non-clickable card, never a link", () => {
    render(
      <AssistantSourceCards
        sources={[{ id: "s3", title: "javascript-thing", url: "javascript:alert(1)", type: "knowledge" }]}
      />,
    );
    const card = screen.getByTestId("source-card-s3");
    expect(card.tagName).toBe("DIV"); // not an <a>
  });

  it("derives a file-type badge from the extension", () => {
    render(
      <AssistantSourceCards
        sources={[
          { id: "a", title: "budget.xlsx", url: "https://x/y.xlsx", type: "sharepoint" },
          { id: "b", title: "deck.pptx", url: "https://x/y.pptx", type: "sharepoint" },
        ]}
      />,
    );
    expect(screen.getByTestId("source-card-a")).toHaveTextContent("XLS");
    expect(screen.getByTestId("source-card-b")).toHaveTextContent("PPT");
  });

  it("renders nothing for an empty source list", () => {
    const { container } = render(<AssistantSourceCards sources={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

import { cleanDisplayName } from "@/components/AssistantSourceCards";

describe("cleanDisplayName — readable document titles for the client", () => {
  it("turns the ugly SOW filename into a readable title", () => {
    expect(
      cleanDisplayName("viaPeople Work Order_Wolfpack Agency_360 Feedback_5-7-25[36].docx.pdf"),
    ).toBe("viaPeople Work Order Wolfpack Agency 360 Feedback 5-7-25");
  });

  it("decodes a percent-encoded URL-derived name and keeps the basename", () => {
    expect(
      cleanDisplayName("https://x.sharepoint.com/sites/a/Shared%20Documents/Budget%20Q3.xlsx"),
    ).toBe("Budget Q3");
  });

  it("drops a single extension (the badge shows the type)", () => {
    expect(cleanDisplayName("BA101 Mobile Coach Rules.csv")).toBe("BA101 Mobile Coach Rules");
  });

  it("leaves an already-clean title alone", () => {
    expect(cleanDisplayName("Academy Strategy")).toBe("Academy Strategy");
  });
});
