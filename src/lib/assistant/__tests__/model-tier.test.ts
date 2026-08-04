/**
 * Which model band a single assistant turn asks for.
 *
 * `callAI` sent `model_tier: "standard"` unconditionally, so the selection
 * router picked from one band on every call and the model registry had exactly
 * one reachable tier. These rules replace that constant.
 *
 * The property that matters most is the LAST test: ambiguity resolves upward.
 * A wrong guess must cost a saving, never an answer.
 */
import { selectAssistantTier } from "../model-tier";

describe("selectAssistantTier — downgrades", () => {
  test.each(["hi", "Hey", "thanks", "Thank you", "ok", "got it", "perfect", "bye"])(
    "%j is a trivial turn",
    (message) => {
      const c = selectAssistantTier({ message });
      expect(c.tier).toBe("cheap");
      expect(c.reason).toBe("trivial_turn");
    },
  );

  test("a short statement with no question is cheap", () => {
    expect(selectAssistantTier({ message: "the invite id is 8821" }).tier).toBe("cheap");
  });

  test("a pleasantry with real content attached to it is NOT trivial", () => {
    /* "thanks" matches whole-string only. This is the difference between a
       greeting and a question that happens to open politely. */
    const c = selectAssistantTier({
      message: "thanks for explaining, but why did the invite fail?",
    });
    expect(c.tier).toBe("premium");
  });
});

describe("selectAssistantTier — upgrades", () => {
  test.each([
    "why did revenue drop last month?",
    "analyze the discrepancy in the GL",
    "compare the two proposals",
    "walk me through the invite flow",
    "what are the trade-offs here?",
    "diagnose this failure",
    "should we move the deadline?",
  ])("%j needs reasoning", (message) => {
    const c = selectAssistantTier({ message });
    expect(c.tier).toBe("premium");
    expect(c.reason).toBe("reasoning_request");
  });

  test("a short question that is hard still upgrades — length is not the signal", () => {
    /* This is the rule ordering that matters: "why?" is 4 characters. Checked
       on length alone it would have been routed cheap. */
    const c = selectAssistantTier({ message: "why?" });
    expect(c.tier).toBe("premium");
  });

  test("a dense attachment is the heaviest case", () => {
    const c = selectAssistantTier({
      message: "look at the screen shot",
      attachmentBlock: "x".repeat(2000),
    });
    expect(c.tier).toBe("premium");
    expect(c.reason).toBe("heavy_attachment");
  });

  test("a small attachment is standard, not premium — a screenshot is not research", () => {
    const c = selectAssistantTier({
      message: "look at the screen shot",
      attachmentBlock: "Choose a new password",
    });
    expect(c.tier).toBe("standard");
    expect(c.reason).toBe("has_attachment");
  });

  test("an attachment beats the short-statement downgrade", () => {
    /* "look at this" is short with no question mark. Without the attachment
       rule winning, the turn that started this whole piece of work would have
       been routed to the smallest model. */
    const c = selectAssistantTier({
      message: "look at this",
      attachmentBlock: "some extracted text",
    });
    expect(c.tier).toBe("standard");
  });

  test("a long message is standard", () => {
    expect(selectAssistantTier({ message: "a".repeat(700) }).reason).toBe("long_message");
  });

  test.each(["draft an email to the dealer", "summarize this quarter", "write a proposal"])(
    "%j is composition",
    (message) => {
      expect(selectAssistantTier({ message }).tier).toBe("standard");
    },
  );

  test("deep in a conversation we stop shrinking", () => {
    const c = selectAssistantTier({ message: "and the second one", historyLength: 8 });
    expect(c.tier).toBe("standard");
    expect(c.reason).toBe("long_conversation");
  });
});

describe("selectAssistantTier — safety", () => {
  test("an unrecognised turn keeps the old behaviour exactly", () => {
    const c = selectAssistantTier({
      message: "Pull the delivery records for the three Centers in the northeast region",
    });
    expect(c.tier).toBe("standard");
  });

  test("an empty message never routes premium on a guess", () => {
    expect(["cheap", "standard"]).toContain(selectAssistantTier({ message: "" }).tier);
  });

  test("every path returns a reason, so no decision is unattributable", () => {
    for (const message of ["hi", "why?", "a".repeat(700), "draft an email", "xyzzy foo bar"]) {
      expect(selectAssistantTier({ message }).reason).toMatch(/^[a-z_]+$/);
    }
  });

  test("the same input always routes the same way", () => {
    /* Determinism is the reason this is not a model call: routing has to be
       reproducible to be debuggable and billable. */
    const run = () =>
      selectAssistantTier({ message: "why did revenue drop?", attachmentBlock: "abc" });
    expect(run()).toEqual(run());
  });

  test("only 'cheap' is ever chosen as a downgrade, and only by named rules", () => {
    /* Guards the failure mode that would actually hurt: a hard question quietly
       routed to the smallest model. */
    const hard = [
      "why did the invite fail for every new user?",
      "analyze last quarter against forecast",
      "explain how the hash chain is verified",
    ];
    for (const message of hard) {
      expect(selectAssistantTier({ message }).tier).not.toBe("cheap");
    }
  });
});
