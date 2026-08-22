/**
 * @jest-environment jsdom
 */

/**
 * Your routines page.
 *
 * The tests worth having are about ABSENCE and about ORDER. An empty page reads
 * as "this feature does nothing" rather than "you have not run anything yet",
 * and a page that opens with a log buries the one thing on it that somebody can
 * act on.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import Page from "../page";

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

const mockFetch = jest.fn();
const mockUser = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  getInstinctUser: () => mockUser(),
}));

function payload(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    builtIn: [
      { command: "run my morning", description: "Your calendar and tasks.", steps: 5, humanSteps: 1 },
    ],
    saved: [],
    schedules: [],
    runs: [],
    findings: [],
    ...over,
  };
}

const respond = (body: unknown, ok = true) =>
  mockFetch.mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.mockReturnValue({ role: "member" });
});

describe("auth", () => {
  it("redirects an unauthenticated visitor instead of rendering a blank page", () => {
    mockUser.mockReturnValue(null);
    render(<Page />);
    expect(mockPush).toHaveBeenCalledWith("/login?next=/routines");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("what somebody sees before they have used any of it", () => {
  it("still lists the built-in chains, so the page is never empty", async () => {
    /* An empty page on a first visit teaches people there is nothing here. */
    respond(payload());
    render(<Page />);
    expect(await screen.findByTestId("routines-chains")).toHaveTextContent("run my morning");
  });

  it("says why the findings are empty rather than showing an empty box", async () => {
    respond(payload());
    render(<Page />);
    const note = await screen.findByTestId("routines-no-findings");
    expect(note).toHaveTextContent(/not enough runs yet/i);
    /* And says it stays quiet on purpose, so silence does not read as broken. */
    expect(note).toHaveTextContent(/rather than reading something into one morning/i);
  });

  it("tells somebody how to start a schedule when they have none", async () => {
    respond(payload());
    render(<Page />);
    expect(await screen.findByTestId("routines-no-schedules")).toHaveTextContent(/every weekday at 8am/i);
  });
});

describe("what is waiting on the person comes first", () => {
  it("shows a waiting run above everything else", async () => {
    /* Everything else on the page is information. This is somebody being held
       up, and it is the only row that is a request. */
    respond(
      payload({
        runs: [
          {
            runId: "r1",
            routineId: "morning",
            state: "waiting_for_human",
            startedAt: "2026-08-22T08:00:00.000Z",
            techMs: 4000,
            humanMs: 0,
            steps: 4,
            waitingOn: "Read the three, change any you disagree with",
          },
        ],
      }),
    );
    render(<Page />);
    const waiting = await screen.findByTestId("routines-waiting");
    expect(waiting).toHaveTextContent("Read the three");

    const root = screen.getByTestId("routines-root");
    const html = root.innerHTML;
    expect(html.indexOf("Waiting on you")).toBeLessThan(html.indexOf("Recent runs"));
  });

  it("does not show the waiting panel when nothing is waiting", async () => {
    respond(payload({ runs: [] }));
    render(<Page />);
    await screen.findByTestId("routines-chains");
    expect(screen.queryByTestId("routines-waiting")).not.toBeInTheDocument();
  });
});

describe("the two numbers stay apart", () => {
  it("reports work done for you and your own time separately", async () => {
    /* Added together they say nothing. Apart they say what the machine carried
       and what the person still carries. */
    respond(
      payload({
        runs: [
          {
            runId: "r1",
            routineId: "morning",
            state: "done",
            startedAt: "2026-08-22T08:00:00.000Z",
            techMs: 120_000,
            humanMs: 600_000,
            steps: 5,
            waitingOn: null,
          },
        ],
      }),
    );
    render(<Page />);
    expect(await screen.findByTestId("routines-metric-tech")).toHaveTextContent(/work done for you/i);
    expect(screen.getByTestId("routines-metric-human")).toHaveTextContent(/your own time/i);
  });
});

describe("the conclusion sits above the log", () => {
  const finding = {
    routineId: "morning",
    stepIndex: 4,
    label: "Rehearse the opening out loud",
    kind: "not_happening" as const,
    observation: "Asked 12 times, done 3.",
    suggestion: "Either this is not as important as the routine assumes, or it matters and is not getting done.",
    completionRate: 0.25,
  };

  it("shows the reasoning, not just a label", async () => {
    respond(payload({ findings: [finding] }));
    render(<Page />);
    const list = await screen.findByTestId("routines-findings");
    expect(list).toHaveTextContent("Asked 12 times");
    expect(list).toHaveTextContent(/not as important/i);
  });

  it("puts the findings above the run history", async () => {
    respond(payload({ findings: [finding] }));
    render(<Page />);
    await screen.findByTestId("routines-findings");
    const html = screen.getByTestId("routines-root").innerHTML;
    expect(html.indexOf("What your own steps are telling you")).toBeLessThan(html.indexOf("Recent runs"));
  });

  it("does not colour a skipped step as an error", async () => {
    /* A step somebody skipped is information about the routine. Red would make
       the page feel like an assessment of the person reading it. */
    respond(payload({ findings: [finding] }));
    render(<Page />);
    const list = await screen.findByTestId("routines-findings");
    expect(list).toHaveTextContent("Not happening");
    expect(list.innerHTML).not.toMatch(/error/i);
  });
});

describe("when the read fails", () => {
  it("says so rather than rendering an encouraging empty page", async () => {
    respond({}, false);
    render(<Page />);
    expect(await screen.findByTestId("routines-error")).toHaveTextContent(/could not be read/i);
    expect(screen.queryByTestId("routines-chains")).not.toBeInTheDocument();
  });
});
