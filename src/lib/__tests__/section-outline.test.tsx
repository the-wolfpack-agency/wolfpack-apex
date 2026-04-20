/**
 * @jest-environment jsdom
 */

/**
 * SectionOutline — component tests.
 *
 * Covers:
 *   - renders role=listbox with role=option rows.
 *   - Click row → onSelect.
 *   - Duplicate / delete buttons → respective callbacks.
 *   - Keyboard: Enter selects, Shift+Arrow reorders, ArrowUp/Down move
 *     selection, Cmd/Ctrl+Delete deletes.
 *   - Drag-drop: onDragStart + onDrop on a different row fires onReorder.
 *   - Add section select + button → onAddSection(type).
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import SectionOutline from "@/components/sites/SectionOutline";
import type { BriefSection } from "@/lib/sites-schema";

function makeSections(): BriefSection[] {
  return [
    { type: "hero", heading: "Welcome" },
    { type: "text", heading: "About us" },
    { type: "cards", heading: "Features" },
  ];
}

describe("SectionOutline — render", () => {
  it("renders each section as a role=option row with handle + badge", () => {
    render(
      <SectionOutline
        sections={makeSections()}
        selectedIndex={null}
        onSelect={jest.fn()}
        onReorder={jest.fn()}
        onDuplicate={jest.fn()}
        onDelete={jest.fn()}
        onAddSection={jest.fn()}
      />,
    );
    const list = screen.getByRole("listbox", { name: "Page sections" });
    expect(list).toBeInTheDocument();
    // Scope within the listbox so the add-section <select>'s <option>s
    // (also role=option) don't inflate the count.
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(screen.getByTestId("studio-section-outline-row-0")).toHaveTextContent(
      "Welcome",
    );
    expect(screen.getByTestId("studio-section-outline-row-1")).toHaveTextContent(
      "About us",
    );
    expect(screen.getByTestId("studio-section-outline-handle-0")).toBeInTheDocument();
  });

  it("marks the selected row with aria-selected='true'", () => {
    render(
      <SectionOutline
        sections={makeSections()}
        selectedIndex={1}
        onSelect={jest.fn()}
        onReorder={jest.fn()}
        onDuplicate={jest.fn()}
        onDelete={jest.fn()}
        onAddSection={jest.fn()}
      />,
    );
    expect(screen.getByTestId("studio-section-outline-row-1").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("studio-section-outline-row-0").getAttribute("aria-selected")).toBe("false");
  });

  it("renders the empty-state placeholder when sections is []", () => {
    render(
      <SectionOutline
        sections={[]}
        selectedIndex={null}
        onSelect={jest.fn()}
        onReorder={jest.fn()}
        onDuplicate={jest.fn()}
        onDelete={jest.fn()}
        onAddSection={jest.fn()}
      />,
    );
    expect(screen.getByTestId("studio-section-outline-empty")).toBeInTheDocument();
  });
});

describe("SectionOutline — interactions", () => {
  it("click row fires onSelect with the row index", () => {
    const onSelect = jest.fn();
    render(
      <SectionOutline
        sections={makeSections()}
        selectedIndex={null}
        onSelect={onSelect}
        onReorder={jest.fn()}
        onDuplicate={jest.fn()}
        onDelete={jest.fn()}
        onAddSection={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("studio-section-outline-row-2"));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("duplicate + delete buttons fire their callbacks with index", () => {
    const onDuplicate = jest.fn();
    const onDelete = jest.fn();
    render(
      <SectionOutline
        sections={makeSections()}
        selectedIndex={null}
        onSelect={jest.fn()}
        onReorder={jest.fn()}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onAddSection={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("studio-section-outline-duplicate-1"));
    expect(onDuplicate).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByTestId("studio-section-outline-delete-0"));
    expect(onDelete).toHaveBeenCalledWith(0);
  });

  it("Add button with selected type fires onAddSection", () => {
    const onAddSection = jest.fn();
    render(
      <SectionOutline
        sections={makeSections()}
        selectedIndex={null}
        onSelect={jest.fn()}
        onReorder={jest.fn()}
        onDuplicate={jest.fn()}
        onDelete={jest.fn()}
        onAddSection={onAddSection}
      />,
    );
    const select = screen.getByTestId(
      "studio-section-outline-add-type",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "pricing" } });
    fireEvent.click(screen.getByTestId("studio-section-outline-add-btn"));
    expect(onAddSection).toHaveBeenCalledWith("pricing");
  });
});

describe("SectionOutline — keyboard", () => {
  it("Enter on a focused row fires onSelect", () => {
    const onSelect = jest.fn();
    render(
      <SectionOutline
        sections={makeSections()}
        selectedIndex={null}
        onSelect={onSelect}
        onReorder={jest.fn()}
        onDuplicate={jest.fn()}
        onDelete={jest.fn()}
        onAddSection={jest.fn()}
      />,
    );
    const row = screen.getByTestId("studio-section-outline-row-1");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("ArrowDown moves selection down; Shift+ArrowDown reorders", () => {
    const onSelect = jest.fn();
    const onReorder = jest.fn();
    render(
      <SectionOutline
        sections={makeSections()}
        selectedIndex={0}
        onSelect={onSelect}
        onReorder={onReorder}
        onDuplicate={jest.fn()}
        onDelete={jest.fn()}
        onAddSection={jest.fn()}
      />,
    );
    const row0 = screen.getByTestId("studio-section-outline-row-0");
    fireEvent.keyDown(row0, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith(1);
    fireEvent.keyDown(row0, { key: "ArrowDown", shiftKey: true });
    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it("Cmd+Delete on a row triggers onDelete", () => {
    const onDelete = jest.fn();
    render(
      <SectionOutline
        sections={makeSections()}
        selectedIndex={0}
        onSelect={jest.fn()}
        onReorder={jest.fn()}
        onDuplicate={jest.fn()}
        onDelete={onDelete}
        onAddSection={jest.fn()}
      />,
    );
    const row = screen.getByTestId("studio-section-outline-row-0");
    fireEvent.keyDown(row, { key: "Delete", metaKey: true });
    expect(onDelete).toHaveBeenCalledWith(0);
  });
});

describe("SectionOutline — drag reorder dispatches section.reorder semantics", () => {
  it("dragStart on row 0 + drop on row 2 calls onReorder(0, 2)", () => {
    const onReorder = jest.fn();
    render(
      <SectionOutline
        sections={makeSections()}
        selectedIndex={null}
        onSelect={jest.fn()}
        onReorder={onReorder}
        onDuplicate={jest.fn()}
        onDelete={jest.fn()}
        onAddSection={jest.fn()}
      />,
    );
    const row0 = screen.getByTestId("studio-section-outline-row-0");
    const row2 = screen.getByTestId("studio-section-outline-row-2");

    // jsdom's DataTransfer is a stub; the component falls back to a ref
    // for the source index. We explicitly set the required property via
    // the synthetic event so the handler exits its try/catch cleanly.
    const dt = {
      setData: jest.fn(),
      getData: jest.fn(),
      effectAllowed: "move",
    } as unknown as DataTransfer;
    fireEvent.dragStart(row0, { dataTransfer: dt });
    fireEvent.dragOver(row2, { dataTransfer: dt });
    fireEvent.drop(row2, { dataTransfer: dt });
    expect(onReorder).toHaveBeenCalledWith(0, 2);
  });

  it("dropping on the same row is a no-op", () => {
    const onReorder = jest.fn();
    render(
      <SectionOutline
        sections={makeSections()}
        selectedIndex={null}
        onSelect={jest.fn()}
        onReorder={onReorder}
        onDuplicate={jest.fn()}
        onDelete={jest.fn()}
        onAddSection={jest.fn()}
      />,
    );
    const row1 = screen.getByTestId("studio-section-outline-row-1");
    const dt = {
      setData: jest.fn(),
      getData: jest.fn(),
      effectAllowed: "move",
    } as unknown as DataTransfer;
    fireEvent.dragStart(row1, { dataTransfer: dt });
    fireEvent.drop(row1, { dataTransfer: dt });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
