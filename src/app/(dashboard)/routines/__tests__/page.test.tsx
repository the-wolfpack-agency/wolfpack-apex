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

/**
 * Seeing the chain that ran.
 *
 * A run used to be one line saying how many steps it had, which answers
 * "did it work" and nothing else. Somebody deciding whether to trust a
 * chain with their morning wants to know WHICH systems it touched, in
 * what order, and where it stopped for them.
 *
 * Taken from a real run against production on 2026-08-24: three tools, a
 * model step, and a human step, 4.9s of machine time against 55.8s of a
 * person's.
 */
describe("the steps of a run", () => {
  const RUN = {
    runId: "r1",
    routineId: "look at the week ahead",
    state: "done",
    startedAt: "2026-08-24T09:32:36.780Z",
    techMs: 4931,
    humanMs: 55832,
    steps: 5,
    waitingOn: null,
  };
  const STEPS = [
    { index: 0, kind: "tool", tool: "calendar_widget", label: "Reading the calendar", status: "ok", durationMs: 32, error: null, humanAction: null },
    { index: 1, kind: "tool", tool: "task_list_widget", label: "Collecting what is open", status: "ok", durationMs: 43, error: null, humanAction: null },
    { index: 2, kind: "tool", tool: "cross_tool_insights_widget", label: "Looking across the tools", status: "ok", durationMs: 592, error: null, humanAction: null },
    { index: 3, kind: "model", tool: null, label: "Working out the week", status: "ok", durationMs: 4264, error: null, humanAction: null },
    { index: 4, kind: "human", tool: null, label: "Decide what the week is really for", status: "ok", durationMs: 55832, error: null, humanAction: "do" },
  ];

  function respondToBoth() {
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes("/steps")
        ? { ok: true, status: 200, json: async () => ({ runId: "r1", steps: STEPS }) }
        : { ok: true, status: 200, json: async () => payload({ runs: [RUN] }) },
    );
  }

  it("keeps them closed until somebody asks", async () => {
    /* The list can hold twenty runs and nobody opens twenty. Fetching
       every run's steps to render a page where most stay closed would
       make it slower for everybody to serve the person who opens one. */
    respondToBoth();
    render(<Page />);
    await screen.findByTestId("routines-runs");
    expect(screen.queryByTestId("routines-run-steps")).not.toBeInTheDocument();
    const stepCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes("/steps"));
    expect(stepCalls).toHaveLength(0);
  });

  it("shows which system each step touched, in the order it ran", async () => {
    respondToBoth();
    render(<Page />);
    (await screen.findByTestId("routines-run-toggle")).click();

    const tiles = await screen.findAllByTestId("routines-run-step");
    expect(tiles).toHaveLength(5);
    /* The tool name is the answer to "what did it touch", and the order
       is the answer to "what happened first". */
    expect(tiles[0]).toHaveTextContent("calendar_widget");
    expect(tiles[1]).toHaveTextContent("task_list_widget");
    expect(tiles[2]).toHaveTextContent("cross_tool_insights_widget");
  });

  it("says plainly when a step touched no system", async () => {
    /* A model step and a human step reached none of the client's systems.
       Leaving a gap there invites somebody to assume one did. */
    respondToBoth();
    render(<Page />);
    (await screen.findByTestId("routines-run-toggle")).click();
    const tiles = await screen.findAllByTestId("routines-run-step");
    expect(tiles[3]).toHaveTextContent("no system touched");
    expect(tiles[4]).toHaveTextContent("your call");
  });

  it("counts a human step's time as the person's, not the machine's", async () => {
    /* The distinction the whole product is built on. 55.8 seconds of
       somebody's attention is not 55.8 seconds of work done for them. */
    respondToBoth();
    render(<Page />);
    (await screen.findByTestId("routines-run-toggle")).click();
    const tiles = await screen.findAllByTestId("routines-run-step");
    expect(tiles[4]).toHaveTextContent("of your time");
    expect(tiles[0]).not.toHaveTextContent("of your time");
  });

  it("says nothing was recorded rather than spinning forever", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      String(url).includes("/steps")
        ? { ok: true, status: 200, json: async () => ({ runId: "r1", steps: [] }) }
        : { ok: true, status: 200, json: async () => payload({ runs: [RUN] }) },
    );
    render(<Page />);
    (await screen.findByTestId("routines-run-toggle")).click();
    expect(await screen.findByTestId("routines-run-no-steps")).toBeInTheDocument();
  });
});
