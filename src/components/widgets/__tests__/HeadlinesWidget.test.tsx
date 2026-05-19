/**
 * @jest-environment jsdom
 *
 * HeadlinesWidget — renders a list of news cards with external links,
 * fires widget_rendered analytics on mount, handles empty-state.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { HeadlinesWidget } from "@/components/widgets/HeadlinesWidget";
import type { HeadlinesWidgetSpec } from "@/lib/assistant/widgets/types";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

const baseSpec: HeadlinesWidgetSpec = {
  kind: "headlines",
  title: "Top 3 headlines",
  subtitle: "via BBC News",
  items: [
    {
      title: "World leaders meet in Geneva",
      link: "https://bbc.example/1",
      published: new Date(Date.now() - 30 * 60_000).toISOString(),
      source: "BBC News",
    },
    {
      title: "Markets close higher",
      link: "https://bbc.example/2",
      published: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      source: "BBC News",
    },
    {
      title: "New climate accord signed",
      link: "https://bbc.example/3",
      published: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
      source: "BBC News",
    },
  ],
};

describe("HeadlinesWidget", () => {
  test("renders title and a row per item", () => {
    render(<HeadlinesWidget spec={baseSpec} />);
    expect(screen.getByTestId("headlines-widget")).toBeInTheDocument();
    expect(screen.getByText("Top 3 headlines")).toBeInTheDocument();
    expect(screen.getByText("World leaders meet in Geneva")).toBeInTheDocument();
    expect(screen.getByText("Markets close higher")).toBeInTheDocument();
    expect(screen.getByText("New climate accord signed")).toBeInTheDocument();
  });

  test("each row links to its source with target=_blank + safe rel", () => {
    render(<HeadlinesWidget spec={baseSpec} />);
    const link = screen.getByText("World leaders meet in Geneva").closest("a");
    expect(link?.getAttribute("href")).toBe("https://bbc.example/1");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toMatch(/noreferrer/);
    expect(link?.getAttribute("rel")).toMatch(/noopener/);
  });

  test("clicking a headline fires widget_interaction analytics", () => {
    render(<HeadlinesWidget spec={baseSpec} />);
    mockFetch.mockClear();
    fireEvent.click(screen.getByText("Markets close higher"));
    const calls = mockFetch.mock.calls.map((c) => String(c[1]?.body || ""));
    expect(calls.some((b) => b.includes("widget_interaction") && b.includes("open_headline"))).toBe(true);
  });

  test("fires widget_rendered on mount with item_count", () => {
    render(<HeadlinesWidget spec={baseSpec} />);
    const renderedCall = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("widget_rendered"),
    );
    expect(renderedCall).toBeDefined();
    expect(String(renderedCall?.[1]?.body)).toContain('"item_count":3');
  });

  test("empty-state when items is []", () => {
    render(<HeadlinesWidget spec={{ ...baseSpec, items: [] }} />);
    expect(screen.getByTestId("headlines-empty")).toBeInTheDocument();
    expect(screen.getByText(/No headlines/)).toBeInTheDocument();
  });
});
