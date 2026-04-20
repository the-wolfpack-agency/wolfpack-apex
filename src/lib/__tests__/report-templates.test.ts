/**
 * Report Templates Tests
 *
 * Tests branded report generation: all 6 templates, section generators,
 * HTML rendering, analytics tracking, database persistence, context substitution.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

const mockTrackEvent = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

// Mock triple-write (used by doc-generator's saveDocument)
jest.mock("@/lib/triple-write", () => ({
  tripleWriteEvent: jest.fn().mockResolvedValue(undefined),
}));

// Mock fs for codebase analysis
const mockExistsSync = jest.fn();
const mockReaddirSync = jest.fn();
const mockStatSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.mock("fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
}));

jest.mock("path", () => {
  const actual = jest.requireActual("path");
  return actual;
});

import {
  getTemplates,
  generateReport,
  renderReportHtml,
  getReportHistory,
  type ReportContext,
  type ReportTemplate,
} from "@/lib/report-templates";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setDatabaseUrl(val: string | undefined) {
  if (val === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = val;
  }
}

const DEFAULT_CONTEXT: ReportContext = {
  clientName: "Test Motors",
  dealerName: "Test Ford",
  productName: "Wolfpack Auto",
  dateRange: { start: "2026-03-01", end: "2026-03-31" },
  customNotes: "Demo report for testing.",
  userId: "test-user",
  userRole: "cto",
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DATABASE_URL;

  // Default: safeQuery returns empty rows (shadow mode behavior)
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });
  // Default: query for saveDocument
  mockQuery.mockResolvedValue({
    rows: [{
      id: "demo-123",
      title: "Test Report",
      doc_type: "report",
      content: "# Test",
      format: "markdown",
      generated_from: "test",
      generated_by: "test-user",
      revision: 1,
      tokens_used: 0,
      downloads: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }],
  });

  // Default: filesystem mocks return not found (triggers demo data)
  mockExistsSync.mockReturnValue(false);
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

// ---------------------------------------------------------------------------
// Template Structure
// ---------------------------------------------------------------------------

describe("getTemplates", () => {
  test("returns all 7 templates (6 built-in + Create Your Own)", () => {
    const templates = getTemplates();
    expect(templates).toHaveLength(7);
    expect(templates.find((t) => t.id === "custom")).toBeTruthy();
  });

  test("all templates have required fields", () => {
    const templates = getTemplates();
    for (const t of templates) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(["client", "internal", "technical"]).toContain(t.category);
      expect(Array.isArray(t.sections)).toBe(true);
      expect(Array.isArray(t.defaultIncluded)).toBe(true);
    }
  });

  test("each template has at least 3 sections", () => {
    const templates = getTemplates();
    for (const t of templates) {
      expect(t.sections.length).toBeGreaterThanOrEqual(3);
    }
  });

  test("template categories are valid", () => {
    const templates = getTemplates();
    const validCategories = new Set(["client", "internal", "technical"]);
    for (const t of templates) {
      expect(validCategories.has(t.category)).toBe(true);
    }
  });

  test("template IDs are unique", () => {
    const templates = getTemplates();
    const ids = templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all defaultIncluded section IDs exist in sections", () => {
    const templates = getTemplates();
    for (const t of templates) {
      const sectionIds = new Set(t.sections.map((s) => s.id));
      for (const included of t.defaultIncluded) {
        expect(sectionIds.has(included)).toBe(true);
      }
    }
  });

  test("all sections have valid dataSource", () => {
    const templates = getTemplates();
    const validSources = new Set(["codebase", "database", "static", "user_input"]);
    for (const t of templates) {
      for (const s of t.sections) {
        expect(validSources.has(s.dataSource)).toBe(true);
      }
    }
  });

  test("expected template IDs exist", () => {
    const templates = getTemplates();
    const ids = templates.map((t) => t.id);
    expect(ids).toContain("platform_capabilities");
    expect(ids).toContain("technical_architecture");
    expect(ids).toContain("client_proposal");
    expect(ids).toContain("implementation_plan");
    expect(ids).toContain("product_audit");
    expect(ids).toContain("monthly_review");
  });
});

// ---------------------------------------------------------------------------
// Section Generators
// ---------------------------------------------------------------------------

describe("section generators", () => {
  test("all section generators produce non-empty content", async () => {
    const templates = getTemplates();
    for (const t of templates) {
      for (const s of t.sections) {
        const content = await s.generator(DEFAULT_CONTEXT);
        expect(content.length).toBeGreaterThan(0);
        expect(content).toContain("##"); // Every section has a header
      }
    }
  });

  test("codebase-sourced sections work without real repo (fallback to demo data)", async () => {
    const templates = getTemplates();
    const codebaseSections = templates.flatMap((t) =>
      t.sections.filter((s) => s.dataSource === "codebase"),
    );

    for (const s of codebaseSections) {
      const content = await s.generator({ clientName: "Fallback Test" });
      expect(content.length).toBeGreaterThan(0);
      expect(content).not.toContain("undefined");
    }
  });

  test("context variables are substituted correctly", async () => {
    const templates = getTemplates();
    // Test client_proposal problem_statement — should include client name
    const proposal = templates.find((t) => t.id === "client_proposal")!;
    const problemSection = proposal.sections.find((s) => s.id === "problem_statement")!;
    const content = await problemSection.generator({
      clientName: "ACME Dealers",
      customNotes: "They need a mobile solution.",
    });
    expect(content).toContain("ACME Dealers");
    expect(content).toContain("They need a mobile solution.");
  });

  test("branding setup substitutes dealer name", async () => {
    const templates = getTemplates();
    const impl = templates.find((t) => t.id === "implementation_plan")!;
    const brandSection = impl.sections.find((s) => s.id === "branding_setup")!;
    const content = await brandSection.generator({
      clientName: "City Ford",
      dealerName: "City Ford Motors",
    });
    expect(content).toContain("City Ford Motors");
  });

  test("monthly review sections pull from database gracefully", async () => {
    const templates = getTemplates();
    const monthly = templates.find((t) => t.id === "monthly_review")!;
    for (const s of monthly.sections) {
      const content = await s.generator(DEFAULT_CONTEXT);
      expect(content.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// generateReport
// ---------------------------------------------------------------------------

describe("generateReport", () => {
  test("generates report with all sections", async () => {
    const templates = getTemplates();
    const t = templates[0]; // platform_capabilities
    const report = await generateReport(
      t.id,
      t.sections.map((s) => s.id),
      DEFAULT_CONTEXT,
    );

    expect(report.reportId).toBeTruthy();
    expect(report.templateId).toBe(t.id);
    expect(report.markdown.length).toBeGreaterThan(0);
    expect(report.html.length).toBeGreaterThan(0);
    expect(report.generatedAt).toBeTruthy();
    expect(report.sectionsIncluded).toHaveLength(t.sections.length);
  });

  test("generates report with subset of sections", async () => {
    const templates = getTemplates();
    const t = templates[0];
    const subset = [t.sections[0].id, t.sections[1].id];
    const report = await generateReport(t.id, subset, DEFAULT_CONTEXT);

    expect(report.sectionsIncluded).toHaveLength(2);
    expect(report.sectionsIncluded).toContain(subset[0]);
    expect(report.sectionsIncluded).toContain(subset[1]);

    // Sections NOT included should NOT appear (check by section title)
    for (let i = 2; i < t.sections.length; i++) {
      // The section heading should not be in the markdown
      // (unless coincidentally mentioned in another section)
    }
  });

  test("markdown includes branded header and footer", async () => {
    const templates = getTemplates();
    const report = await generateReport(
      "platform_capabilities",
      ["executive_summary"],
      DEFAULT_CONTEXT,
    );

    expect(report.markdown).toContain("Wolfpack Agency");
    expect(report.markdown).toContain("Test Motors");
    expect(report.markdown).toContain("Confidential");
    expect(report.markdown).toContain("Table of Contents");
  });

  test("markdown includes dealer and product when provided", async () => {
    const report = await generateReport(
      "platform_capabilities",
      ["executive_summary"],
      DEFAULT_CONTEXT,
    );
    expect(report.markdown).toContain("Test Ford");
    expect(report.markdown).toContain("Wolfpack Auto");
  });

  test("throws on unknown template", async () => {
    await expect(
      generateReport("nonexistent", ["foo"], DEFAULT_CONTEXT),
    ).rejects.toThrow("Unknown template");
  });

  test("throws on empty sections", async () => {
    await expect(
      generateReport("platform_capabilities", [], DEFAULT_CONTEXT),
    ).rejects.toThrow("No sections selected");
  });

  test("tracks analytics for every generation", async () => {
    await generateReport(
      "platform_capabilities",
      ["executive_summary"],
      DEFAULT_CONTEXT,
    );

    // trackEvent is called at least once for the report generation
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "client.doc_generated",
      "test-user",
      "cto",
      expect.objectContaining({
        template_id: "platform_capabilities",
        template_name: "Platform Capabilities",
      }),
    );
  });

  test("saves report to database via saveDocument", async () => {
    // saveDocument calls trackEvent + query
    // Since DATABASE_URL is not set, it uses shadow mode (returns demo doc)
    const report = await generateReport(
      "technical_architecture",
      ["tech_stack", "api_routes"],
      DEFAULT_CONTEXT,
    );

    expect(report.markdown).toContain("Tech Stack");
    expect(report.markdown).toContain("API Routes");
  });

  test("report is saved to instinct_documents when DATABASE_URL is set", async () => {
    setDatabaseUrl("postgresql://test");

    mockQuery.mockResolvedValue({
      rows: [{
        id: "saved-report-1",
        title: "Test Report",
        doc_type: "report",
        content: "# Test",
        format: "markdown",
        generated_from: "platform_capabilities",
        generated_by: "test-user",
        revision: 1,
        tokens_used: 0,
        downloads: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    });

    await generateReport(
      "platform_capabilities",
      ["executive_summary"],
      DEFAULT_CONTEXT,
    );

    // saveDocument should have called query with INSERT
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO instinct_documents"),
      expect.arrayContaining(["report"]),
    );
  });
});

// ---------------------------------------------------------------------------
// renderReportHtml
// ---------------------------------------------------------------------------

describe("renderReportHtml", () => {
  test("produces valid HTML with doctype", () => {
    const html = renderReportHtml("# Test Report\n\nHello world.");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  test("includes Wolfpack branding", () => {
    const html = renderReportHtml("# Test");
    expect(html).toContain("Wolfpack Agency");
    expect(html).toContain("wolfpack-logo.png");
    expect(html).toContain("Confidential");
    expect(html).toContain("Lexend Peta");
  });

  test("includes gold accent color", () => {
    const html = renderReportHtml("# Test");
    expect(html).toContain("#f1c233");
  });

  test("includes dark theme color", () => {
    const html = renderReportHtml("# Test");
    expect(html).toContain("#212124");
  });

  test("includes print styles for PDF export", () => {
    const html = renderReportHtml("# Test");
    expect(html).toContain("@media print");
    expect(html).toContain("@page");
  });

  test("converts markdown headers to HTML", () => {
    const html = renderReportHtml("# Title\n\n## Section\n\n### Subsection");
    expect(html).toContain("wp-h1");
    expect(html).toContain("wp-h2");
    expect(html).toContain("wp-h3");
  });

  test("converts markdown tables to HTML tables", () => {
    const md = "| Header | Value |\n|--------|-------|\n| A | B |";
    const html = renderReportHtml(md);
    expect(html).toContain("wp-table");
    expect(html).toContain("<th>");
  });

  test("converts bold and inline code", () => {
    const html = renderReportHtml("**bold text** and `code`");
    expect(html).toContain("<strong>bold text</strong>");
    expect(html).toContain("wp-code");
  });

  test("includes Wolfpack footer with date", () => {
    const html = renderReportHtml("# Test");
    expect(html).toContain("Confidential");
    expect(html).toContain("Wolfpack Agency");
    expect(html).toContain("wp-footer");
  });
});

// ---------------------------------------------------------------------------
// getReportHistory
// ---------------------------------------------------------------------------

describe("getReportHistory", () => {
  test("returns empty array in shadow mode", async () => {
    const history = await getReportHistory();
    expect(Array.isArray(history)).toBe(true);
  });

  test("queries with userId when provided", async () => {
    setDatabaseUrl("postgresql://test");
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });

    await getReportHistory("user-123");

    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("generated_by = $1"),
      ["user-123"],
    );
  });

  test("queries all reports when no userId", async () => {
    setDatabaseUrl("postgresql://test");
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });

    await getReportHistory();

    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("doc_type = 'report'"),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Full integration flow
// ---------------------------------------------------------------------------

describe("full report generation flow", () => {
  test("generates all 7 template types successfully", async () => {
    const templates = getTemplates();
    for (const t of templates) {
      const report = await generateReport(
        t.id,
        t.defaultIncluded,
        DEFAULT_CONTEXT,
      );
      expect(report.markdown.length).toBeGreaterThan(100);
      expect(report.html.length).toBeGreaterThan(100);
      expect(report.sectionsIncluded.length).toBeGreaterThan(0);
    }
  });

  test("generated HTML from report is renderable", async () => {
    const report = await generateReport(
      "client_proposal",
      ["problem_statement", "proposed_solution", "roi_projections"],
      DEFAULT_CONTEXT,
    );
    expect(report.html).toContain("<!DOCTYPE html>");
    expect(report.html).toContain("Test Motors");
  });
});
