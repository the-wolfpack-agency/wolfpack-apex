/**
 * Secrets management abstraction.
 *
 * Backends are tried in order until one returns a non-null value. This
 * keeps a Key Vault adapter pluggable (for when AZURE_KEYVAULT_URL is
 * provisioned) while every read continues to work against the existing
 * Vercel env-var backend today.
 */

export interface SecretBackend {
  readonly name: string;
  get(secretName: string): Promise<string | null>;
}

export class SecretsClient {
  private backends: SecretBackend[];

  constructor(backends: SecretBackend[]) {
    this.backends = backends;
  }

  async get(secretName: string): Promise<{ value: string | null; resolvedBy: string | null }> {
    for (const backend of this.backends) {
      const value = await backend.get(secretName);
      if (value !== null && value !== undefined && value !== "") {
        return { value, resolvedBy: backend.name };
      }
    }
    return { value: null, resolvedBy: null };
  }

  listBackends(): string[] {
    return this.backends.map((b) => b.name);
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
