import { AzureKeyVaultBackend } from "./azure-keyvault-backend";
import { EnvBackend } from "./env-backend";
import { SecretsClient } from "./types";

export type { SecretBackend } from "./types";
export { SecretsClient, NotImplementedError } from "./types";

const DEFAULT_TTL_SECONDS = 5 * 60;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const resolutionLog = new Map<string, string>();

let client: SecretsClient | null = null;

function getClient(): SecretsClient {
  if (!client) {
    client = new SecretsClient([new AzureKeyVaultBackend(), new EnvBackend()]);
  }
  return client;
}

export function _resetClientForTests(): void {
  client = null;
  cache.clear();
  resolutionLog.clear();
}

export async function getSecret(name: string): Promise<string | null> {
  const cached = cache.get(name);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }
  if (cached) cache.delete(name);

  const { value, resolvedBy } = await getClient().get(name);
  if (value !== null) {
    cache.set(name, { value, expiresAt: Date.now() + DEFAULT_TTL_SECONDS * 1000 });
    if (resolvedBy && resolutionLog.get(name) !== resolvedBy) {
      resolutionLog.set(name, resolvedBy);
      console.info(`[secrets] resolved "${name}" via ${resolvedBy} backend`);
    }
  }
  return value;
}

export async function getSecretOrThrow(name: string): Promise<string> {
  const value = await getSecret(name);
  if (value === null) {
    throw new Error(
      `Secret "${name}" not found in any backend. Backends checked: ${getClient().listBackends().join(", ")}`,
    );
  }
  return value;
}

export function cacheSecret(name: string, value: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): void {
  cache.set(name, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function clearCache(): void {
  cache.clear();
}

export function getResolutionLog(): Record<string, string> {
  return Object.fromEntries(resolutionLog);
}
