/** @jest-environment jsdom */
import "@testing-library/jest-dom";

const fetchWithRefresh = jest.fn();
const getInstinctToken = jest.fn(() => "tok" as string | null);
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => fetchWithRefresh(...a),
  getInstinctToken: () => getInstinctToken(),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import SecurityPlainLanguagePage from "@/app/(dashboard)/builds/security-plain-language/page";

const COURSE = {
  id: "c1",
  slug: "security-plain-language",
  title: "Security in Plain Language",
  subtitle: null,
  headline: "Take the gates down.",
  tracks: [
    { id: "t1", position: 0, name: "Foundations", audience: "Everyone", proves: "Say it plainly." },
    { id: "t2", position: 1, name: "Practitioner", audience: "Sales", proves: "Map to a problem." },
  ],
  modules: [
    {
      id: "m1", position: 0, title: "The product line", summary: "Plain words.",
      lessons: [
        { id: "l1", position: 0, title: "The network firewall", subtitle: "NGFW", blocks: [
          { type: "glossary", term: "App-ID" },
          { type: "plain", text: "It checks the driver, not just the plate." },
          { type: "stops", text: "Bad traffic in disguise." },
          { type: "without", text: "The disguise works." },
        ] },
        { id: "l2", position: 1, title: "Cloud security", subtitle: "CNAPP", blocks: [
          { type: "plain", text: "Walks the building checking every door." },
        ] },
      ],
    },
  ],
  lessonIds: ["l1", "l2"],
};
const PROGRESS0 = { enrolled: false, lessons: {}, completed: false };

function mockGet(progress = PROGRESS0) {
  fetchWithRefresh.mockImplementation((url: string, opts?: { method?: string; body?: string }) => {
    if (!opts || opts.method !== "POST") return Promise.resolve({ ok: true, json: async () => ({ course: COURSE, progress }) });
    return Promise.resolve({ ok: true, json: async () => ({ progress: { enrolled: true, lessons: { l1: "completed" }, completed: false } }) });
  });
}

beforeEach(() => { fetchWithRefresh.mockReset(); getInstinctToken.mockReset(); getInstinctToken.mockReturnValue("tok"); });

test("renders the tier ladder, lessons, and the four beats", async () => {
  mockGet();
  render(<SecurityPlainLanguagePage />);
  await waitFor(() => expect(screen.getByTestId("spl-ladder")).toBeInTheDocument());
  expect(screen.getByTestId("spl-ladder")).toHaveTextContent(/Foundations/);
  expect(screen.getByTestId("spl-progress-count")).toHaveTextContent("0 of 2");
  // the four beats render for lesson 1
  const l1 = screen.getByTestId("lesson-l1");
  expect(l1).toHaveTextContent(/App-ID/);
  expect(l1).toHaveTextContent(/What it stops/i);
  expect(l1).toHaveTextContent(/Without it/i);
});

test("marking a lesson complete POSTs action=complete and reflects progress", async () => {
  mockGet();
  render(<SecurityPlainLanguagePage />);
  await screen.findByTestId("lesson-complete-l1");
  fireEvent.click(screen.getByTestId("lesson-complete-l1"));
  await waitFor(() => expect(screen.getByTestId("lesson-done-l1")).toBeInTheDocument());
  const call = fetchWithRefresh.mock.calls.find((c) => c[0] === "/api/lms/progress" && String(c[1]?.body).includes('"complete"'));
  expect(call).toBeTruthy();
  expect(JSON.parse(call![1].body)).toEqual({ slug: "security-plain-language", lessonId: "l1", action: "complete" });
});

test("'Check yourself' reveals the four-beat rubric and POSTs a self_check", async () => {
  mockGet();
  render(<SecurityPlainLanguagePage />);
  await screen.findByTestId("lesson-check-l1");
  fireEvent.click(screen.getByTestId("lesson-check-l1"));
  await waitFor(() => expect(screen.getByTestId("lesson-selfcheck-l1")).toBeInTheDocument());
  expect(screen.getByTestId("lesson-selfcheck-l1")).toHaveTextContent(/Name the jargon/i);
  const call = fetchWithRefresh.mock.calls.find((c) => c[0] === "/api/lms/progress" && String(c[1]?.body).includes("self_check"));
  expect(call).toBeTruthy();
});

test("does not fetch or render the course when signed out (auth gate holds)", async () => {
  // jsdom's Location is non-configurable in this toolchain, so we assert the
  // behavioral contract rather than window.location.href (exercised in E2E):
  // no token -> the auth gate returns before fetching, so the course never
  // paints and no request is made. The href redirect itself is covered by E2E.
  getInstinctToken.mockReturnValue(null);
  render(<SecurityPlainLanguagePage />);
  await waitFor(() => expect(getInstinctToken).toHaveBeenCalled());
  expect(fetchWithRefresh).not.toHaveBeenCalled();
  expect(screen.queryByTestId("spl-ladder")).not.toBeInTheDocument();
});

test("restores the engagement brief for the team: the argument behind the course", async () => {
  mockGet();
  render(<SecurityPlainLanguagePage />);
  await waitFor(() => expect(screen.getByTestId("spl-ladder")).toBeInTheDocument());
  const brief = screen.getByTestId("spl-brief");
  expect(brief).toBeInTheDocument();
  expect(screen.getByTestId("spl-brief-summary")).toHaveTextContent(/argument behind this course/i);
  // The strategic content is present (from the source of truth), so the team can
  // understand the engagement without the old static page.
  expect(brief).toHaveTextContent(/gatekeeping/i); // the "why"
  expect(brief).toHaveTextContent(/Name the jargon/i); // the four-beat method
  expect(brief).toHaveTextContent(/commitment ladder/i); // what it reuses
});
