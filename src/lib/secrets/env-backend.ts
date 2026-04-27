import type { SecretBackend } from "./types";

/**
 * Override map for cases where the kebab-case canonical secret name does
 * NOT match the existing env var name in Vercel. New secrets should
 * follow the default normalization (kebab → SCREAMING_SNAKE) so this
 * map stays small.
 */
const ENV_VAR_OVERRIDES: Record<string, string> = {
  "support-cron-secret": "CRON_SECRET",
  "anthropic-api-key": "ANTHROPIC_API_KEY",
  "microsoft-client-id": "MS_CLIENT_ID",
  "microsoft-client-secret": "MS_CLIENT_SECRET",
  "microsoft-tenant-id": "MS_TENANT_ID",
  "microsoft-redirect-uri": "MS_REDIRECT_URI",
  "postgres-url": "POSTGRES_URL",
  "instinct-jwt-secret": "INSTINCT_JWT_SECRET",
};

export function normalizeSecretNameToEnvVar(secretName: string): string {
  if (ENV_VAR_OVERRIDES[secretName]) return ENV_VAR_OVERRIDES[secretName];
  return secretName.replace(/-/g, "_").toUpperCase();
}

export class EnvBackend implements SecretBackend {
  readonly name = "env";

  async get(secretName: string): Promise<string | null> {
    const envVarName = normalizeSecretNameToEnvVar(secretName);
    const value = process.env[envVarName];
    return value && value.length > 0 ? value : null;
  }
}
