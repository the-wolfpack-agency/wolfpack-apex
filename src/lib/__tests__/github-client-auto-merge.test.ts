/** @jest-environment node */
/**
 * enableAutoMerge: the native-auto-merge effect. Must be fail-open (never throw in
 * the hot path) and only report enabled when the GraphQL mutation actually succeeds.
 */
import { enableAutoMerge } from "@/lib/github-client";

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => "", json: async () => body });

function client(fetchImpl: jest.Mock, token = "t") {
  return { token, fetch: fetchImpl } as unknown as Parameters<typeof enableAutoMerge>[0];
}

it("no token -> not enabled, never throws", async () => {
  const r = await enableAutoMerge(client(jest.fn(), ""), "o/r", 5);
  expect(r.enabled).toBe(false);
  expect(r.reason).toMatch(/token/i);
});

it("happy path: fetch node id, run the mutation, report enabled", async () => {
  const f = jest.fn()
    .mockResolvedValueOnce(ok({ node_id: "PR_node_123" }))      // GET /repos/.../pulls/5
    .mockResolvedValueOnce(ok({ data: { enablePullRequestAutoMerge: { clientMutationId: null } } })); // POST /graphql
  const r = await enableAutoMerge(client(f), "o/r", 5);
  expect(r.enabled).toBe(true);
  // the mutation call targeted the GraphQL endpoint with the node id
  const gqlCall = f.mock.calls.find((c) => String(c[0]).endsWith("/graphql"));
  expect(gqlCall).toBeTruthy();
  expect(String(gqlCall![1].body)).toContain("PR_node_123");
  expect(String(gqlCall![1].body)).toContain("enablePullRequestAutoMerge");
});

it("GraphQL errors -> not enabled (fail-open), surfaces the reason", async () => {
  const f = jest.fn()
    .mockResolvedValueOnce(ok({ node_id: "PR_x" }))
    .mockResolvedValueOnce(ok({ errors: [{ message: "Pull request is in clean status" }] }));
  const r = await enableAutoMerge(client(f), "o/r", 5);
  expect(r.enabled).toBe(false);
  expect(r.reason).toMatch(/clean status/);
});

it("a REST/network failure -> not enabled, never throws", async () => {
  const f = jest.fn().mockRejectedValue(new Error("boom"));
  const r = await enableAutoMerge(client(f), "o/r", 5);
  expect(r.enabled).toBe(false);
});

/**
 * approvePullRequest: the authorization half of the auto-merge tail. Submits an
 * APPROVE review as whatever identity the client holds; fail-open on the
 * self-approval 422 so the caller can try the next (distinct) identity.
 */
import { approvePullRequest } from "@/lib/github-client";

const err = (status: number, text: string) => ({ ok: false, status, text: async () => text, json: async () => ({}) });

describe("approvePullRequest", () => {
  it("no token -> not approved, never throws", async () => {
    const r = await approvePullRequest(client(jest.fn(), ""), "o/r", 7);
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/token/i);
  });

  it("happy path: POSTs an APPROVE review to the reviews endpoint", async () => {
    const f = jest.fn().mockResolvedValueOnce(ok({ id: 1, state: "APPROVED" }));
    const r = await approvePullRequest(client(f), "o/r", 7);
    expect(r.approved).toBe(true);
    const call = f.mock.calls[0];
    expect(String(call[0])).toContain("/repos/o/r/pulls/7/reviews");
    expect(String(call[1].method)).toBe("POST");
    expect(String(call[1].body)).toContain("APPROVE");
  });

  it("self-approval 422 -> not approved (fail-open), surfaces the reason so caller tries another identity", async () => {
    const f = jest.fn().mockResolvedValueOnce(err(422, "Can not approve your own pull request"));
    const r = await approvePullRequest(client(f), "o/r", 7);
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/own pull request/i);
  });

  it("a network failure -> not approved, never throws", async () => {
    const f = jest.fn().mockRejectedValue(new Error("boom"));
    const r = await approvePullRequest(client(f), "o/r", 7);
    expect(r.approved).toBe(false);
  });
});
