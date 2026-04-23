/**
 * @jest-environment jsdom
 *
 * ConfirmDialog — shared destructive-action modal that replaced the
 * browser-native confirm() on /discussions.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ConfirmDialog from "@/components/ConfirmDialog";

test("renders title + body when open", () => {
  const onCancel = jest.fn();
  const onConfirm = jest.fn();
  render(
    <ConfirmDialog
      open
      title="Delete discussion?"
      body="This cannot be undone."
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
  expect(screen.getByText("Delete discussion?")).toBeInTheDocument();
  expect(screen.getByTestId("confirm-dialog-body")).toHaveTextContent(
    "This cannot be undone.",
  );
});

test("returns null when closed — no leaked portal", () => {
  const { container } = render(
    <ConfirmDialog
      open={false}
      title="Nope"
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  expect(container.firstChild).toBeNull();
});

test("cancel + confirm callbacks wire through", () => {
  const onCancel = jest.fn();
  const onConfirm = jest.fn();
  render(
    <ConfirmDialog
      open
      title="Delete?"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));
  expect(onCancel).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

test("Escape key cancels", () => {
  const onCancel = jest.fn();
  render(
    <ConfirmDialog
      open
      title="Delete?"
      onCancel={onCancel}
      onConfirm={() => {}}
    />,
  );
  act(() => {
    fireEvent.keyDown(document, { key: "Escape" });
  });
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("backdrop click cancels, inner click does not", () => {
  const onCancel = jest.fn();
  render(
    <ConfirmDialog
      open
      title="Delete?"
      onCancel={onCancel}
      onConfirm={() => {}}
    />,
  );
  // Clicking the panel itself should NOT cancel.
  fireEvent.click(screen.getByText("Delete?"));
  expect(onCancel).not.toHaveBeenCalled();
  // Clicking the backdrop should cancel.
  fireEvent.click(screen.getByTestId("confirm-dialog"));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("destructive variant renders a distinct primary-action palette", () => {
  const { rerender } = render(
    <ConfirmDialog
      open
      title="Delete?"
      destructive
      confirmLabel="Delete"
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  const btn = screen.getByTestId("confirm-dialog-confirm");
  expect(btn.textContent).toBe("Delete");
  // Snapshot the destructive style so any regression gets flagged.
  const destructiveBg = btn.style.background;
  rerender(
    <ConfirmDialog
      open
      title="Save?"
      confirmLabel="Save"
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  const benignBg = screen.getByTestId("confirm-dialog-confirm").style.background;
  expect(destructiveBg).not.toBe(benignBg);
});
