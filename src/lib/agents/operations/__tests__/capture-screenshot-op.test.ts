import { AGENT_OPERATIONS } from "@/lib/agents/operations/registry";

const op = AGENT_OPERATIONS.find((o) => o.id === "capture_screenshot");

describe("capture_screenshot operation", () => {
  it("is registered, points at the capture route, and is team-gated", () => {
    expect(op).toBeDefined();
    expect(op!.method).toBe("POST");
    expect(op!.path).toBe("/api/tools/screenshot");
    expect(op!.capability).toBe("settings.manage_team");
  });

  it("requires a url field extracted from the instruction", () => {
    const urlField = op!.fields.find((f) => f.name === "url");
    expect(urlField).toBeDefined();
    expect(urlField!.required).toBe(true);
    expect(urlField!.extract("take a screenshot of https://wolfpack-instinct.vercel.app/tasks")).toBe(
      "https://wolfpack-instinct.vercel.app/tasks",
    );
  });

  it("matches screenshot phrasings and not unrelated ops", () => {
    expect(op!.intent.test("screenshot the deployed page")).toBe(true);
    expect(op!.intent.test("take a snapshot of the tasks page")).toBe(true);
    expect(op!.intent.test("create a qr code for ogiam.com")).toBe(false);
    expect(op!.intent.test("summarize the results")).toBe(false);
  });
});
