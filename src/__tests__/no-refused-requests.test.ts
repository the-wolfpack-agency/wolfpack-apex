/**
 * A component must not ask the server for what the viewer cannot have.
 *
 * THE PATTERN THIS CLOSES, found twice in two days by the per-role browser
 * sweep and once more the day after:
 *
 *   1. the dashboard's release-gate banner (admin endpoint, every load)
 *   2. the financials card (QuickBooks, every page it appeared on)
 *   3. the settings page and the financials page, the same endpoint again
 *
 * Every one of them handled the refusal correctly and rendered nothing, which
 * is exactly why they survived. The component discovers its own audience from
 * a 403, so it asks EVERYBODY, and most sessions produce a refused request.
 *
 * The cost is invisible until counted: a log full of expected refusals, and a
 * production assertion that no page fires a 401 or 403 which everybody learns
 * to ignore because it is permanently red. A guardrail that is always failing
 * protects nothing.
 *
 * So: a client file that calls a capability-gated endpoint must check first.
 * The check is one call, canI("..."), from lib/client-capabilities.
 *
 * Deliberately a narrow list rather than a clever scan. A test that tries to
 * infer every gated endpoint from the route tree would be wrong in both
 * directions and nobody would trust it. This names the endpoints known to be
 * gated, and grows when the sweep finds the next one.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();

/** Endpoints the server refuses without a capability, and the one to check. */
const GATED: Array<{ path: string; capability: string }> = [
  { path: "/api/quickbooks", capability: "finance.reports.view" },
  { path: "/api/admin/deployment/release-gate", capability: "settings.manage_team" },
];

/** Every client-side source file. */
function clientFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      clientFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = [
  ...clientFiles(join(ROOT, "src/components")),
  ...clientFiles(join(ROOT, "src/app")),
].filter((f) => {
  const text = readFileSync(f, "utf8");
  return text.includes('"use client"') || text.includes("'use client'");
});

describe("no client asks for what the viewer cannot have", () => {
  it("finds client files at all, so this is not vacuous", () => {
    expect(FILES.length).toBeGreaterThan(20);
  });

  it.each(GATED.map((g) => [g.path, g] as const))(
    "every caller of %s checks the capability first",
    (_path, gated) => {
      const offenders: string[] = [];

      for (const file of FILES) {
        const text = readFileSync(file, "utf8");
        /* Only files that actually call it. A mention in a comment or a route
           string in unrelated prose is not a request. */
        if (!text.includes(`fetchWithRefresh("${gated.path}`)) continue;
        /* The check can be the shared helper or an explicit capability read;
           what matters is that the decision is made before the request, not
           inferred from its refusal. */
        /* One way to do it, deliberately. Accepting a hand-rolled role read as
           well would let the next component invent a third spelling, and the
           whole reason this kept happening is that the right way was not the
           obvious one. */
        const guarded =
          text.includes(`canI("${gated.capability}")`) ||
          text.includes(`canIAll("${gated.capability}"`);
        if (!guarded) offenders.push(file.replace(ROOT + "/", ""));
      }

      expect({
        endpoint: gated.path,
        hint: `Call canI("${gated.capability}") from @/lib/client-capabilities before fetching, so this component does not ask on behalf of somebody who will be refused.`,
        offenders,
      }).toEqual(expect.objectContaining({ offenders: [] }));
    },
  );
});
