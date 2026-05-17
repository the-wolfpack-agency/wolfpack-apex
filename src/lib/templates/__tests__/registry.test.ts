const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import {
  listIntegrationTemplates,
  getIntegrationTemplate,
  updateTemplateSchemaHash,
} from "@/lib/templates/registry";

const ROW = {
  id: "tpl-1",
  template_id: "calendar_widget",
  surface: "widget",
  vendor: "microsoft",
  object_type: "event",
  use_cases: '["See the month at a glance"]',
  last_known_schema_hash: "hash-A",
  fallback_field_set: '[]',
  notes: "Mini month grid",
  is_active: true,
  created_at: "2026-05-17T10:00:00Z",
  updated_at: "2026-05-17T10:00:00Z",
};

beforeEach(() => {
  mockSafeQuery.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});

describe("listIntegrationTemplates", () => {
  test("returns parsed rows with use_cases as string[]", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [ROW] });
    const r = await listIntegrationTemplates();
    expect(r).toHaveLength(1);
    expect(r[0].templateId).toBe("calendar_widget");
    expect(r[0].vendor).toBe("microsoft");
    expect(r[0].useCases).toEqual(["See the month at a glance"]);
    expect(r[0].isActive).toBe(true);
  });

  test("activeOnly filter adds is_active=true predicate by default", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await listIntegrationTemplates();
    const [sql] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/is_active = TRUE/);
  });

  test("activeOnly=false drops the predicate", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await listIntegrationTemplates({ activeOnly: false });
    const [sql] = mockSafeQuery.mock.calls[0];
    expect(sql).not.toMatch(/is_active = TRUE/);
  });

  test("vendor + surface filters parameterize the query", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    await listIntegrationTemplates({ vendor: "salesforce", surface: "form" });
    const [, params] = mockSafeQuery.mock.calls[0];
    expect(params).toEqual(["salesforce", "form"]);
  });

  test("returns [] when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    const r = await listIntegrationTemplates();
    expect(r).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("returns [] on DB error", async () => {
    mockSafeQuery.mockRejectedValue(new Error("down"));
    const r = await listIntegrationTemplates();
    expect(r).toEqual([]);
  });
});

describe("getIntegrationTemplate", () => {
  test("returns single template by template_id", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [ROW] });
    const t = await getIntegrationTemplate("calendar_widget");
    expect(t?.templateId).toBe("calendar_widget");
  });

  test("returns null when not found", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await getIntegrationTemplate("ghost")).toBeNull();
  });
});

describe("updateTemplateSchemaHash", () => {
  test("UPDATE returning template_id → true on hit", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [{ template_id: "calendar_widget" }] });
    expect(await updateTemplateSchemaHash("calendar_widget", "hash-B")).toBe(true);
  });

  test("returns false when template not found", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await updateTemplateSchemaHash("ghost", "hash-X")).toBe(false);
  });

  test("returns false on DB error", async () => {
    mockSafeQuery.mockRejectedValue(new Error("down"));
    expect(await updateTemplateSchemaHash("calendar_widget", "h")).toBe(false);
  });
});
