/**
 * @jest-environment jsdom
 */

/**
 * ContactFormSettings — UI tests.
 *
 * Pure controlled-component test — we assert onChange payloads rather
 * than mocking a persistence layer. Clipboard interactions use the
 * writeText spy from the jsdom runtime.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ContactFormSettings from "@/components/sites/ContactFormSettings";
import type { SiteBrief } from "@/lib/sites-schema";

function mkBrief(overrides: Partial<SiteBrief> = {}): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme Inc" },
    pages: [{ route: "/", sections: [] }],
    contactForm: { fields: [] },
    ...overrides,
  };
}

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
});

describe("ContactFormSettings", () => {
  it("renders empty-state hint when fields is empty", () => {
    const onChange = jest.fn();
    render(<ContactFormSettings brief={mkBrief()} onChange={onChange} />);
    expect(screen.getByTestId("contact-form-fields-empty")).toHaveTextContent(
      /No fields yet/i,
    );
  });

  it("adds a field when typing + clicking Add, onChange carries the new list", () => {
    const onChange = jest.fn();
    render(<ContactFormSettings brief={mkBrief()} onChange={onChange} />);
    const input = screen.getByTestId("contact-form-field-input");
    act(() => {
      fireEvent.change(input, { target: { value: "name" } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("contact-form-field-add"));
    });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)![0] as SiteBrief;
    expect(next.contactForm?.fields).toEqual(["name"]);
  });

  it("removes a field by clicking its × button", () => {
    const onChange = jest.fn();
    const brief = mkBrief({
      contactForm: { fields: ["name", "email"] },
    });
    render(<ContactFormSettings brief={brief} onChange={onChange} />);
    act(() => {
      fireEvent.click(screen.getByTestId("contact-form-field-remove-email"));
    });
    const next = onChange.mock.calls.at(-1)![0] as SiteBrief;
    expect(next.contactForm?.fields).toEqual(["name"]);
  });

  it("validates recipient email on blur (shows error for invalid)", () => {
    const onChange = jest.fn();
    const brief = mkBrief({
      contactForm: { fields: ["name"], recipientEmail: "not-an-email" },
    });
    render(<ContactFormSettings brief={brief} onChange={onChange} />);
    const input = screen.getByTestId("contact-form-recipient");
    act(() => {
      fireEvent.blur(input);
    });
    expect(
      screen.getByTestId("contact-form-recipient-error"),
    ).toBeInTheDocument();
  });

  it("no error when recipient email is valid", () => {
    const brief = mkBrief({
      contactForm: { fields: ["name"], recipientEmail: "leads@acme.com" },
    });
    render(<ContactFormSettings brief={brief} onChange={() => {}} />);
    act(() => {
      fireEvent.blur(screen.getByTestId("contact-form-recipient"));
    });
    expect(
      screen.queryByTestId("contact-form-recipient-error"),
    ).not.toBeInTheDocument();
  });

  it("renders the HTML snippet and copies it to the clipboard", async () => {
    const brief = mkBrief({
      contactForm: { fields: ["name", "email", "message"] },
    });
    render(<ContactFormSettings brief={brief} onChange={() => {}} />);
    const snippet = screen.getByTestId("contact-form-snippet");
    expect(snippet.textContent).toContain("_hp_website");
    expect(snippet.textContent).toContain("/api/public/forms/");
    expect(snippet.textContent).toContain('name="name"');
    await act(async () => {
      fireEvent.click(screen.getByTestId("contact-form-snippet-copy"));
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
  });

  it("validates Slack webhook on blur", () => {
    const brief = mkBrief({
      contactForm: {
        fields: ["name"],
        notifySlack: "https://example.com/not-slack",
      },
    });
    render(<ContactFormSettings brief={brief} onChange={() => {}} />);
    act(() => {
      fireEvent.blur(screen.getByTestId("contact-form-slack"));
    });
    expect(
      screen.getByTestId("contact-form-slack-error"),
    ).toBeInTheDocument();
  });
});
