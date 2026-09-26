/**
 * The executor stage turns a prompt into a diff and records the authoring model
 * so the repairer is a different lineage. It must extract a diff from fenced or
 * raw replies, record executor evidence, and degrade honestly (empty diff +
 * recorded error) when the model is unavailable - never throw, never fake a diff.
 */
import { authorDiff, extractDiff } from "../author";
import type { AICompleteRequest, AICompleteResponse } from "@/lib/ai/types";

const SAMPLE_DIFF = `diff --git a/src/lib/add.ts b/src/lib/add.ts
new file mode 100644
--- /dev/null
+++ b/src/lib/add.ts
@@ -0,0 +1,1 @@
+export const add = (a: number, b: number) => a + b;`;

function resp(content: string): AICompleteResponse {
  return { content, model_used: "azure-gpt-4o", provider_used: "azure-openai", input_tokens: 50, output_tokens: 80, cost_usd: 0.0007, latency_ms: 900 };
}

describe("extractDiff", () => {
  it("pulls a diff out of a ```diff fence", () => {
    expect(extractDiff("here you go\n```diff\n" + SAMPLE_DIFF + "\n```\ndone")).toBe(SAMPLE_DIFF);
  });
  it("accepts a raw diff with no fence", () => {
    expect(extractDiff(SAMPLE_DIFF)).toBe(SAMPLE_DIFF);
  });
  it("returns empty when the reply is not diff-shaped", () => {
    expect(extractDiff("I think you should add a function called add.")).toBe("");
    expect(extractDiff("")).toBe("");
  });
});

describe("authorDiff", () => {
  it("authors a diff and records executor evidence (model becomes the author)", async () => {
    const deps = { complete: async (_r: AICompleteRequest) => resp("```diff\n" + SAMPLE_DIFF + "\n```") };
    const out = await authorDiff({ prompt: "add an add() function with a test", executorProviderPin: "azure-openai" }, deps);
    expect(out.diff).toContain("export const add");
    expect(out.author).toBe("azure-gpt-4o"); // model id anchors the lineage for repair
    expect(out.provider).toBe("azure-openai");
    expect(out.costUsd).toBeGreaterThan(0);
    expect(out.error).toBeNull();
  });

  it("pins the executor provider when asked", async () => {
    const seen: AICompleteRequest[] = [];
    const deps = { complete: async (r: AICompleteRequest) => { seen.push(r); return resp("```diff\n" + SAMPLE_DIFF + "\n```"); } };
    await authorDiff({ prompt: "x", executorProviderPin: "azure-openai" }, deps);
    expect(seen[0].provider_pin).toBe("azure-openai");
    expect(seen[0].system).toMatch(/unified diff/i);
  });

  it("degrades honestly when the executor is unavailable (empty diff + recorded error, no throw)", async () => {
    const deps = { complete: async (_r: AICompleteRequest) => { throw new Error("NoProviderAvailableError: azure not configured"); } };
    const out = await authorDiff({ prompt: "x", executorProviderPin: "azure-openai" }, deps);
    expect(out.diff).toBe("");
    expect(out.error).toMatch(/not configured/);
    expect(out.author).toBe("azure-openai"); // falls back to the pin, still a usable lineage anchor
  });

  it("returns an empty diff (not a fake one) when the model answers with prose", async () => {
    const deps = { complete: async (_r: AICompleteRequest) => resp("Sure, you could add a function.") };
    const out = await authorDiff({ prompt: "x" }, deps);
    expect(out.diff).toBe("");
    expect(out.error).toBeNull();
  });
});
