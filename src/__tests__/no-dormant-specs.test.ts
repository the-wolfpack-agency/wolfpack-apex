/**
 * No end-to-end spec may be dormant without saying so.
 *
 * WHY THIS EXISTS
 *
 * `tests/e2e/team-invite-flow.spec.ts` drives the real invite flow: a CTO
 * invites somebody, the invitee accepts and signs in. It asserts the accept
 * call returns 200. It would have caught the 2026-08-03 outage that turned a
 * client away, in the first CI run after the bug landed.
 *
 * It has never executed. It is gated on INVITE_SMOKE_TARGET_EMAIL, that secret
 * was never configured, and no workflow ever named the spec. So it skipped, and
 * a skipped Playwright test reports as a pass.
 *
 * A test that cannot run is worse than no test, because it reads as coverage.
 * This walks every spec, finds the env vars it gates itself on, and requires
 * each one to be either supplied by a workflow or listed below with a reason
 * and an owner. Adding a secret-gated spec and not wiring it now fails here.
 *
 * This does NOT require every spec to run in CI. Some genuinely need a target
 * that only a human can supply. It requires the dormancy to be deliberate,
 * written down, and visible, instead of discovered after a client is turned
 * away.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const E2E_DIR = join(__dirname, "..", "..", "tests", "e2e");
const WORKFLOW_DIR = join(__dirname, "..", "..", ".github", "workflows");

/**
 * Env vars a spec may gate on while never running in CI.
 *
 * Every entry needs a reason a person can act on. "Not set up yet" is not one:
 * that is the state this guardrail exists to surface.
 */
const KNOWN_DORMANT: Record<string, string> = {
  /* ACTION NEEDED. Both of these are critical auth flows that have never run.
     Each needs ONE repo secret: a disposable address at a domain we control.
     They are recorded here rather than deleted so the gap stays visible and
     costed, not so it can be ignored. Wire the secret, then DELETE the entry:
     the test above then requires a workflow to supply it. */
  INVITE_SMOKE_TARGET_EMAIL:
    "ACTION NEEDED. Gates tests/e2e/team-invite-flow.spec.ts, the spec that would have caught " +
    "the 2026-08-03 invite outage in the first CI run. Needs a disposable address, e.g. " +
    "invite-smoke@thewolfpack.agency, added as a repo secret. Note it creates a real member " +
    "row wherever it points, so it wants a preview/scratch database, not production.",
  ROSTER_SMOKE_TARGET_EMAIL:
    "ACTION NEEDED. Gates the access round-trip half of tests/e2e/hr-roster-access.spec.ts. " +
    "Mid-test the target account cannot sign in, so it needs a disposable account, not a real " +
    "teammate. The read-only half of that spec runs without it. Caught by this guardrail on " +
    "the very next PR after it was written, which is the point of it.",
  RESET_SMOKE_EMAIL:
    "ACTION NEEDED. Gates tests/e2e/password-reset-flow.spec.ts. Same shape of gap as the " +
    "invite flow: password reset is an auth path nobody has ever exercised end to end in CI.",

  // Destructive or human-targeted inputs that must not be invented by CI.
  E2E_ALLOW_DEPLOY: "Deliberate: this spec deploys a site. It must never fire unattended.",
  FIGMA_ACCESS_TOKEN: "Needs a Figma token tied to a person's account; no service account exists yet.",
  SITES_SMOKE_FIGMA_URL: "Needs a specific Figma file to import; supplied by hand when testing Sites import.",
  SITES_SMOKE_PREVIEW_URL: "Points at a one-off preview deploy; only meaningful during a Sites session.",
  SITES_SMOKE_PROJECT_ID: "Identifies a specific Sites project; supplied by hand.",
  TOOLS_HONESTY_MATRIX_LIVE: "Opt-in live sweep; the offline matrix runs in CI already.",

  // The platform-scan specs point at a customer's system, by definition per-run.
  TARGET_BASE_URL: "Names an external target to scan; chosen per engagement.",
  TARGET_ADMIN_EMAIL: "Credential for an external scan target.",
  TARGET_ADMIN_PASSWORD: "Credential for an external scan target.",
  TARGET_USERNAME: "Credential for an external scan target.",
  TARGET_PASSWORD: "Credential for an external scan target.",
  TARGET_LOGIN_PATH: "Login path of an external scan target.",
  TARGET_NAME: "Label for an external scan target.",
  TARGET_PLATFORM: "Platform of an external scan target.",

  INGEST_URL: "Points at a running ingest endpoint; the unit suite covers the contract.",
  INGEST_SECRET: "Paired with INGEST_URL.",
  INSTINCT_BASE_URL: "Alternate base URL for ad-hoc runs; PROD_URL is what CI uses.",
  INSTINCT_ADMIN_EMAIL: "Ad-hoc run credential; CI uses SMOKE_TEST_EMAIL.",
  INSTINCT_ADMIN_PASSWORD: "Ad-hoc run credential; CI uses SMOKE_TEST_PASSWORD.",
  INVITE_EMAIL: "Ad-hoc override; the wired flow uses INVITE_SMOKE_TARGET_EMAIL.",
};

function specFiles(): string[] {
  return readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts"));
}

/** Env vars a spec reads, which is how it decides whether to skip itself. */
function gatedEnvVars(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) found.add(m[1]);
  return [...found];
}

/** Everything the workflows supply, so a spec gated on it can actually run. */
function envSuppliedByWorkflows(): Set<string> {
  const supplied = new Set<string>();
  if (!existsSync(WORKFLOW_DIR)) return supplied;
  for (const f of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const src = readFileSync(join(WORKFLOW_DIR, f), "utf8");
    for (const m of src.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*:\s*\$\{\{/gm)) supplied.add(m[1]);
    for (const m of src.matchAll(/secrets\.([A-Z_][A-Z0-9_]*)/g)) supplied.add(m[1]);
  }
  return supplied;
}

/** Computed once: this jest build has no expect(value, message) form, so the
 *  guardrail throws Errors carrying the explanation instead. */
const supplied = envSuppliedByWorkflows();

describe("every e2e spec can run, or is knowingly dormant", () => {
  it("finds the workflows and the specs", () => {
    // If either walk silently returns nothing, this whole file asserts nothing,
    // which is the exact failure it exists to prevent.
    expect(specFiles().length).toBeGreaterThan(10);
    expect(supplied.size).toBeGreaterThan(3);
  });

  it.each(specFiles())("%s", (file) => {
    const vars = gatedEnvVars(readFileSync(join(E2E_DIR, file), "utf8"));
    const unexplained = vars.filter((v) => !supplied.has(v) && !(v in KNOWN_DORMANT));
    if (unexplained.length > 0) {
      throw new Error(
        `${file} gates itself on ${unexplained.join(", ")}, which no workflow supplies and ` +
          `KNOWN_DORMANT does not explain. As written this spec never runs, and a skipped ` +
          `Playwright test reports as a pass. Either supply it in a workflow, or add it to ` +
          `KNOWN_DORMANT with a reason somebody can act on.`,
      );
    }
    expect(unexplained).toEqual([]);
  });
});

describe("the invite flow specifically", () => {
  it("is wired to run, because it is the test that would have caught the outage", () => {
    /* Every new invitee saw "An account already exists for this email." and a
       client was turned away. This spec asserts the accept call returns 200. It
       existed the whole time and had never executed. */
    const spec = join(E2E_DIR, "team-invite-flow.spec.ts");
    expect(existsSync(spec)).toBe(true);
    const vars = gatedEnvVars(readFileSync(spec, "utf8")).filter((v) => !(v in KNOWN_DORMANT));
    const missing = vars.filter((v) => !supplied.has(v));
    if (missing.length > 0) {
      throw new Error(
        `team-invite-flow.spec.ts still cannot run: ${missing.join(", ")} is not supplied by any ` +
          `workflow. This is the spec that would have caught the invite outage.`,
      );
    }
    expect(missing).toEqual([]);
  });

  it("is named by a workflow once its secret exists, and is recorded until then", () => {
    /* Two states, both enforced, so this cannot be quietly satisfied:

       - secret wired  -> a workflow must actually invoke the spec. Supplying a
                          secret nobody runs is the same dormancy in a new coat.
       - not yet wired -> the KNOWN_DORMANT entry must still be there and still
                          say ACTION NEEDED, so deleting the note to silence the
                          guardrail fails instead of passing. */
    const wired = supplied.has("INVITE_SMOKE_TARGET_EMAIL");
    if (wired) {
      const invoked = readdirSync(WORKFLOW_DIR)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => readFileSync(join(WORKFLOW_DIR, f), "utf8"))
        .some((src) => /team-invite-flow|npm run canary|test:e2e:prod|playwright test tests\/e2e\/?(\s|$|--)/m.test(src));
      if (!invoked) {
        throw new Error(
          "INVITE_SMOKE_TARGET_EMAIL is now supplied, but no workflow invokes " +
            "team-invite-flow.spec.ts. Add it to a workflow, or the secret changes nothing.",
        );
      }
      expect(invoked).toBe(true);
      return;
    }
    const note = KNOWN_DORMANT.INVITE_SMOKE_TARGET_EMAIL;
    if (!note || !note.includes("ACTION NEEDED")) {
      throw new Error(
        "team-invite-flow.spec.ts is still dormant and its ACTION NEEDED note is gone. " +
          "Removing the note does not wire the test; it only hides that the spec which would " +
          "have caught the invite outage still never runs.",
      );
    }
    expect(note).toContain("ACTION NEEDED");
  });

  it("reports how much of the e2e suite any workflow actually invokes", () => {
    /* Not a threshold, a number. Of the specs in tests/e2e, only the handful
       named by a workflow ever execute; the rest are files that look like
       coverage. Printing it each run keeps that honest. */
    const workflows = readdirSync(WORKFLOW_DIR)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => readFileSync(join(WORKFLOW_DIR, f), "utf8"))
      .join("\n");
    const all = specFiles();
    const runsWholeSuite = /npm run canary|test:e2e:prod|playwright test tests\/e2e\/?(\s|$|--)/m.test(workflows);
    const named = all.filter((f) => workflows.includes(f));
    // eslint-disable-next-line no-console
    console.log(
      runsWholeSuite
        ? `[e2e coverage] a workflow runs the whole suite (${all.length} specs)`
        : `[e2e coverage] ${named.length} of ${all.length} e2e specs are named by a workflow: ` +
            named.join(", "),
    );
    expect(all.length).toBeGreaterThan(0);
  });
});
