/**
 * @jest-environment jsdom
 *
 * Tests for fenced code blocks + inline code in the assistant's
 * minimal markdown renderer. The pre-existing bold/link suite lives at
 * src/components/__tests__/InstinctChat-markdown-render.test.tsx and
 * must continue to pass without modification — these tests *add* the
 * code-block layer without regressing it.
 */

import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";
import { renderMessageContent } from "@/lib/assistant/render-markdown";

function Wrap({ content }: { content: string }) {
  return <div data-testid="wrap">{renderMessageContent(content)}</div>;
}

describe("renderMessageContent — fenced code blocks", () => {
  it("renders ```ts\\nconst x = 1;\\n``` as a CodeBlock with language 'ts'", () => {
    render(<Wrap content={"```ts\nconst x = 1;\n```"} />);
    const block = screen.getByTestId("assistant-code-block");
    expect(block).toBeInTheDocument();
    expect(block.getAttribute("data-language")).toBe("ts");
    expect(screen.getByTestId("assistant-code-language").textContent).toBe("ts");
    expect(screen.getByTestId("assistant-code-body").textContent).toBe(
      "const x = 1;",
    );
  });

  it("defaults the language label to 'code' when the fence has no tag", () => {
    render(<Wrap content={"```\nhello world\n```"} />);
    const block = screen.getByTestId("assistant-code-block");
    expect(block.getAttribute("data-language")).toBe("code");
    expect(screen.getByTestId("assistant-code-language").textContent).toBe(
      "code",
    );
    expect(screen.getByTestId("assistant-code-body").textContent).toBe(
      "hello world",
    );
  });

  it("renders ** and [](...) literally inside a code block — never as bold or links", () => {
    const raw = "```ts\nconst link = '[Calendar](/calendar)';\nconst b = '**bold**';\n```";
    render(<Wrap content={raw} />);
    const body = screen.getByTestId("assistant-code-body");
    // The literal characters must survive verbatim.
    expect(body.textContent).toContain("[Calendar](/calendar)");
    expect(body.textContent).toContain("**bold**");
    // And no <strong> / <a> was emitted from inside the fence.
    expect(within(body).queryByRole("link")).toBeNull();
    expect(within(body).queryByText("bold", { selector: "strong" })).toBeNull();
    // The fake link did not register as a clickable anchor.
    expect(screen.queryByTestId("msg-link-/calendar")).toBeNull();
  });

  it("renders multiple fenced blocks in one message", () => {
    const raw = "First:\n```js\na;\n```\nSecond:\n```py\nb\n```";
    render(<Wrap content={raw} />);
    const blocks = screen.getAllByTestId("assistant-code-block");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].getAttribute("data-language")).toBe("js");
    expect(blocks[1].getAttribute("data-language")).toBe("py");
    const bodies = screen.getAllByTestId("assistant-code-body");
    expect(bodies[0].textContent).toBe("a;");
    expect(bodies[1].textContent).toBe("b");
  });

  it("interleaves prose, bold, links, and fenced code in the right order", () => {
    const raw =
      "Open **Calendar** at [Calendar](/calendar). Example:\n" +
      "```ts\nconst x = 1;\n```\n" +
      "Done.";
    render(<Wrap content={raw} />);
    // Bold + link rendered outside the fence.
    expect(screen.getByText("Calendar", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByTestId("msg-link-/calendar")).toBeInTheDocument();
    // The block is present.
    expect(screen.getByTestId("assistant-code-block")).toBeInTheDocument();
    // The block body is literal.
    expect(screen.getByTestId("assistant-code-body").textContent).toBe(
      "const x = 1;",
    );
    // No stray fence chars leak into the visible text.
    expect(screen.getByTestId("wrap").textContent).not.toMatch(/```/);
  });
});

describe("renderMessageContent — inline `code`", () => {
  it("renders `npm install` as an <code> element, not as a code block", () => {
    render(<Wrap content="Run `npm install` to start." />);
    const inline = screen.getByTestId("assistant-inline-code");
    expect(inline.tagName).toBe("CODE");
    expect(inline.textContent).toBe("npm install");
    // Not a fenced block.
    expect(screen.queryByTestId("assistant-code-block")).toBeNull();
  });

  it("renders inline code + bold on the same line independently", () => {
    render(<Wrap content="Use `kubectl` for **production** clusters." />);
    expect(screen.getByTestId("assistant-inline-code").textContent).toBe(
      "kubectl",
    );
    expect(
      screen.getByText("production", { selector: "strong" }),
    ).toBeInTheDocument();
  });

  it("does NOT parse ** or []() inside inline code", () => {
    render(<Wrap content="Run `**not bold** [not](/link)` now." />);
    const inline = screen.getByTestId("assistant-inline-code");
    expect(inline.textContent).toBe("**not bold** [not](/link)");
    expect(screen.queryByText("not bold", { selector: "strong" })).toBeNull();
    expect(screen.queryByTestId("msg-link-/link")).toBeNull();
  });
});

describe("renderMessageContent — regression: pre-existing behavior", () => {
  // Mirrors the load-bearing cases from
  // src/components/__tests__/InstinctChat-markdown-render.test.tsx so
  // this suite *alone* catches a regression that breaks bold/link.
  it("still renders [Knowledge Base](/knowledge) as a clickable <a>", () => {
    render(<Wrap content="Open it: [Knowledge Base](/knowledge)" />);
    const anchor = screen.getByTestId("msg-link-/knowledge") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("/knowledge");
    expect(anchor.textContent).toBe("Knowledge Base");
  });

  it("still renders **bold** as <strong>", () => {
    render(<Wrap content="**Calendar** — your schedule." />);
    expect(
      screen.getByText("Calendar", { selector: "strong" }),
    ).toBeInTheDocument();
  });

  it("still refuses unsafe hrefs", () => {
    render(<Wrap content="Click [me](javascript:alert(1)) now" />);
    expect(screen.queryByTestId(/^msg-link-javascript/)).toBeNull();
    expect(screen.getByTestId("wrap").textContent).toMatch(
      /\[me\]\(javascript:alert\(1\)\) now/,
    );
  });
});
