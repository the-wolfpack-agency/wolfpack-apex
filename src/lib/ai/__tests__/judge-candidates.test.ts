/** @jest-environment node
 *
 * judgeCandidates must only offer providers that are actually usable. Anthropic
 * without a key is a valid LINEAGE but an unreachable provider, so offering it
 * lets chooseIndependentJudge pick it and then fail "could not be reached" -
 * which is exactly what hid a working DeepSeek behind an unconfigured Anthropic.
 */
import { buildRegistry, judgeCandidates } from "../router";

const OLD = process.env;
beforeEach(() => { process.env = { ...OLD }; });
afterAll(() => { process.env = OLD; });

test("excludes Anthropic when ANTHROPIC_API_KEY is not set", () => {
  delete process.env.ANTHROPIC_API_KEY;
  const cands = judgeCandidates(buildRegistry(), "cheap");
  expect(cands.some((c) => c.provider === "anthropic")).toBe(false);
});

test("includes Anthropic when ANTHROPIC_API_KEY is set", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  const cands = judgeCandidates(buildRegistry(), "cheap");
  expect(cands.some((c) => c.provider === "anthropic")).toBe(true);
});

test("includes a configured compatible provider (e.g. Foundry DeepSeek) as a candidate", () => {
  process.env.AI_COMPAT_PROVIDERS = "foundry";
  process.env.AI_COMPAT_FOUNDRY_BASE_URL = "https://x.services.ai.azure.com";
  process.env.AI_COMPAT_FOUNDRY_API_KEY = "k";
  process.env.AI_COMPAT_FOUNDRY_MODEL_CHEAP = "DeepSeek-V4-Flash";
  const cands = judgeCandidates(buildRegistry(), "cheap");
  const foundry = cands.find((c) => c.provider === "foundry");
  expect(foundry).toBeDefined();
  expect(foundry?.model).toBe("DeepSeek-V4-Flash");
});
