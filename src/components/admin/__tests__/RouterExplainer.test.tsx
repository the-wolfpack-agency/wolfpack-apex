/**
 * @jest-environment jsdom
 *
 * The section a non-technical team member reads before explaining this to a
 * client. Asked for on 2026-08-19.
 *
 * The test that matters is the last one. Everything here will be repeated in a
 * room by somebody who cannot check it, to somebody who may then ask to be
 * shown it. So every claim must be true of the product TODAY and provable on
 * this page, and the copy must avoid the vocabulary that needs a second
 * explanation.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import RouterExplainer from "@/components/admin/RouterExplainer";

describe("RouterExplainer", () => {
  test("leads with the thing that is actually unusual", () => {
    render(<RouterExplainer />);
    // Not the model catalogue, not the cost: that most questions never reach a
    // model at all is the claim nobody expects and the one that is true.
    expect(screen.getByText(/Most questions never reach an AI model at all/i)).toBeInTheDocument();
  });

  test("states the protection claim in terms of what leaves, not of features", () => {
    render(<RouterExplainer />);
    expect(screen.getByText(/Nothing leaves without being checked/i)).toBeInTheDocument();
    expect(screen.getByText(/the model never receives them/i)).toBeInTheDocument();
  });

  test("says the gate covers models we did not build, which is the durable claim", () => {
    render(<RouterExplainer />);
    expect(screen.getByText(/including ones we did not build/i)).toBeInTheDocument();
  });

  test("every claim names the panel on this page that substantiates it", () => {
    /* A claim somebody cannot substantiate in the room is worse than one they
       never made, so this is structural rather than a nicety.
       Label reworded 2026-08-20: "Where to point" read as an instruction to
       point at something in the room rather than "here is the evidence". */
    render(<RouterExplainer />);
    const pointers = screen.getAllByText(/^Proof on this page:/);
    expect(pointers.length).toBeGreaterThanOrEqual(5);
  });

  test("each proof sends the reader somewhere that actually exists", () => {
    /* A pointer to a panel that is not on the page is worse than no pointer:
       the reader looks, fails to find it, and stops believing the rest. */
    const { container } = render(<RouterExplainer />);
    const proofs = Array.from(container.querySelectorAll(".rx-proof")).map(
      (el) => el.textContent ?? "",
    );
    const PANELS = [
      "Activity",
      "What the router kept in",
      "models list",
      "reasons panel",
      "Which models were used",
    ];
    const unanchored = proofs.filter(
      (text) => !PANELS.some((panel) => text.includes(panel)),
    );
    expect(unanchored).toEqual([]);
  });

  test("avoids the vocabulary that needs its own explanation", () => {
    const { container } = render(<RouterExplainer />);
    const copy = container.textContent ?? "";
    for (const jargon of ["tier", "token", "chokepoint", "LLM", "inference", "payload"]) {
      expect(copy.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
  });
});
