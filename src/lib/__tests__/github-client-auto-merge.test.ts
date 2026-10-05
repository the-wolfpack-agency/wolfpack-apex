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
