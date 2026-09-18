/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import GovernancePosturePage from "../page";

test("renders the posture surface: the enforced tally, the enforced list, proofs, and the effectiveness link", () => {
  render(<GovernancePosturePage />);
  expect(screen.getByTestId("governance-posture")).toBeInTheDocument();
  expect(screen.getByTestId("posture-tally")).toBeInTheDocument();
  // There are enforced controls in the registry, so the auto-enforced group renders.
  expect(screen.getByTestId("posture-auto")).toBeInTheDocument();
  expect(screen.getByTestId("posture-proofs")).toBeInTheDocument();
  expect(screen.getAllByTestId("posture-proof").length).toBeGreaterThanOrEqual(3);
  const link = screen.getByRole("link", { name: /effectiveness view/i });
  expect(link).toHaveAttribute("href", "/admin/effectiveness");
});
