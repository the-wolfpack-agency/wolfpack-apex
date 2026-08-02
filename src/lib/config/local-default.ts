/**
 * A convenience default for local development must not survive into production.
 *
 * THE INCIDENT THIS COMES FROM
 *
 * A Vercel usage alert on 2026-08-02 reported repeated ECONNREFUSED to
 * 127.0.0.1 for /dms/wolfpack-auto/inventory-search. The cause was a one-line
 * fallback that reads perfectly well in review:
 *
 *   const DMS_DRIVER_URL = process.env.DMS_DRIVER_URL ?? "http://127.0.0.1:7421";
 *
 * On a developer machine that is exactly right. In a serverless function
 * 127.0.0.1 is the function itself, so the tool dialled its own container,
 * failed with a network error, and reported that network error to the user.
 * "The DMS driver is unreachable" and "nobody has configured a DMS driver" are
 * completely different problems, and the operator was shown the first when the
 * truth was the second.
 *
 * WHY A HELPER AND NOT A FIX AT EACH SITE
 *
 * Five of these existed. Fixing one leaves the pattern available, and the next
 * one reads just as reasonably as this one did. Codifying it means the decision
 * is made once and every later call site inherits it.
 *
 * Pure, no I/O, so every rule is unit tested.
 */

/** Hosts that mean "this machine", which in a serverless function means "this
 *  container" and never what the author intended. */
const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;

export function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK.test(new URL(value).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/**
 * True when this process is running as a deployed application.
 *
 * Checked positively (a deployment marker is present) rather than negatively
 * (NODE_ENV is not development), because the negative form treats an unset
 * environment as production and would break every developer's machine the day
 * someone forgot to export NODE_ENV.
 */
export function isDeployed(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_REGION);
}

export type ResolvedEndpoint =
  | { configured: true; url: string }
  /** Not configured. Carries the variable name, because "unavailable" sends
   *  someone digging and the variable name is the fix. */
  | { configured: false; missingVar: string; reason: string };

/**
 * Resolve a service URL, refusing a loopback default in a deployed environment.
 *
 * The caller gets a typed "not configured" rather than a URL that is certain to
 * fail — matching the repo convention that an external integration returns a
 * typed error result instead of throwing or producing a misleading one.
 */
export function resolveServiceUrl(
  varName: string,
  localDefault: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedEndpoint {
  const configured = env[varName]?.trim();
  if (configured) return { configured: true, url: configured.replace(/\/+$/, "") };

  if (isDeployed(env) && isLoopbackUrl(localDefault)) {
    return {
      configured: false,
      missingVar: varName,
      reason: `${varName} is not set. The local default (${localDefault}) points at this machine, which in a deployed function is the function itself.`,
    };
  }

  // Not deployed: the local default is the whole point.
  return { configured: true, url: localDefault.replace(/\/+$/, "") };
}
