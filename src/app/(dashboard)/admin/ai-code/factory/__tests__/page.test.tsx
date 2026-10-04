/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
let user: unknown = { role: "cto" };
jest.mock("@/lib/client-auth", () => ({ getInstinctUser: () => user }));
// The chat shell itself is covered by its own tests; stub it here so the route
// test is about auth-gating only.
jest.mock("@/components/ai-code/factory-chat/FactoryChat", () => ({
  __esModule: true,
  default: () => <div data-testid="factory-chat-mounted" />,
}));

import CodeFactoryChatPage from "@/app/(dashboard)/admin/ai-code/factory/page";

beforeEach(() => jest.clearAllMocks());

it("redirects an unauthenticated visitor to login, never a blank page", () => {
  user = null;
  render(<CodeFactoryChatPage />);
  expect(mockPush).toHaveBeenCalledWith("/login?next=/admin/ai-code/factory");
  expect(screen.queryByTestId("factory-chat-mounted")).toBeNull();
});

it("mounts the chat for an authenticated user", () => {
  user = { role: "cto" };
  render(<CodeFactoryChatPage />);
  expect(screen.getByTestId("factory-chat-mounted")).toBeInTheDocument();
});
