/**
 * Tests for the secrets-management wrapper.
 *
 * Covers:
 *   - env-backend: missing var, present var, kebab → SCREAMING_SNAKE
 *     normalization (3 explicit mappings)
 *   - Azure Key Vault stub: no-op when AZURE_KEYVAULT_URL unset, throws
 *     NotImplementedError when set (forces real adapter ship)
 *   - getSecret cache hit/miss
 *   - getSecretOrThrow throws with clear message
 *   - clearCache works
 *   - resolution log records which backend served the value
 */

import { EnvBackend, normalizeSecretNameToEnvVar } from "@/lib/secrets/env-backend";
import { AzureKeyVaultBackend } from "@/lib/secrets/azure-keyvault-backend";
import { NotImplementedError } from "@/lib/secrets/types";
import {
  _resetClientForTests,
  cacheSecret,
  clearCache,
  getResolutionLog,
  getSecret,
  getSecretOrThrow,
} from "@/lib/secrets";

const ENV_KEYS_TO_SCRUB = [
  "ANTHROPIC_API_KEY",
  "MS_CLIENT_ID",
  "MS_CLIENT_SECRET",
  "CRON_SECRET",
  "AZURE_KEYVAULT_URL",
  "FOO_BAR_BAZ",
];

beforeEach(() => {
  for (const k of ENV_KEYS_TO_SCRUB) delete process.env[k];
  clearCache();
  _resetClientForTests();
  jest.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("EnvBackend", () => {
  it("returns null when env var is unset", async () => {
    const backend = new EnvBackend();
    const value = await backend.get("anthropic-api-key");
    expect(value).toBeNull();
  });

  it("returns the value when env var is present", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-123";
    const backend = new EnvBackend();
    const value = await backend.get("anthropic-api-key");
    expect(value).toBe("sk-test-123");
  });

  it("normalizes secret names → env var names correctly", () => {
    expect(normalizeSecretNameToEnvVar("support-cron-secret")).toBe("CRON_SECRET");
    expect(normalizeSecretNameToEnvVar("anthropic-api-key")).toBe("ANTHROPIC_API_KEY");
    expect(normalizeSecretNameToEnvVar("microsoft-client-id")).toBe("MS_CLIENT_ID");
    expect(normalizeSecretNameToEnvVar("foo-bar-baz")).toBe("FOO_BAR_BAZ");
  });
});

describe("AzureKeyVaultBackend (stub)", () => {
  it("no-ops (returns null) when AZURE_KEYVAULT_URL is unset", async () => {
    const backend = new AzureKeyVaultBackend();
    const value = await backend.get("anything");
    expect(value).toBeNull();
  });

  it("throws NotImplementedError when AZURE_KEYVAULT_URL is set", async () => {
    process.env.AZURE_KEYVAULT_URL = "https://my-vault.vault.azure.net/";
    const backend = new AzureKeyVaultBackend();
    await expect(backend.get("anything")).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe("getSecret / cache", () => {
  it("returns the env value on first call and caches subsequent calls", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-cache-1";
    const first = await getSecret("anthropic-api-key");
    expect(first).toBe("sk-cache-1");

    process.env.ANTHROPIC_API_KEY = "sk-changed";
    const second = await getSecret("anthropic-api-key");
    expect(second).toBe("sk-cache-1");
  });

  it("clearCache forces a fresh read", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-original";
    await getSecret("anthropic-api-key");

    process.env.ANTHROPIC_API_KEY = "sk-rotated";
    clearCache();
    const refreshed = await getSecret("anthropic-api-key");
    expect(refreshed).toBe("sk-rotated");
  });

  it("cacheSecret stores a value without hitting any backend", async () => {
    cacheSecret("anthropic-api-key", "preset-value");
    const value = await getSecret("anthropic-api-key");
    expect(value).toBe("preset-value");
  });

  it("records which backend resolved a secret", async () => {
    process.env.MS_CLIENT_ID = "client-abc";
    await getSecret("microsoft-client-id");
    expect(getResolutionLog()["microsoft-client-id"]).toBe("env");
  });
});

describe("getSecretOrThrow", () => {
  it("returns the value when present", async () => {
    process.env.MS_CLIENT_SECRET = "shh";
    const value = await getSecretOrThrow("microsoft-client-secret");
    expect(value).toBe("shh");
  });

  it("throws with a clear message when nothing found", async () => {
    await expect(getSecretOrThrow("anthropic-api-key")).rejects.toThrow(
      /not found in any backend/,
    );
  });
});
