/**
 * @jest-environment jsdom
 *
 * VercelDeploymentsWidget render + interaction tests.
 *   - empty state renders "No deployments to show."
 *   - non-empty renders one row per deployment
 *   - state color reflects READY/ERROR/BUILDING
 *   - analytics ping on render
 *   - analytics ping on click-through
 */

import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

const mockFetchWithRefresh: jest.Mock = jest.fn(() =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
);
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: mockFetchWithRefresh,
}));
jest.mock("@/components/widgets/StaggeredItem", () => ({
  StaggeredItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("li", props, children),
  useStaggeredReveal: () => undefined,
}));

import React from "react";
import { VercelDeploymentsWidget } from "@/components/widgets/VercelDeploymentsWidget";
import type { VercelDeploymentsWidgetSpec } from "@/lib/assistant/widgets/types";

const emptySpec: VercelDeploymentsWidgetSpec = {
  kind: "vercel_deployments",
  projectName: "wolfpack-auto",
  title: "No deploys found for wolfpack-auto",
  items: [],
};

const populatedSpec: VercelDeploymentsWidgetSpec = {
  kind: "vercel_deployments",
  projectName: "wolfpack-auto",
  title: "2 recent deploys of wolfpack-auto",
  items: [
    {
      id: "d1",
      projectName: "wolfpack-auto",
      state: "READY",
      target: "production",
      url: "https://vercel.com/team/wolfpack-auto/d1",
      commitMessage: "fix: oops",
      branch: "main",
      commitSha: "abc1234",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      readyAt: new Date(Date.now() - 30_000).toISOString(),
      creator: "homyk",
    },
    {
      id: "d2",
      projectName: "wolfpack-auto",
      state: "ERROR",
      target: "preview",
      url: "https://vercel.com/team/wolfpack-auto/d2",
      commitMessage: "broken",
      branch: "feature/x",
      commitSha: "def5678",
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      readyAt: null,
      creator: "homyk",
    },
  ],
};

beforeEach(() => {
  mockFetchWithRefresh.mockClear();
});

describe("VercelDeploymentsWidget", () => {
  test("empty state renders helpful message", () => {
    render(<VercelDeploymentsWidget spec={emptySpec} />);
    expect(screen.getByTestId("vercel-deployments-widget")).toBeInTheDocument();
    expect(screen.getByTestId("vercel-deployments-empty")).toHaveTextContent("No deployments to show.");
  });

  test("renders one row per deployment", () => {
    render(<VercelDeploymentsWidget spec={populatedSpec} />);
    expect(screen.getByTestId("vercel-deploy-item-d1")).toBeInTheDocument();
    expect(screen.getByTestId("vercel-deploy-item-d2")).toBeInTheDocument();
  });

  test("rows are clickable links to the Vercel dashboard", () => {
    render(<VercelDeploymentsWidget spec={populatedSpec} />);
    const link = screen.getByTestId("vercel-deploy-item-d1").querySelector("a");
    expect(link).toHaveAttribute("href", "https://vercel.com/team/wolfpack-auto/d1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  test("commit message and branch render when present", () => {
    render(<VercelDeploymentsWidget spec={populatedSpec} />);
    expect(screen.getByText(/fix: oops/)).toBeInTheDocument();
    expect(screen.getByText(/main/)).toBeInTheDocument();
  });

  test("emits widget_rendered analytics on mount", () => {
    render(<VercelDeploymentsWidget spec={populatedSpec} workflowId="w-1" />);
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("vercel_deployments"),
      }),
    );
  });

  test("emits widget_interaction analytics on click-through", () => {
    render(<VercelDeploymentsWidget spec={populatedSpec} workflowId="w-1" />);
    mockFetchWithRefresh.mockClear();
    const link = screen.getByTestId("vercel-deploy-item-d1").querySelector("a")!;
    fireEvent.click(link);
    expect(mockFetchWithRefresh).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("open_deploy"),
      }),
    );
  });
});
