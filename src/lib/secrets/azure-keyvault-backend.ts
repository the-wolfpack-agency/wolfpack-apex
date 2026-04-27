import { NotImplementedError, type SecretBackend } from "./types";

/**
 * Azure Key Vault adapter STUB.
 *
 * No-op until AZURE_KEYVAULT_URL is set in the environment. Once Azure
 * Key Vault is provisioned (after the Azure card lands), implement get()
 * by:
 *
 *   TODO: import { SecretClient } from "@azure/keyvault-secrets"
 *   TODO: import { DefaultAzureCredential } from "@azure/identity"
 *   TODO: const client = new SecretClient(url, new DefaultAzureCredential())
 *   TODO: const result = await client.getSecret(secretName)
 *   TODO: return result.value ?? null
 *
 * Until then: if AZURE_KEYVAULT_URL is unset (today), return null so the
 * chain falls through to the env backend. If AZURE_KEYVAULT_URL IS set
 * but this stub is still in place, throw — that signals someone
 * provisioned the vault but forgot to ship the real adapter.
 */
export class AzureKeyVaultBackend implements SecretBackend {
  readonly name = "azure-keyvault";

  async get(_secretName: string): Promise<string | null> {
    const url = process.env.AZURE_KEYVAULT_URL;
    if (!url) return null;

    throw new NotImplementedError(
      "Azure Key Vault adapter stub. Implement when AZURE_KEYVAULT_URL + auth are configured.",
    );
  }
}
