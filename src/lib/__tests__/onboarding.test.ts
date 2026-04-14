/**
 * Onboarding library unit tests.
 *
 * Covers template CRUD, instance lifecycle (start, complete steps,
 * auto-complete, uncomplete, cancel), and insight generation.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

const mockSaveInsights = jest.fn();
jest.mock("@/lib/benefits", () => ({
  saveInsights: (...args: unknown[]) => mockSaveInsights(...args),
}));

import {
  DEFAULT_TEMPLATES,
  createTemplate,
  listTemplates,
  startOnboarding,
  completeStep,
  uncompleteStep,
  getOnboardingForEmployee,
  listActiveOnboardings,
  cancelOnboarding,
  checkStalledOnboardings,
  getInstance,
} from "@/lib/onboarding";

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  mockSaveInsights.mockResolvedValue(undefined);
});

/* ─────────────────── Template tests ─────────────────── */

describe("DEFAULT_TEMPLATES", () => {
  it("includes 3 built-in templates", () => {
    expect(DEFAULT_TEMPLATES).toHaveLength(3);
    expect(DEFAULT_TEMPLATES.map((t) => t.name)).toEqual([
      "Engineering Hire",
      "Sales Hire",
      "Operations Hire",
    ]);
  });

  it("each template has 6-8 steps with correct structure", () => {
    for (const t of DEFAULT_TEMPLATES) {
      expect(t.steps.length).toBeGreaterThanOrEqual(6);
      expect(t.steps.length).toBeLessThanOrEqual(8);
      for (const s of t.steps) {
        expect(s).toHaveProperty("step_id");
        expect(s).toHaveProperty("title");
        expect(s).toHaveProperty("description");
        expect(s).toHaveProperty("required");
        expect(s).toHaveProperty("category");
        expect(["paperwork", "access", "training", "equipment", "introductions"]).toContain(s.category);
        expect(s.completed).toBe(false);
        expect(s.completed_by).toBeNull();
        expect(s.completed_at).toBeNull();
      }
    }
  });
});

describe("createTemplate", () => {
  it("persists a custom template and emits event", async () => {
    const steps = [
      { step_id: "x1", title: "Step 1", description: "Do step 1", required: true, category: "paperwork" as const },
    ];
    const result = await createTemplate("Custom", steps, "user_1", "hr", "HR");
    expect(result.id).toMatch(/^obt_/);
    expect(result.name).toBe("Custom");
    expect(result.department).toBe("HR");
    expect(result.steps[0].completed).toBe(false);
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.onboarding_template_created",
      "user_1",
      "hr",
      expect.objectContaining({ template_name: "Custom", step_count: 1 }),
    );
  });
});

describe("listTemplates", () => {
  it("returns defaults + custom templates from DB", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "obt_custom_1",
          name: "Intern",
          department: null,
          steps: JSON.stringify([{ step_id: "i1", title: "Orientation", description: "", required: true, category: "training", completed: false, completed_by: null, completed_at: null }]),
          created_by: "u1",
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
      ],
      fromCache: false,
    });

    const templates = await listTemplates();
    // 3 defaults + 1 custom
    expect(templates).toHaveLength(4);
    expect(templates[3].name).toBe("Intern");
  });

  it("does not duplicate a default template that somehow got into DB", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ id: "obt_default_engineering", name: "Engineering Hire", department: "Engineering", steps: "[]", created_by: "system", created_at: "", updated_at: "" }],
      fromCache: false,
    });

    const templates = await listTemplates();
    expect(templates).toHaveLength(3); // only 3 defaults, no dupe
  });
});

/* ─────────────────── Instance lifecycle ─────────────────── */

describe("startOnboarding", () => {
  it("creates an instance from a default template", async () => {
    // listTemplates DB call returns empty (defaults will be used)
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    // INSERT instance
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    // UPDATE employee status
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    const inst = await startOnboarding("emp_1", "obt_default_engineering", "user_1", "hr");
    expect(inst.id).toMatch(/^ob_/);
    expect(inst.employee_id).toBe("emp_1");
    expect(inst.template_name).toBe("Engineering Hire");
    expect(inst.status).toBe("in_progress");
    expect(inst.steps).toHaveLength(8); // Engineering has 8 steps
    expect(inst.steps.every((s) => !s.completed)).toBe(true);

    // Should track event
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.onboarding_started",
      "user_1",
      "hr",
      expect.objectContaining({ employee_id: "emp_1", template_name: "Engineering Hire" }),
    );
  });

  it("throws if template not found", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    await expect(startOnboarding("emp_1", "obt_nonexistent", "u", "hr")).rejects.toThrow(
      "Template not found",
    );
  });
});

describe("completeStep", () => {
  const makeInstance = (overrides = {}) => ({
    id: "ob_1",
    employee_id: "emp_1",
    template_id: "obt_default_engineering",
    template_name: "Engineering Hire",
    status: "in_progress" as const,
    steps: [
      { step_id: "s1", title: "Step 1", description: "", required: true, category: "paperwork" as const, completed: false, completed_by: null, completed_at: null },
      { step_id: "s2", title: "Step 2", description: "", required: false, category: "access" as const, completed: false, completed_by: null, completed_at: null },
    ],
    started_at: "2026-04-01T00:00:00Z",
    completed_at: null,
    created_by: "user_1",
    ...overrides,
  });

  it("marks a step as completed", async () => {
    // getInstance query
    mockSafeQuery.mockResolvedValueOnce({ rows: [makeInstance()], fromCache: false });
    // UPDATE instance
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    const result = await completeStep("ob_1", "s1", "user_1", "hr");
    expect(result.steps[0].completed).toBe(true);
    expect(result.steps[0].completed_by).toBe("user_1");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.onboarding_step_completed",
      "user_1",
      "hr",
      expect.objectContaining({ step_id: "s1" }),
    );
  });

  it("auto-completes when all required steps are done", async () => {
    // Only s1 is required; s2 is optional. Complete s1 → auto-complete.
    mockSafeQuery.mockResolvedValueOnce({ rows: [makeInstance()], fromCache: false });
    // UPDATE instance
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    // UPDATE employee status to active
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    // SELECT employee name for insight
    mockSafeQuery.mockResolvedValueOnce({ rows: [{ full_name: "Jane Doe" }], fromCache: false });

    const result = await completeStep("ob_1", "s1", "user_1", "hr");
    expect(result.status).toBe("completed");
    expect(result.completed_at).not.toBeNull();

    // Should emit onboarding_completed
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.onboarding_completed",
      "user_1",
      "hr",
      expect.objectContaining({ instance_id: "ob_1" }),
    );

    // Should generate insight
    expect(mockSaveInsights).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          category: "onboarding",
          severity: "info",
          source_rule: "onboarding_completed",
        }),
      ]),
      "user_1",
      "hr",
    );
  });

  it("does not auto-complete if required steps remain", async () => {
    const inst = makeInstance({
      steps: [
        { step_id: "s1", title: "Step 1", description: "", required: true, category: "paperwork", completed: false, completed_by: null, completed_at: null },
        { step_id: "s2", title: "Step 2", description: "", required: true, category: "access", completed: false, completed_by: null, completed_at: null },
      ],
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [inst], fromCache: false });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    const result = await completeStep("ob_1", "s1", "user_1", "hr");
    expect(result.status).toBe("in_progress");
    expect(result.completed_at).toBeNull();
  });

  it("throws on cancelled instance", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [makeInstance({ status: "cancelled" })],
      fromCache: false,
    });
    await expect(completeStep("ob_1", "s1", "u", "hr")).rejects.toThrow("cancelled");
  });
});

describe("uncompleteStep", () => {
  it("uncompletes a step and reopens a completed instance", async () => {
    const inst = {
      id: "ob_1",
      employee_id: "emp_1",
      template_id: "obt_1",
      template_name: "Test",
      status: "completed" as const,
      steps: [
        { step_id: "s1", title: "Step 1", description: "", required: true, category: "paperwork" as const, completed: true, completed_by: "user_1", completed_at: "2026-04-05T00:00:00Z" },
      ],
      started_at: "2026-04-01T00:00:00Z",
      completed_at: "2026-04-05T00:00:00Z",
      created_by: "user_1",
    };

    // getInstance
    mockSafeQuery.mockResolvedValueOnce({ rows: [inst], fromCache: false });
    // UPDATE employee status to onboarding
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    // UPDATE instance
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    const result = await uncompleteStep("ob_1", "s1", "user_1", "hr");
    expect(result.steps[0].completed).toBe(false);
    expect(result.status).toBe("in_progress");
    expect(result.completed_at).toBeNull();

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.onboarding_step_uncompleted",
      "user_1",
      "hr",
      expect.objectContaining({ step_id: "s1", was_completed: true }),
    );
  });
});

describe("cancelOnboarding", () => {
  it("cancels an active instance and emits event", async () => {
    const inst = {
      id: "ob_1",
      employee_id: "emp_1",
      template_id: "obt_1",
      template_name: "Test",
      status: "in_progress" as const,
      steps: [],
      started_at: "2026-04-01T00:00:00Z",
      completed_at: null,
      created_by: "user_1",
    };

    mockSafeQuery.mockResolvedValueOnce({ rows: [inst], fromCache: false });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    const result = await cancelOnboarding("ob_1", "user_1", "hr");
    expect(result.status).toBe("cancelled");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.onboarding_cancelled",
      "user_1",
      "hr",
      expect.objectContaining({ instance_id: "ob_1" }),
    );
  });

  it("throws if already cancelled", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ id: "ob_1", status: "cancelled", steps: [] }],
      fromCache: false,
    });
    await expect(cancelOnboarding("ob_1", "u", "hr")).rejects.toThrow("Already cancelled");
  });
});

/* ─────────────────── Queries ─────────────────── */

describe("getOnboardingForEmployee", () => {
  it("returns instances for an employee", async () => {
    const rows = [
      { id: "ob_1", employee_id: "emp_1", status: "in_progress", steps: "[]", employee_name: "Jane" },
    ];
    mockSafeQuery.mockResolvedValueOnce({ rows, fromCache: false });

    const result = await getOnboardingForEmployee("emp_1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ob_1");
    expect(result[0].steps).toEqual([]);
  });
});

describe("listActiveOnboardings", () => {
  it("returns only in_progress instances", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ id: "ob_1", status: "in_progress", steps: "[]", employee_name: "Jane" }],
      fromCache: false,
    });

    const result = await listActiveOnboardings();
    expect(result).toHaveLength(1);
  });
});

describe("getInstance", () => {
  it("returns null when not found", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const result = await getInstance("ob_nonexistent");
    expect(result).toBeNull();
  });
});

/* ─────────────────── Stalled onboarding insights ─────────────────── */

describe("checkStalledOnboardings", () => {
  it("generates insight for onboardings older than threshold", async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "ob_stale",
          employee_id: "emp_1",
          status: "in_progress",
          steps: JSON.stringify([
            { step_id: "s1", title: "Step 1", completed: true },
            { step_id: "s2", title: "Step 2", completed: false },
          ]),
          started_at: thirtyDaysAgo,
          employee_name: "Slow Hire",
        },
      ],
      fromCache: false,
    });

    const insights = await checkStalledOnboardings("sys", "system", 14);
    expect(insights).toHaveLength(1);
    expect(insights[0].severity).toBe("attention");
    expect(insights[0].title).toContain("Slow Hire");
    expect(insights[0].source_rule).toBe("onboarding_stalled");
    expect(mockSaveInsights).toHaveBeenCalledTimes(1);
  });

  it("generates no insight for recent onboardings", async () => {
    const yesterday = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { id: "ob_new", employee_id: "emp_1", status: "in_progress", steps: "[]", started_at: yesterday, employee_name: "New Hire" },
      ],
      fromCache: false,
    });

    const insights = await checkStalledOnboardings("sys", "system");
    expect(insights).toHaveLength(0);
    expect(mockSaveInsights).not.toHaveBeenCalled();
  });
});
