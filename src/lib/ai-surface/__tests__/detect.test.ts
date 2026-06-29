/**
 * AI-surface detectors. Proves each detector finds the real signature, records
 * the right provider/kind/risk/location, masks keys (never leaks the secret), and
 * is PRECISION-FIRST: benign prose mentioning "ai" or "openai" in a comment with
 * no import/endpoint/key does NOT produce a false inventory entry.
 */
import { aiSdkUsage, providerEndpoint, aiApiKey, detectAiSurfaces } from "../detect";

const f = (content: string) => ({ path: "src/x.ts", content });

test("aiSdkUsage flags known SDK imports with provider + line", () => {
  const out = aiSdkUsage(f(`import OpenAI from "openai";\nimport Anthropic from "@anthropic-ai/sdk";`));
  const providers = out.map((s) => s.provider).sort();
  expect(providers).toEqual(["anthropic", "openai"]);
  expect(out[0]).toMatchObject({ kind: "ai_sdk", risk: "medium", governed: false, location: "src/x.ts:1" });
});

test("aiSdkUsage flags langchain / google / mistral / groq", () => {
  const out = aiSdkUsage(f(`require("@langchain/core");\nimport { x } from "@google/generative-ai";\nimport "@mistralai/mistralai";\nimport Groq from "groq-sdk";`));
  expect(out.map((s) => s.provider).sort()).toEqual(["google", "groq", "langchain", "mistral"]);
});

test("providerEndpoint flags hardcoded provider hosts", () => {
  const out = providerEndpoint(f(`const url = "https://api.openai.com/v1/chat";\nfetch("https://api.anthropic.com/v1/messages");\nconst az = "https://my-res.openai.azure.com/";`));
  expect(out.map((s) => s.provider).sort()).toEqual(["anthropic", "azure-openai", "openai"]);
  expect(out[0].kind).toBe("provider_endpoint");
});

test("aiApiKey flags provider key signatures as critical and MASKS the secret", () => {
  const out = aiApiKey(f(`const k = "sk-ant-abcdefghijklmnopqrstuvwx0123";\nconst o = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";`));
  expect(out.map((s) => s.provider).sort()).toEqual(["anthropic", "openai"]);
  expect(out.every((s) => s.risk === "critical")).toBe(true);
  // The raw key never appears in evidence — only a masked hint.
  const evidenceStr = JSON.stringify(out.map((s) => s.evidence));
  expect(evidenceStr).not.toContain("abcdefghijklmnopqrstuvwx");
  expect(out[0].evidence.hint).toMatch(/^sk-a….+/);
});

test("PRECISION: prose mentioning ai/openai with no import/endpoint/key is NOT flagged", () => {
  const out = detectAiSurfaces(f(`// We may add an OpenAI integration later for the ai assistant.\nconst note = "the gpt feature is planned";`));
  expect(out).toEqual([]);
});

test("each provider on a line is recorded once, not duplicated", () => {
  const out = aiSdkUsage(f(`import OpenAI, { OpenAI as O2 } from "openai";`));
  expect(out.filter((s) => s.provider === "openai")).toHaveLength(1);
});

test("detectAiSurfaces aggregates all detector kinds over a file", () => {
  const out = detectAiSurfaces(
    f(`import OpenAI from "openai";\nconst url = "https://api.anthropic.com";\nconst k = "sk-ant-abcdefghijklmnopqrstuvwx0123";`),
  );
  expect(out.map((s) => s.kind).sort()).toEqual(["ai_sdk", "api_key", "provider_endpoint"]);
});
