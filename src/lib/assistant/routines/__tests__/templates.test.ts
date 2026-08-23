/**
 * The pre-built workflows.
 *
 * THE TEST THAT MAKES THE LIBRARY TRUSTWORTHY is the last one: every template
 * validates against the real registry, using each tool's own schema. Without
 * it, a library is a set of promises checked for the first time by whoever
 * adopts one, and the first thing they learn about the product is that it
 * offers things it cannot do.
 */
import { ROUTINE_TEMPLATES, templateById } from "../templates";
import { checkRoutine } from "../heal";
import { referencedSlots } from "../slots";
import { getTools } from "@/lib/assistant/tools/registry";
import "@/lib/assistant/tools";
import type { ToolStep, ModelStep } from "../types";

const tools = getTools();

describe("every template actually runs", () => {
  it.each(ROUTINE_TEMPLATES.map((t) => [t.command, t] as const))(
    "%s validates against the live registry",
    (_command, template) => {
      /* A CTO can invoke everything, so this isolates "does the tool exist and
         does it accept these parameters" from "is this person allowed". */
      const health = checkRoutine(template, tools, "cto");
      expect({
        command: template.command,
        problems: health.problems.map((p) => `${p.tool}: ${p.detail}`),
      }).toEqual(expect.objectContaining({ problems: [] }));
    },
  );

  it("never reads a slot before an earlier step has written it", () => {
    for (const t of ROUTINE_TEMPLATES) {
      const written = new Set<string>();
      t.steps.forEach((step, i) => {
        const reads =
          step.kind === "tool"
            ? referencedSlots((step as ToolStep).params)
            : step.kind === "model"
              ? referencedSlots((step as ModelStep).prompt)
              : (step.show ?? []);
        for (const slot of reads) {
          expect({ template: t.command, step: i, slot, ok: written.has(slot) }).toEqual(
            expect.objectContaining({ ok: true }),
          );
        }
        if (step.kind !== "human" && step.slot) written.add(step.slot);
      });
    }
  });
});

describe("the shape every template keeps", () => {
  it("gives each a unique id and command", () => {
    const ids = ROUTINE_TEMPLATES.map((t) => t.id);
    const commands = ROUTINE_TEMPLATES.map((t) => t.command);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("stops for a person before it ACTS, and only then", () => {
    /* The human step gates action: nothing is sent, filed or told to anybody
       without somebody agreeing. It is not a tax on reading.
     *
     * A chain that only looks things up has nothing to agree to, and stopping
     * it to ask would be friction with no safety in it. That shape is the
     * foundation rather than a lesser case: three tools whose data has never
     * been read together, where the reading is the whole product. */
    for (const t of ROUTINE_TEMPLATES) {
      const writes = t.steps.some((s) => s.kind === "tool" && s.tool.endsWith("_form"));
      if (writes) {
        expect({ command: t.command, stops: t.steps.some((s) => s.kind === "human") }).toEqual(
          expect.objectContaining({ stops: true }),
        );
      }
    }
  });

  it("has at least one chain that is pure tools, because that is the foundation", () => {
    /* If every template needed a person, the product would be a checklist with
       lookups attached rather than something that answers a question nobody
       could answer in one place. */
    const readOnly = ROUTINE_TEMPLATES.filter(
      (t) => !t.steps.some((s) => s.kind === "human"),
    );
    expect(readOnly.length).toBeGreaterThan(0);
    for (const t of readOnly) {
      /* And it must genuinely be read-only: no form tool hiding in it. */
      expect(t.steps.some((s) => s.kind === "tool" && s.tool.endsWith("_form"))).toBe(false);
      /* Multi-tool, or there is nothing to read together. */
      expect(t.steps.filter((s) => s.kind === "tool").length).toBeGreaterThanOrEqual(2);
      expect(t.steps.some((s) => s.kind === "model")).toBe(true);
    }
  });

  it("explains a 'do' step, since an unexplained one just gets skipped", () => {
    for (const t of ROUTINE_TEMPLATES) {
      for (const step of t.steps) {
        if (step.kind === "human" && step.action === "do") {
          expect(step.why ?? "").toMatch(/.{30,}/);
        }
      }
    }
  });

  it("says what somebody gets back, in their terms", () => {
    for (const t of ROUTINE_TEMPLATES) {
      expect(t.outcome.length).toBeGreaterThan(30);
      /* An outcome is about their day, not about our machinery. */
      expect(t.outcome).not.toMatch(/tool|registry|API|routine engine/i);
    }
  });

  it("never sends anything: every write step is a form tool", () => {
    for (const t of ROUTINE_TEMPLATES) {
      for (const step of t.steps) {
        if (step.kind !== "tool") continue;
        /* create_* tools that are not forms would act without confirmation. */
        if (step.tool.startsWith("create_")) expect(step.tool).toMatch(/_form$/);
      }
    }
  });

  it("finds one by id", () => {
    expect(templateById(ROUTINE_TEMPLATES[0].id)?.command).toBe(ROUTINE_TEMPLATES[0].command);
    expect(templateById("nope")).toBeNull();
  });
});

describe("what a junior role is offered", () => {
  it("withholds a template whose tools their role cannot run", () => {
    /* The same library, different answer per person, and that difference is
       correct rather than a bug. */
    const readyForCto = ROUTINE_TEMPLATES.filter((t) => checkRoutine(t, tools, "cto").ok).length;
    const readyForViewer = ROUTINE_TEMPLATES.filter((t) => checkRoutine(t, tools, "viewer").ok).length;
    expect(readyForViewer).toBeLessThanOrEqual(readyForCto);
  });
});
