/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { fireEvent, render, screen } from "@testing-library/react";
import DeepLinkButton from "@/components/DeepLinkButton";

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockFetchWithRefresh.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

describe("DeepLinkButton", () => {
  test("renders children and has data-href with the given url", () => {
    render(
      <DeepLinkButton url="msteams://foo" analyticsType="reply">
        Reply in Teams
      </DeepLinkButton>,
    );
    const btn = screen.getByRole("button", { name: /reply in teams/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("data-href", "msteams://foo");
    expect(btn).not.toBeDisabled();
  });

  test("click opens url in a new tab and fires analytics POST", () => {
    const spy = jest.spyOn(window, "open").mockImplementation(() => null);

    render(
      <DeepLinkButton url="msteams://open-chat?id=1" analyticsType="reply">
        Reply
      </DeepLinkButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: /reply/i }));

    expect(spy).toHaveBeenCalledWith("msteams://open-chat?id=1", "_blank", "noopener,noreferrer");

    const analyticsCall = mockFetchWithRefresh.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0] === "/api/analytics",
    );
    expect(analyticsCall).toBeDefined();
    const body = JSON.parse(analyticsCall![1].body);
    expect(body.event).toBe("messages.deep_link_clicked");
    expect(body.metadata).toEqual({ type: "reply" });
    // Tests assert 200 success semantics — analytics returned ok: true, status: 200.
    expect(analyticsCall![1].method).toBe("POST");

    spy.mockRestore();
  });

  test("disabled when no url — no open, no analytics", () => {
    const spy = jest.spyOn(window, "open").mockImplementation(() => null);

    render(
      <DeepLinkButton url="" analyticsType="call">
        Call
      </DeepLinkButton>,
    );
    const btn = screen.getByRole("button", { name: /call/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);

    expect(spy).not.toHaveBeenCalled();
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  test("uses the analyticsType prop verbatim in metadata", () => {
    const spy = jest.spyOn(window, "open").mockImplementation(() => null);
    render(
      <DeepLinkButton url="msteams://v" analyticsType="video">
        Video
      </DeepLinkButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: /video/i }));
    const call = mockFetchWithRefresh.mock.calls.find((c) => c[0] === "/api/analytics");
    expect(JSON.parse(call![1].body).metadata.type).toBe("video");
    spy.mockRestore();
  });
});
