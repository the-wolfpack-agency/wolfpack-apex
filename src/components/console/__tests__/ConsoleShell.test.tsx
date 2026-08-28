/**
 * @jest-environment jsdom
 */

/**
 * The page frame every console surface sits in.
 *
 * The kit had primitives and no agreement about the page AROUND them.
 * /admin/ai-router and /admin/agents each set their own width, padding and
 * heading treatment inline, and /assistant used none of the kit at all. Three
 * surfaces a client moves between looked like three products.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ConsoleShell } from "@/components/console";

describe("the frame", () => {
  it("renders what it is given", () => {
    render(
      <ConsoleShell>
        <p>panel content</p>
      </ConsoleShell>,
    );
    expect(screen.getByText("panel content")).toBeInTheDocument();
  });

  /* A shell with no header is the common case: most pages carry their own
     heading inside. Rendering an empty one would put a blank block above every
     surface that does. */
  it("renders no header when given none", () => {
    render(
      <ConsoleShell>
        <p>content</p>
      </ConsoleShell>,
    );
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("renders a heading when given one", () => {
    render(
      <ConsoleShell title="Model router" eyebrow="OGIAM" subtitle="What it chose and why">
        <p>content</p>
      </ConsoleShell>,
    );
    expect(screen.getByRole("heading", { name: "Model router" })).toBeInTheDocument();
    expect(screen.getByText("What it chose and why")).toBeInTheDocument();
  });

  it("renders header actions", () => {
    render(
      <ConsoleShell title="Agents" actions={<button type="button">Refresh</button>}>
        <p>content</p>
      </ConsoleShell>,
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});

describe("surfaces that own the viewport", () => {
  /* A conversation is not a document. Without the fill variant the shell adds
     a second scroll container and the chat scrolls inside a page that also
     scrolls, which is the bug this flag exists to prevent. */
  it("does not claim the height by default", () => {
    const { container } = render(
      <ConsoleShell>
        <p>content</p>
      </ConsoleShell>,
    );
    expect(container.firstChild).not.toHaveClass("wp-console-shell-fill");
  });

  it("claims it when asked", () => {
    const { container } = render(
      <ConsoleShell fill>
        <p>content</p>
      </ConsoleShell>,
    );
    expect(container.firstChild).toHaveClass("wp-console-shell-fill");
  });
});

describe("identification", () => {
  it("carries a default test id so a page can be found without one", () => {
    render(
      <ConsoleShell>
        <p>content</p>
      </ConsoleShell>,
    );
    expect(screen.getByTestId("console-shell")).toBeInTheDocument();
  });

  it("takes a specific one when a page needs to be told apart", () => {
    render(
      <ConsoleShell testId="assistant-shell">
        <p>content</p>
      </ConsoleShell>,
    );
    expect(screen.getByTestId("assistant-shell")).toBeInTheDocument();
  });
});
