/**
 * GitHub App per-client repo access.
 *
 * Public surface:
 *   - resolveGithubToken(workspaceId): the fallback-guaranteed token resolver.
 *   - mintInstallationToken(workspaceId): low-level installation-token mint.
 *   - linkInstallation / removeInstallation / getInstallation: storage helpers.
 *   - readAppConfigFromEnv / signAppJwt: App-JWT primitives.
 *
 * See token.ts for the fallback guarantee and jwt.ts for why the App JWT is
 * signed with node:crypto RS256 rather than the internal algorithm registry.
 */

export {
  resolveGithubToken,
  mintInstallationToken,
  __clearTokenCache,
  type ResolveDeps,
} from "./token";
export {
  linkInstallation,
  removeInstallation,
  getInstallation,
  type GithubInstallation,
  type LinkInstallationInput,
  type RemoveInstallationInput,
} from "./storage";
export {
  readAppConfigFromEnv,
  signAppJwt,
  type AppJwtConfig,
} from "./jwt";
