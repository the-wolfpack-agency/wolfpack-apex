/**
 * "What can you do?"
 *
 * The question every new person asks, and the one a written help page answers
 * wrongly within a week. This reads the LIVE registry, so the test that earns
 * its place is the one proving the answer changes when the product does.
 *
 * The second thing under test is the role filter. Listing something the caller
 * cannot run is a menu of disappointments, and it is also a quiet description
 * of the permission system to somebody who was only asking for help.
 */
import { capabilitiesTool, matchCapabilitiesIntent } from "../capabilities-tool";
import { getTools } from "../registry";
import { canInvokeTool } from "../gate";
import "../index";

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

const ctx = (userRole: string) => ({
  userId: "u1",
  userRole,
  workspaceId: "default",
});

async function answerFor(role: string) {
  const res = await capabilitiesTool.handler({}, ctx(role) as never);
  if (!res.ok) throw new Error("handler failed");
  return res;
}

describe("recognising the question", () => {
  it.each([
    "what can you do",
    "What can you do?",
    "what can I ask you",
    "help",
    "show me your capabilities",
    "what are you able to do",
  ])("matches %p", (message) => {
    expect(matchCapabilitiesIntent(message)).toEqual({});
  });

  it.each([
    "what can you do about the invoice",
    "help me draft an email",
    "can you help with the calendar",
  ])("does not match %p, which is a real request", (message) => {
    expect(matchCapabilitiesIntent(message)).toBeNull();
  });
});

describe("the answer is read from the product, not written about it", () => {
  it("leads with the whole jobs, because that is what somebody wants", async () => {
    /* A list that opens with forty individual tools buries the chains, and the
       person goes back to doing the job by hand in five windows. */
    const res = await answerFor("cto");
    const routineIndex = res.answer.indexOf("run my morning");
    const toolIndex = res.answer.indexOf("One thing at a time");
    expect(routineIndex).toBeGreaterThan(-1);
    expect(routineIndex).toBeLessThan(toolIndex);
  });

  it("counts the tools the caller can actually invoke", async () => {
    const res = await answerFor("cto");
    const expected = getTools().filter(
      (t) => canInvokeTool("cto", t.capability) && t.name !== "what_can_you_do",
    ).length;
    expect(res.data.toolCount).toBe(expected);
  });

  it("says nothing is sent without confirmation, because that is the deciding fact", async () => {
    const res = await answerFor("cto");
    expect(res.answer).toMatch(/without you confirming/i);
  });

  it("points at describing your day, which is the most useful thing to type next", async () => {
    /* A capability list still asks the person to map their own job onto it,
       which is the translation the product is supposed to do for them. */
    const res = await answerFor("cto");
    expect(res.answer).toMatch(/describe your day/i);
    expect(res.answer).toMatch(/chain the rest into one command/i);
  });

  it("never lists itself", async () => {
    const res = await answerFor("cto");
    expect(res.answer).not.toContain("what_can_you_do");
  });
});

describe("it describes what THIS person can do", () => {
  it("shows a junior role fewer tools than a senior one", async () => {
    /* The gate is the same one the dispatcher enforces. If this ever stops
       being true, the menu and the runtime have come apart. */
    const senior = await answerFor("cto");
    const junior = await answerFor("viewer");
    expect(junior.data.toolCount).toBeLessThan(senior.data.toolCount);
  });

  it("counts what is withheld without naming it", async () => {
    /* A person cannot act on the names of things they may not use, and
       printing them turns an answer into a tour of the permission system. */
    const res = await answerFor("viewer");
    expect(res.data.withheldCount).toBeGreaterThan(0);
    expect(res.answer).toMatch(/more tools? your role does not have access to/i);
    const withheldNames = getTools()
      .filter((t) => !canInvokeTool("viewer", t.capability))
      .map((t) => t.name);
    for (const name of withheldNames) expect(res.answer).not.toContain(name);
  });

  it("never lists a tool the caller could not run", async () => {
    const res = await answerFor("viewer");
    const forbidden = getTools().filter((t) => !canInvokeTool("viewer", t.capability));
    for (const t of forbidden) {
      /* Descriptions are what get printed, so the description is what to look
         for: a name check alone would pass while the line was still there. */
      const firstSentence = t.description.split(/(?<=\.)\s/)[0].replace(/\.$/, "");
      expect(res.answer).not.toContain(firstSentence);
    }
  });

  it("is open to any authenticated role, since it is how somebody finds their footing", async () => {
    expect(capabilitiesTool.capability).toBe("*");
    const res = await answerFor("member");
    expect(res.answer.length).toBeGreaterThan(100);
  });
});
