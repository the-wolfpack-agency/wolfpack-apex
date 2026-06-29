/**
 * MCP scan orchestrator: aggregates findings, registers each server into the AI
 * Surface Inventory as kind "mcp_server" with risk = its worst finding, and rolls
 * up by severity/class. The inventory write is mocked.
 */

const mockUpsert = jest.fn();
jest.mock("../../store", () => {
  const actual = jest.requireActual("../../store");
  return { ...actual, upsertSurfaces: (...a: unknown[]) => mockUpsert(...a) };
});

import { runMcpScan } from "../scan";

beforeEach(() => {
  jest.resetAllMocks();
  mockUpsert.mockResolvedValue(2);
});

test("scans every server, registers mcp_server surfaces with worst-finding risk", async () => {
  const res = await runMcpScan({
    workspaceId: "w-1",
    target: "ws-config",
    servers: [
      { name: "risky", command: "npx", args: ["-y", "evil-mcp"], env: { K: "sk-ant-abcdefghijklmnopqrstuvwx0123" } },
      { name: "clean", command: "node", args: ["server.js"] },
    ],
    toolsByServer: { risky: [{ name: "exec", description: "runs things" }] },
  });

  expect(res.servers).toBe(2);
  // risky: unpinned(high) + secret(critical) + dangerous_capability(medium)
  expect(res.byClass.secret_in_config).toBe(1);
  expect(res.byClass.unpinned_server).toBe(1);
  expect(res.bySeverity.critical).toBe(1);

  // Two inventory surfaces written, risky one carries critical risk.
  const [, , surfaces] = mockUpsert.mock.calls[0];
  expect(surfaces).toHaveLength(2);
  const risky = surfaces.find((s: { location: string }) => s.location === "risky");
  expect(risky).toMatchObject({ kind: "mcp_server", provider: "mcp", risk: "critical", governed: false });
  expect(risky.evidence.findingCount).toBeGreaterThanOrEqual(2);
  // findings persist in the inventory row (JSONB) - no data lost.
  expect(typeof risky.evidence.findings).toBe("string");

  const clean = surfaces.find((s: { location: string }) => s.location === "clean");
  expect(clean).toMatchObject({ risk: "low" });
});

test("a fully clean config produces zero findings but still inventories the servers", async () => {
  const res = await runMcpScan({
    workspaceId: "w-1",
    target: "ws",
    servers: [{ name: "ok", command: "npx", args: ["-y", "ok-mcp@1.0.0"] }],
  });
  expect(res.findings).toEqual([]);
  const [, , surfaces] = mockUpsert.mock.calls[0];
  expect(surfaces).toHaveLength(1);
  expect(surfaces[0]).toMatchObject({ kind: "mcp_server", risk: "low" });
});
