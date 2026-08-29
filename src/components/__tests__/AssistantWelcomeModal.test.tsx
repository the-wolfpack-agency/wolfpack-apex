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
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
    /* Curated prompt library (ee0fad85) replaced the old "top 3 deals"
     * chip with the more specific high-value-pipeline prompt. Assert the
     * current real deal-flow chip so the test tracks the shipped copy. */
    expect(
      screen.getByText("deals over $50k closing this month"),
    ).toBeInTheDocument();
    /* PM-specific prompt should NOT appear for ceo. */
    expect(screen.queryByText(/create task to/)).not.toBeInTheDocument();
  });

  test("CTO role shows non-dev chips (briefing + today's calendar + inbox) — GitHub chips are dev-only", () => {
    render(
      <AssistantWelcomeModal userRole="cto" onPickPrompt={() => undefined} />,
    );
    expect(screen.getByText("briefing")).toBeInTheDocument();
    expect(screen.getByText("today's calendar")).toBeInTheDocument();
    expect(screen.getByText("inbox")).toBeInTheDocument();
    expect(screen.queryByText(/what PRs are open/)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed CI/)).not.toBeInTheDocument();
  });

  test("Unknown role falls back to the generic kit (briefing + today's calendar + inbox)", () => {
    render(
      <AssistantWelcomeModal
        userRole="intern_special"
        onPickPrompt={() => undefined}
      />,
    );
    expect(screen.getByText("briefing")).toBeInTheDocument();
    expect(screen.getByText("today's calendar")).toBeInTheDocument();
    expect(screen.getByText("inbox")).toBeInTheDocument();
  });
});

describe("AssistantWelcomeModal — role-gated GitHub chips", () => {
  test("role=dev → GitHub chips visible (open PRs + failed CI)", () => {
    render(
      <AssistantWelcomeModal userRole="dev" onPickPrompt={() => undefined} />,
    );
    expect(screen.getByText(/what PRs are open/)).toBeInTheDocument();
    expect(screen.getByText(/failed CI/)).toBeInTheDocument();
    /* Non-dev chips should NOT appear for dev role. */
    expect(screen.queryByText("today's calendar")).not.toBeInTheDocument();
    expect(screen.queryByText("inbox")).not.toBeInTheDocument();
  });

  test("role=user (non-dev) → calendar + inbox chips visible, no GitHub", () => {
    render(
      <AssistantWelcomeModal userRole="user" onPickPrompt={() => undefined} />,
    );
    expect(screen.getByText("today's calendar")).toBeInTheDocument();
    expect(screen.getByText("inbox")).toBeInTheDocument();
    expect(screen.queryByText(/what PRs are open/)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed CI/)).not.toBeInTheDocument();
  });

  test("picking the calendar chip fires the natural-language prompt (not the label)", () => {
    const onPick = jest.fn();
    render(
      <AssistantWelcomeModal
        userRole="user"
        onPickPrompt={onPick}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByText("today's calendar"));
    });
    expect(onPick).toHaveBeenCalledWith("what's on my calendar today");
    const event = lastTrackEvent();
    expect(event.event).toBe("assistant.welcome_prompt_clicked");
    expect(event.metadata?.chip_label).toBe("today's calendar");
    expect(event.metadata?.user_role).toBe("user");
    expect(event.metadata?.prompt).toBe("what's on my calendar today");
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

  test("picking a prompt fires the prompt + role in analytics metadata (dev role exercises the GitHub chip)", () => {
    render(
      <AssistantWelcomeModal
        userRole="dev"
        onPickPrompt={() => undefined}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByText(/what PRs are open/));
    });
    const event = lastTrackEvent();
    expect(event.event).toBe("assistant.welcome_prompt_clicked");
    expect(event.metadata?.role).toBe("dev");
    expect(event.metadata?.user_role).toBe("dev");
    expect(String(event.metadata?.prompt)).toMatch(/what PRs are open/);
    /* For chips without a separate label, chip_label === prompt text. */
    expect(String(event.metadata?.chip_label)).toMatch(/what PRs are open/);
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

/**
 * Escape closes it.
 *
 * It did not, and the modal covers the answer. Measured against the live
 * deployment 2026-08-29: click-outside dismissed it and the dismissal persisted
 * correctly across a reload, but Escape did nothing. Anybody whose reflex is
 * Escape sits looking at a panel over their own results and concludes it is
 * stuck.
 *
 * Invisible to every existing test here, because a test that clicks never
 * presses a key. It cost me several screenshots of a modal covering the very
 * answers I was trying to read before I checked which dismissal methods
 * actually worked.
 */
describe("dismissing with the keyboard", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("closes when Escape is pressed", async () => {
    render(<AssistantWelcomeModal userName="Nick" userRole="cto" onPickPrompt={() => {}} />);
    expect(await screen.findByText(/I.m Instinct/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByText(/I.m Instinct/i)).not.toBeInTheDocument();
    });
  });

  /* Same contract as the other dismissal routes: having closed it once, it
     must not come back on the next visit. A close that does not persist is a
     close somebody has to do every single time. */
  it("stays dismissed after Escape, like the other dismissal routes", async () => {
    const { unmount } = render(
      <AssistantWelcomeModal userName="Nick" userRole="cto" onPickPrompt={() => {}} />,
    );
    expect(await screen.findByText(/I.m Instinct/i)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText(/I.m Instinct/i)).not.toBeInTheDocument());
    unmount();

    render(<AssistantWelcomeModal userName="Nick" userRole="cto" onPickPrompt={() => {}} />);
    await waitFor(() => {
      expect(screen.queryByText(/I.m Instinct/i)).not.toBeInTheDocument();
    });
  });

  /* Only Escape. A modal that closed on any keypress would vanish while
     somebody was reading it. */
  it("ignores other keys", async () => {
    render(<AssistantWelcomeModal userName="Nick" userRole="cto" onPickPrompt={() => {}} />);
    expect(await screen.findByText(/I.m Instinct/i)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByText(/I.m Instinct/i)).toBeInTheDocument();
  });
});

/**
 * Do not promise that six things work without asking whether they do.
 *
 * The modal offered six prompts under "each one works right now, no setup
 * needed", built from welcomePromptsForRole, which does not filter. Measured
 * on the live deployment 2026-08-29: a workspace with no QuickBooks was shown
 * "what's our MRR" and answered "financials are not connected yet". On a
 * documents-only Phase 1 deployment four of the six need a connector nobody
 * has set up, so the front door would be mostly walls.
 *
 * welcomePromptsFor and /api/integrations/status both already existed. They
 * had simply never been introduced to each other.
 */
describe("only promising what is connected", () => {
  /* USES THE FILE'S EXISTING mockFetch, NOT global.fetch.
   *
   * Written first as `global.fetch = jest.fn()`, which passed locally and
   * failed CI: jest deletes objects set on the global scope between test
   * files, so the NEXT file in that worker lost fetch entirely and its
   * provider calls hung to a 5s timeout. runSearch.test.ts, which this change
   * never touches, failed twice for that reason.
   *
   * The module mock at the top of this file was already the right seam. It is
   * reset in beforeEach, scoped to this file, and cannot leak into another. */
  function statusReturns(body: unknown, ok = true): void {
    mockFetch.mockImplementation((url: string) =>
      String(url).includes("/api/integrations/status")
        ? Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body })
        : /* Analytics and anything else keep the default success shape. */
          Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    );
  }

  it("hides a prompt whose connector is not set up", async () => {
    statusReturns({ microsoft: { connected: true }, quickbooks: { connected: false } });
    render(<AssistantWelcomeModal userName="Nick" userRole="ops" onPickPrompt={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByText(/MRR/i)).not.toBeInTheDocument();
    });
  });

  /* The claim becomes TRUE once the list is filtered, which is the point: the
     fix is to make the sentence honest rather than to weaken it. */
  it("only claims no setup needed once it has checked", async () => {
    statusReturns({ microsoft: { connected: true }, quickbooks: { connected: true } });
    render(<AssistantWelcomeModal userName="Nick" userRole="ops" onPickPrompt={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/no setup needed/i)).toBeInTheDocument();
    });
  });

  /* A failed status call must not hide working capabilities, and must not let
     the strong claim stand either. Both halves matter. */
  it("keeps the prompts but drops the claim when the check fails", async () => {
    mockFetch.mockImplementation((url: string) =>
      String(url).includes("/api/integrations/status")
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    );
    render(<AssistantWelcomeModal userName="Nick" userRole="ops" onPickPrompt={() => {}} />);

    expect(await screen.findByText(/I.m Instinct/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(/no setup needed/i)).not.toBeInTheDocument();
    });
    /* Still offers something: hiding a working capability because a status
       call failed is the worse error. */
    expect(screen.getByText(/Try one of these/i)).toBeInTheDocument();
  });

  /* DOCUMENTS IS NEVER HIDDEN. It is the Phase 1 capability and is not gated
     on a connector: a workspace can hold documents from a SharePoint sync or
     from somebody dropping a file in, so there is no flag meaning "no
     documents". Hiding it would remove the one thing being sold. */
  it("still offers the document prompt with nothing connected", async () => {
    statusReturns({ microsoft: { connected: false }, quickbooks: { connected: false } });
    render(<AssistantWelcomeModal userName="Nick" userRole="ops" onPickPrompt={() => {}} />);

    await waitFor(() => {
      /* The chip renders the LABEL, not the prompt text it submits. */
      expect(screen.getByText(/ask a question about your documents/i)).toBeInTheDocument();
    });
  });
});
