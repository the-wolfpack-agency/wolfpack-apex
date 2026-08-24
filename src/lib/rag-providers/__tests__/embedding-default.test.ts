/**
 * The default embedding provider must follow what the deployment has.
 *
 * It returned "openai" unconditionally, and the factory threw a TODO for both
 * branches, so Instinct (which runs on Azure and holds no OpenAI key) never
 * embedded anything. Measured 2026-08-24: 2,305 chunks at embedded=false, and
 * 252 brain queries over 30 days with zero semantic hits.
 */
import { getProviderConfig } from "../config";

const AZURE = {
  AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
  AZURE_OPENAI_API_KEY: "k",
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: "text-embedding-3-small",
};

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function withEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("choosing an embedding provider", () => {
  it("picks azure when azure is what is configured", () => {
    withEnv({ ...AZURE, INSTINCT_EMBEDDING_PROVIDER: undefined });
    expect(getProviderConfig().embedding).toBe("azure_openai");
  });

  it("still picks openai when no azure embedding deployment exists", () => {
    withEnv({
      INSTINCT_EMBEDDING_PROVIDER: undefined,
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      AZURE_OPENAI_API_KEY: "k",
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: undefined,
    });
    expect(getProviderConfig().embedding).toBe("openai");
  });

  it("an explicit choice still wins over what is configured", () => {
    withEnv({ ...AZURE, INSTINCT_EMBEDDING_PROVIDER: "openai" });
    expect(getProviderConfig().embedding).toBe("openai");
  });

  it("choosing azure without its variables still throws, with no silent fallback", () => {
    withEnv({
      INSTINCT_EMBEDDING_PROVIDER: "azure_openai",
      AZURE_OPENAI_ENDPOINT: undefined,
      AZURE_OPENAI_API_KEY: undefined,
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: undefined,
    });
    expect(() => getProviderConfig()).toThrow(/AZURE_OPENAI_ENDPOINT/);
  });
});
