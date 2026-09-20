/** @jest-environment jsdom */
import "@testing-library/jest-dom";
const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({ fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a) }));
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ForcefieldAssurance } from "@/components/forcefield/ForcefieldAssurance";

const DATA = {
  assurance: {
    controls: [
      { id: "enforce.inline", title: "Inline edge enforcement", status: "gap", detail: "Monitor mode." },
      { id: "verify.replay", title: "Delegation replay defense (jti)", status: "active", detail: "Accepted once." },
    ],
    activeCount: 1, partialCount: 0, gapCount: 1, total: 2, score: 50,
  },
  adversarial: {
    results: [{ id: "replay", attack: "An agent replays a captured delegation.", control: "Replay defense (jti)", defended: true, detail: "first: verified, replay: claimed" }],
    defendedCount: 1, total: 1, allDefended: true,
  },
};

beforeEach(() => mockFetchWithRefresh.mockReset());

it("runs on open and shows the posture score, controls, and self-attack results", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => DATA });
  render(<ForcefieldAssurance />);
  // collapsed: does not fetch until opened
  expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText(/Assurance & self-test/i));
  await waitFor(() => expect(screen.getByTestId("assurance-score")).toHaveTextContent("50%"));
  expect(screen.getByTestId("assurance-control-enforce.inline")).toHaveTextContent(/gap/i);
  expect(screen.getByTestId("assurance-selftest")).toHaveTextContent("1/1 defended");
  expect(screen.getByTestId("assurance-scenario-replay")).toHaveTextContent(/replays a captured delegation/i);
});

it("surfaces an error without crashing", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: false, json: async () => ({}) });
  render(<ForcefieldAssurance />);
  fireEvent.click(screen.getByText(/Assurance & self-test/i));
  await waitFor(() => expect(screen.getByTestId("assurance-error")).toBeInTheDocument());
});
