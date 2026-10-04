/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import DiffView, { diffStats } from "@/components/ai-code/factory-chat/DiffView";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const keep = 1;",
  "-const old = 2;",
  "+const neu = 2;",
  "+const extra = 3;",
].join("\n");

describe("diffStats", () => {
  it("counts files + added/removed", () => {
    expect(diffStats(DIFF)).toEqual({ files: 1, added: 2, removed: 1 });
  });
  it("is zeroed on empty", () => {
    expect(diffStats("")).toEqual({ files: 0, added: 0, removed: 0 });
  });
});

describe("DiffView", () => {
  it("shows the stats and expands to the diff body on click", () => {
    render(<DiffView diff={DIFF} />);
    expect(screen.getByTestId("diff-stats")).toHaveTextContent("+2");
    expect(screen.getByTestId("diff-stats")).toHaveTextContent("-1");
    expect(screen.queryByTestId("diff-body")).toBeNull(); // collapsed by default
    fireEvent.click(screen.getByTestId("diff-toggle"));
    expect(screen.getByTestId("diff-body")).toHaveTextContent("const neu = 2;");
  });
  it("renders nothing for an empty diff", () => {
    const { container } = render(<DiffView diff="" />);
    expect(container.firstChild).toBeNull();
  });
});
