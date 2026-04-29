/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import UnsavedDraftDialog from "@/app/(dashboard)/emails/UnsavedDraftDialog";

describe("UnsavedDraftDialog", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <UnsavedDraftDialog
        open={false}
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("unsaved-draft-dialog")).toBeNull();
  });

  it("renders title + buttons when open", () => {
    render(
      <UnsavedDraftDialog
        open
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    expect(screen.getByText("Discard unsaved draft?")).toBeInTheDocument();
    expect(screen.getByTestId("unsaved-draft-keep")).toHaveTextContent(
      "Keep editing",
    );
    expect(screen.getByTestId("unsaved-draft-discard")).toHaveTextContent(
      "Discard draft",
    );
    // a11y: dialog wrapper carries aria-modal + role.
    const dialog = screen.getByTestId("unsaved-draft-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("renders the optional draft preview when provided", () => {
    render(
      <UnsavedDraftDialog
        open
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
        draftPreview="Hi Jane, just wanted to follow up on the contract terms."
      />,
    );
    expect(screen.getByTestId("unsaved-draft-preview")).toHaveTextContent(
      /Hi Jane/,
    );
  });

  it("does not render the preview when not provided", () => {
    render(
      <UnsavedDraftDialog open onConfirm={jest.fn()} onCancel={jest.fn()} />,
    );
    expect(screen.queryByTestId("unsaved-draft-preview")).toBeNull();
  });

  it("clicking Discard fires onConfirm", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(
      <UnsavedDraftDialog open onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByTestId("unsaved-draft-discard"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("clicking Keep editing fires onCancel", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(
      <UnsavedDraftDialog open onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByTestId("unsaved-draft-keep"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("pressing Escape fires onCancel", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(
      <UnsavedDraftDialog open onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clicking the backdrop fires onCancel; clicking inside the card does not", () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(
      <UnsavedDraftDialog open onConfirm={onConfirm} onCancel={onCancel} />,
    );
    // Backdrop click cancels.
    fireEvent.click(screen.getByTestId("unsaved-draft-backdrop"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    // Click inside the card body should not bubble to the backdrop.
    onCancel.mockReset();
    fireEvent.click(screen.getByText("Discard unsaved draft?"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("auto-focuses the Keep editing button so accidental Enter does not destroy work", () => {
    render(
      <UnsavedDraftDialog open onConfirm={jest.fn()} onCancel={jest.fn()} />,
    );
    expect(document.activeElement).toBe(
      screen.getByTestId("unsaved-draft-keep"),
    );
  });
});
