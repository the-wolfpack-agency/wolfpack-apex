/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import FactoryChat from "@/components/ai-code/factory-chat/FactoryChat";
import type { PipelineResult } from "@/components/ai-code/factory-chat/types";

const mockRun = jest.fn();
const mockApprove = jest.fn();
const mockCi = jest.fn();
jest.mock("@/components/ai-code/factory-chat/client", () => ({
  FACTORY_API_BASE: "",
  requestPipelineRun: (...a: unknown[]) => mockRun(...a),
  approveHandoff: (...a: unknown[]) => mockApprove(...a),
  loadCi: (...a: unknown[]) => mockCi(...a),
}));

const cleanResult: PipelineResult = {
  run: { status: "ready_for_pr", diff: "diff x" },
  executor: { author: "gpt-4o-mini" }, executorAttempts: 1,
  invariants: { wouldBlock: false }, deepScan: { blocking: false, critical: 0 },
  duplication: { escalate: false }, syntax: { ok: true },
  phantomImports: [], incompleteFiles: [], removedExports: [], anchorFailures: [], brokenLocalImports: [],
};

beforeEach(() => jest.clearAllMocks());

// Guided intake is the default; composer-based tests switch to freeform first.
const goFreeform = () => fireEvent.click(screen.getByTestId("freeform"));
afterEach(() => cleanup());

it("guided intake is the default and a guided submit runs the pipeline with a composed request", async () => {
  mockRun.mockResolvedValue({ ok: true, status: 200, result: { run: { status: "ready_for_pr", diff: "d" }, executor: { author: "m" }, executorAttempts: 1, invariants:{wouldBlock:false}, deepScan:{blocking:false,critical:0}, duplication:{escalate:false}, syntax:{ok:true}, phantomImports:[], incompleteFiles:[], removedExports:[], anchorFailures:[], brokenLocalImports:[] }, approvalId: "a1", model: { name: "m", escalated: false } });
  render(<FactoryChat />);
  expect(screen.getByTestId("intake-goals")).toBeInTheDocument(); // no blank box by default
  fireEvent.click(screen.getByTestId("goal-feature"));
  fireEvent.change(screen.getByTestId("input-what"), { target: { value: "a billing page" } });
  await act(async () => { fireEvent.click(screen.getByTestId("intake-start")); });
  await waitFor(() => expect(mockRun).toHaveBeenCalled());
  expect(mockRun.mock.calls[0][0].prompt).toMatch(/Add a new feature: a billing page/);
});

it("renders the OGIAM brand lockup in the header", () => {
  render(<FactoryChat />);
  goFreeform();
  expect(screen.getByAltText("OGIAM")).toBeInTheDocument();
});

it("a prompt chip seeds the composer", () => {
  render(<FactoryChat />);
  goFreeform();
  fireEvent.click(screen.getByTestId("chip-migration"));
  expect((screen.getByTestId("composer") as HTMLTextAreaElement).value).toMatch(/database migration/i);
});

it("send -> clean result renders the checkpoint track + model badge + consent CTA", async () => {
  mockRun.mockResolvedValue({ ok: true, status: 200, result: cleanResult, approvalId: "appr1", model: { name: "gpt-4o-mini", escalated: false } });
  render(<FactoryChat />);
  goFreeform();
  fireEvent.change(screen.getByTestId("composer"), { target: { value: "Add a thing" } });
  await act(async () => { fireEvent.click(screen.getByTestId("send")); });
  await waitFor(() => expect(screen.getByTestId("checkpoint-track")).toBeInTheDocument());
  expect(screen.getByTestId("model-badge")).toHaveTextContent("gpt-4o-mini");
  expect(screen.getAllByTestId("checkpoint").length).toBe(6); // the 6 gate checkpoints
  expect(screen.getByTestId("consent-cta")).toBeInTheDocument();
});

it("shows the in-chat diff review alongside the consent step", async () => {
  mockRun.mockResolvedValue({ ok: true, status: 200, result: cleanResult, approvalId: "appr1", model: { name: "gpt-4o-mini", escalated: false } });
  render(<FactoryChat />);
  goFreeform();
  fireEvent.change(screen.getByTestId("composer"), { target: { value: "Add a thing" } });
  await act(async () => { fireEvent.click(screen.getByTestId("send")); });
  await waitFor(() => expect(screen.getByTestId("consent-cta")).toBeInTheDocument());
  expect(screen.getByTestId("diff-view")).toBeInTheDocument(); // review in-chat, no link-out
});

it("merge is gated on consent, then opens the PR and shows the link", async () => {
  mockRun.mockResolvedValue({ ok: true, status: 200, result: cleanResult, approvalId: "appr1", model: { name: "gpt-4o-mini", escalated: false } });
  mockApprove.mockResolvedValue({ ok: true, validating: false, prUrl: "https://github.com/o/r/pull/7", branch: "factory/x" });
  mockCi.mockResolvedValue(null);
  render(<FactoryChat />);
  goFreeform();
  fireEvent.change(screen.getByTestId("composer"), { target: { value: "Add a thing" } });
  await act(async () => { fireEvent.click(screen.getByTestId("send")); });
  await waitFor(() => expect(screen.getByTestId("merge")).toBeInTheDocument());
  expect(screen.getByTestId("merge")).toBeDisabled();            // consent required
  fireEvent.click(screen.getByTestId("consent"));
  expect(screen.getByTestId("merge")).toBeEnabled();
  await act(async () => { fireEvent.click(screen.getByTestId("merge")); });
  await waitFor(() => expect(screen.getByTestId("pr-link")).toHaveAttribute("href", "https://github.com/o/r/pull/7"));
});

it("a held (needs_human) run shows the held notice, no consent CTA", async () => {
  mockRun.mockResolvedValue({ ok: true, status: 200, result: { ...cleanResult, run: { status: "needs_human", diff: "x" }, deepScan: { blocking: true, critical: 1 } }, approvalId: null, model: { name: "DeepSeek-V4-Flash", escalated: true } });
  render(<FactoryChat />);
  goFreeform();
  fireEvent.change(screen.getByTestId("composer"), { target: { value: "sketchy change" } });
  await act(async () => { fireEvent.click(screen.getByTestId("send")); });
  await waitFor(() => expect(screen.getByTestId("held-notice")).toBeInTheDocument());
  expect(screen.getByTestId("escalated")).toBeInTheDocument();
  expect(screen.queryByTestId("consent-cta")).toBeNull();
});

it("a non-request (intent gate) shows a gentle nudge, not a red error or a PR", async () => {
  mockRun.mockResolvedValue({ ok: false, status: 400, result: {}, notARequest: true, error: "That doesn't look like a change request yet." });
  render(<FactoryChat />);
  goFreeform();
  fireEvent.change(screen.getByTestId("composer"), { target: { value: "hello" } });
  await act(async () => { fireEvent.click(screen.getByTestId("send")); });
  await waitFor(() => expect(screen.getByTestId("not-a-request")).toBeInTheDocument());
  expect(screen.getByTestId("not-a-request")).toHaveTextContent(/change request/i);
  expect(screen.queryByTestId("turn-error")).toBeNull();      // not a red error
  expect(screen.queryByTestId("consent-cta")).toBeNull();     // and never a PR path
});

it("a non-200 pipeline response surfaces an honest error, not a blank bubble", async () => {
  mockRun.mockResolvedValue({ ok: false, status: 422, result: {}, error: "The factory responded 422." });
  render(<FactoryChat />);
  goFreeform();
  fireEvent.change(screen.getByTestId("composer"), { target: { value: "x" } });
  await act(async () => { fireEvent.click(screen.getByTestId("send")); });
  await waitFor(() => expect(screen.getByTestId("turn-error")).toHaveTextContent("422"));
});
