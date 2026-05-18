/**
 * @jest-environment jsdom
 *
 * AssistantWelcomeModal — first-visit greeter contract.
 *
 * Locks the rollout behavior:
 *  - Shows once per browser (localStorage gate).
 *  - Prompts vary by role.
 *  - Picking a prompt fills the composer + dismisses + fires analytics.
 *  - Dismissing via X-button or backdrop click is non-destructive.
 *  - Never re-shows after first dismiss.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { AssistantWelcomeModal } from "@/components/AssistantWelcomeModal";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  window.localStorage.clear();
});

function lastTrackEvent(): { event?: string; metadata?: Record<string, unknown> } {
  const lastCall = mockFetch.mock.calls
    .filter((c) => String(c[0]).includes("/api/analytics"))
    .at(-1);
  if (!lastCall) return {};
  try {
    return JSON.parse(String(lastCall[1]?.body ?? "{}"));
  } catch {
    return {};
  }
}

function trackEvents(): string[] {
  return mockFetch.mock.calls
    .filter((c) => String(c[0]).includes("/api/analytics"))
    .map((c) => {
      try {
        return JSON.parse(String(c[1]?.body ?? "{}")).event as string;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

describe("AssistantWelcomeModal — first-visit gate", () => {
  test("renders on first mount when no localStorage flag", () => {
    render(
      <AssistantWelcomeModal
        userName="Alicia"
        userRole="pm"
        onPickPrompt={() => undefined}
      />,
    );
    expect(screen.getByTestId("assistant-welcome-modal")).toBeInTheDocument();
    expect(screen.getByText(/Hi Alicia/)).toBeInTheDocument();
  });

  test("does NOT render when the localStorage flag is set", () => {
    window.localStorage.setItem("instinct_welcome_seen", "1");
    render(
      <AssistantWelcomeModal
        userName="Alicia"
        userRole="pm"
        onPickPrompt={() => undefined}
      />,
    );
    expect(screen.queryByTestId("assistant-welcome-modal")).not.toBeInTheDocument();
  });

  test("greets with 'there' when no userName is supplied", () => {
    render(
      <AssistantWelcomeModal userRole="pm" onPickPrompt={() => undefined} />,
    );
    expect(screen.getByText(/Hi there/)).toBeInTheDocument();
  });

  test("fires assistant.welcome_shown on first render with role", () => {
    render(
      <AssistantWelcomeModal
        userName="Alicia"
        userRole="pm"
        onPickPrompt={() => undefined}
      />,
    );
    const events = trackEvents();
    expect(events).toContain("assistant.welcome_shown");
    const payload = mockFetch.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[1]?.body ?? "{}"));
        } catch {
          return null;
        }
      })
      .find((p) => p?.event === "assistant.welcome_shown");
    expect(payload?.metadata?.role).toBe("pm");
  });
});

describe("AssistantWelcomeModal — role-tailored prompts", () => {
  test("PM role shows briefing + calendar today + create task", () => {
    render(
      <AssistantWelcomeModal userRole="pm" onPickPrompt={() => undefined} />,
    );
    expect(screen.getByText("briefing")).toBeInTheDocument();
    expect(screen.getByText("what is on my calendar today")).toBeInTheDocument();
    expect(screen.getByText(/create task to/)).toBeInTheDocument();
  });

  test("CEO role shows deal-flow prompts, not PM prompts", () => {
    render(
      <AssistantWelcomeModal userRole="ceo" onPickPrompt={() => undefined} />,
    );
    expect(screen.getByText("top 3 deals")).toBeInTheDocument();
    /* PM-specific prompt should NOT appear for ceo. */
    expect(screen.queryByText(/create task to/)).not.toBeInTheDocument();
  });

  test("CTO role shows GitHub-flavored prompts", () => {
    render(
      <AssistantWelcomeModal userRole="cto" onPickPrompt={() => undefined} />,
    );
    expect(screen.getByText(/what PRs are open/)).toBeInTheDocument();
  });

  test("Unknown role falls back to the generic kit", () => {
    render(
      <AssistantWelcomeModal
        userRole="intern_special"
        onPickPrompt={() => undefined}
      />,
    );
    /* Generic kit always includes briefing + calendar today. */
    expect(screen.getByText("briefing")).toBeInTheDocument();
    expect(screen.getByText("what is on my calendar today")).toBeInTheDocument();
  });
});

describe("AssistantWelcomeModal — pick a prompt", () => {
  test("clicking a prompt fills the composer via onPickPrompt + dismisses + fires analytics", () => {
    const onPick = jest.fn();
    render(
      <AssistantWelcomeModal
        userName="Alicia"
        userRole="pm"
        onPickPrompt={onPick}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByText("briefing"));
    });

    expect(onPick).toHaveBeenCalledWith("briefing");
    /* Modal closes after pick. */
    expect(screen.queryByTestId("assistant-welcome-modal")).not.toBeInTheDocument();
    /* Analytics fires. */
    expect(trackEvents()).toContain("assistant.welcome_prompt_clicked");
    /* localStorage flag set so re-render does not re-open. */
    expect(window.localStorage.getItem("instinct_welcome_seen")).toBe("1");
  });

  test("picking a prompt fires the prompt + role in analytics metadata", () => {
    render(
      <AssistantWelcomeModal
        userRole="cto"
        onPickPrompt={() => undefined}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByText(/what PRs are open/));
    });
    const event = lastTrackEvent();
    expect(event.event).toBe("assistant.welcome_prompt_clicked");
    expect(event.metadata?.role).toBe("cto");
    expect(String(event.metadata?.prompt)).toMatch(/what PRs are open/);
  });
});

describe("AssistantWelcomeModal — dismiss paths", () => {
  test("X button closes + sets storage flag + fires assistant.welcome_dismissed", () => {
    render(
      <AssistantWelcomeModal userRole="pm" onPickPrompt={() => undefined} />,
    );
    act(() => {
      fireEvent.click(screen.getByTestId("assistant-welcome-modal-close"));
    });
    expect(screen.queryByTestId("assistant-welcome-modal")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("instinct_welcome_seen")).toBe("1");
    const event = lastTrackEvent();
    expect(event.event).toBe("assistant.welcome_dismissed");
    expect(event.metadata?.method).toBe("x_button");
  });

  test("clicking the backdrop closes + sets storage + fires dismissed with click_outside", () => {
    render(
      <AssistantWelcomeModal userRole="pm" onPickPrompt={() => undefined} />,
    );
    act(() => {
      fireEvent.click(screen.getByTestId("assistant-welcome-modal-backdrop"));
    });
    expect(screen.queryByTestId("assistant-welcome-modal")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("instinct_welcome_seen")).toBe("1");
    const event = lastTrackEvent();
    expect(event.event).toBe("assistant.welcome_dismissed");
    expect(event.metadata?.method).toBe("click_outside");
  });

  test("clicking inside the modal body does NOT close it", () => {
    render(
      <AssistantWelcomeModal userRole="pm" onPickPrompt={() => undefined} />,
    );
    /* Click on a non-button area of the modal body. */
    const modal = screen.getByTestId("assistant-welcome-modal");
    act(() => {
      fireEvent.click(modal);
    });
    /* Still open — only backdrop / X / prompt dismisses. */
    expect(screen.getByTestId("assistant-welcome-modal")).toBeInTheDocument();
  });
});

describe("AssistantWelcomeModal — does not re-open across re-renders", () => {
  test("after dismiss, a fresh render of the component stays closed", () => {
    const { unmount } = render(
      <AssistantWelcomeModal userRole="pm" onPickPrompt={() => undefined} />,
    );
    act(() => {
      fireEvent.click(screen.getByTestId("assistant-welcome-modal-close"));
    });
    unmount();
    /* Mount again — the localStorage flag is now set. Should not re-open. */
    render(
      <AssistantWelcomeModal userRole="pm" onPickPrompt={() => undefined} />,
    );
    expect(screen.queryByTestId("assistant-welcome-modal")).not.toBeInTheDocument();
  });
});
