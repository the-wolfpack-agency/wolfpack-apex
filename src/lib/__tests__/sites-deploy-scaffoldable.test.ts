/**
 * triggerDeploy refuses a brief the deploy target cannot build.
 *
 * The failure it replaces was real and slow: author a pricing section, watch it
 * render correctly in the studio preview, click Publish, and several minutes
 * later a GitHub workflow fails inside the scaffolder with a message nobody in
 * Instinct ever sees. Same outcome, one of them diagnosable.
 *
 * Asserting the refusal happens BEFORE the deploy row is written matters as
 * much as the refusal itself: a half-started deploy leaves the project sitting
 * at "Deploying…" until the reaper expires it.
 */
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: jest.fn(async () => ({ rows: [] })) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/github-client", () => ({
  createRepoFromTemplate: jest.fn(),
  deleteRepo: jest.fn(),
  enableActions: jest.fn(),
  putFile: jest.fn(),
  triggerWorkflow: jest.fn(),
  defaultGithubClient: jest.fn(() => ({})),
}));
jest.mock("@/lib/github-secrets", () => ({ setRepoSecret: jest.fn() }));

import { triggerDeploy } from "@/lib/sites";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { triggerWorkflow } from "@/lib/github-client";
import type { SectionType } from "@/lib/sites-schema";

/** getSiteProject reads through safeQuery; return a project with these sections. */
function projectWithSections(types: SectionType[]) {
  (safeQuery as jest.Mock).mockImplementation(async (sql: string) => {
    if (/SELECT \* FROM instinct_site_projects/i.test(sql)) {
      return {
        rows: [
          {
            id: "site_1",
            client_slug: "acme",
            display_name: "Acme",
            brief: { client: "acme", product: { name: "Acme" }, pages: [{ route: "/", sections: types.map((type) => ({ type })) }] },
            status: "ready",
            created_by: "u1",
            created_at: "",
            updated_at: "",
          },
        ],
      };
    }
    return { rows: [] };
  });
}

beforeEach(() => jest.clearAllMocks());

it("refuses a brief with a section the template cannot build, and names it", async () => {
  projectWithSections(["hero", "pricing", "faq"]);
  await expect(triggerDeploy("site_1", "u1", "cto")).rejects.toThrow(/pricing, faq/);
  await expect(triggerDeploy("site_1", "u1", "cto")).rejects.toThrow(/wolfpack-site-template/);
});

it("does not open a deploy row for a build it is going to refuse", async () => {
  projectWithSections(["pricing"]);
  await expect(triggerDeploy("site_1", "u1", "cto")).rejects.toThrow();
  // A pending row with no workflow behind it is what leaves the UI stuck at
  // "Deploying…" until the reaper expires it.
  const inserts = (safeQuery as jest.Mock).mock.calls.filter(([sql]) => /INSERT INTO instinct_site_deploys/i.test(sql));
  expect(inserts).toHaveLength(0);
  expect(triggerWorkflow).not.toHaveBeenCalled();
});

it("records the refusal for the learning loop, with the offending types", async () => {
  projectWithSections(["video"]);
  await expect(triggerDeploy("site_1", "u1", "cto")).rejects.toThrow();
  expect(trackEvent).toHaveBeenCalledWith(
    "site.deploy_failed",
    "u1",
    "cto",
    expect.objectContaining({ reason: "section_type_not_supported_by_template", unsupported: "video" }),
  );
});

it("lets a buildable brief through to the rest of the deploy path", async () => {
  // Proves the guard is specific rather than a blanket refusal. It gets past
  // the check and fails later on env preflight, which is a different message.
  projectWithSections(["hero", "text", "cards", "stats", "gallery", "quote", "callout", "banner"]);
  await expect(triggerDeploy("site_1", "u1", "cto")).rejects.not.toThrow(/cannot build yet/);
});
