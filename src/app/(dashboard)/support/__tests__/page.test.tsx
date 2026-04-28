/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ tickets: [], total: 0 }),
    }),
  ),
  getInstinctToken: jest.fn(() => "tk"),
}));

jest.mock("next/link", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return ({ href, children, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  );
});

import SupportPage from "@/app/(dashboard)/support/page";

describe("/support page header CTAs", () => {
  test("renders the Manage patterns link pointing at /support/patterns", async () => {
    render(<SupportPage />);

    /* The page renders null until auth-check completes; wait for the
       ticket list shell to appear before asserting the CTA exists. */
    await waitFor(() =>
      expect(screen.getByTestId("support-page")).toBeInTheDocument(),
    );

    const manage = screen.getByTestId("support-manage-patterns-cta");
    expect(manage).toBeInTheDocument();
    expect(manage.getAttribute("href")).toBe("/support/patterns");
    expect(manage.textContent).toMatch(/Manage patterns/);

    /* And the existing New ticket CTA still renders alongside it. */
    expect(screen.getByTestId("support-new-cta").getAttribute("href")).toBe(
      "/support/new",
    );
  });
});
