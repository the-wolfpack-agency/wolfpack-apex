/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AiVisibilityPanel, type AiVisibilityData, type TrainingControl } from "../AiVisibilityPanel";

const DATA: AiVisibilityData = { days: 30, byPurpose: {}, agents: [] };
const CHOICES = ["Bytespider", "ClaudeBot", "GPTBot", "Meta-ExternalAgent"];
const control = (over: Partial<TrainingControl> = {}): TrainingControl => ({ choices: CHOICES, blocked: [], canEdit: true, save: jest.fn(async () => true), ...over });

it("lists every AI training crawler, allowed by default", () => {
  render(<AiVisibilityPanel data={DATA} control={control()} />);
  for (const a of CHOICES) expect(screen.getByTestId(`ff-ai-visibility-allow-${a}`)).toBeChecked();
});

it("turning one away saves the new list and says when it applies", async () => {
  const c = control();
  render(<AiVisibilityPanel data={DATA} control={c} />);
  fireEvent.click(screen.getByTestId("ff-ai-visibility-allow-GPTBot"));
  await waitFor(() => expect(screen.getByTestId("ff-ai-visibility-control-status")).toHaveTextContent("Saved"));
  expect(c.save).toHaveBeenCalledWith(["GPTBot"]);
  expect(screen.getByTestId("ff-ai-visibility-allow-GPTBot")).not.toBeChecked();
  fireEvent.click(screen.getByTestId("ff-ai-visibility-allow-GPTBot"));
  await waitFor(() => expect(c.save).toHaveBeenLastCalledWith([]));
});

it("a failed save keeps the previous setting and says nothing changed", async () => {
  const c = control({ blocked: ["ClaudeBot"], save: jest.fn(async () => false) });
  render(<AiVisibilityPanel data={DATA} control={c} />);
  fireEvent.click(screen.getByTestId("ff-ai-visibility-allow-GPTBot"));
  await waitFor(() => expect(screen.getByTestId("ff-ai-visibility-control-status")).toHaveTextContent("Could not save"));
  expect(screen.getByTestId("ff-ai-visibility-allow-GPTBot")).toBeChecked();
  expect(screen.getByTestId("ff-ai-visibility-allow-ClaudeBot")).not.toBeChecked();
});

it("read-only for a viewer who cannot change it", () => {
  const c = control({ canEdit: false, blocked: ["GPTBot"] });
  render(<AiVisibilityPanel data={DATA} control={c} />);
  expect(screen.getByTestId("ff-ai-visibility-allow-GPTBot")).toBeDisabled();
  expect(screen.getByTestId("ff-ai-visibility-control-status")).toHaveTextContent("Only an administrator");
  fireEvent.click(screen.getByTestId("ff-ai-visibility-allow-GPTBot"));
  expect(c.save).not.toHaveBeenCalled();
});

it("no control section without a control; requests a policy turned away are shown per agent", () => {
  render(<AiVisibilityPanel data={{ days: 30, byPurpose: { ai_training: 9 }, agents: [{ agent: "GPTBot", vendor: "OpenAI", purpose: "ai_training", requests: 9, verifiedRequests: 0, impersonations: 0, policyBlocked: 9, identity: "unverified", pages: 1, topPages: [], daily: [9], lastSeen: null }] }} />);
  expect(screen.queryByTestId("ff-ai-visibility-control")).toBeNull();
  expect(screen.getByTestId("ff-ai-visibility-policy-blocked")).toHaveTextContent("Turned away by your policy: 9 requests");
});
