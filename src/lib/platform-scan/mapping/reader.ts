/**
 * Reading one surface, using the browser plumbing that already exists.
 *
 * NOTHING HERE ACQUIRES A BROWSER OR INVENTS A SAFETY RULE. Both already exist
 * and are used by other parts of this product:
 *
 *   - ScanPage (browser/capture.ts) is the minimal page interface the UX scan
 *     and the compliance collector already program against.
 *   - installReadOnlyFloor (browser/capture.ts) aborts every non-GET/HEAD
 *     request before it leaves the browser.
 *   - createSpecDiffBrowser (spec-diff/browser.ts) already solves getting a
 *     chromium, including the remote-CDP path for environments with no binary.
 *
 * So this file adds one thing: turning a page into the facts walk.ts needs.
 *
 * TWO INDEPENDENT SAFETY LAYERS, WHICH IS THE POINT. The click policy refuses
 * to press anything that reads as mutating, and the read-only floor blocks the
 * request even if something slips past. Either alone would be an argument;
 * together they are a guarantee that does not depend on a regex being
 * complete.
 *
 * The harvest function is self-contained and reads only DOM APIs, matching
 * capture.ts, so Playwright can serialise it and jsdom can call it directly in
 * a unit test. That is why this file is testable without a browser.
 */

import { installReadOnlyFloor, type ScanPage } from "../browser/capture";
import { mayClick } from "./click-policy";
import type { MappedForm } from "./types";
import type { SurfaceReader, ReadSurface } from "./walk";

/**
 * A form as the DOM describes it, before judgement.
 *
 * Whether it MUTATES is decided outside the browser, because that judgement
 * belongs to click-policy and the harvest cannot import anything: it is
 * serialised into the page. Raw facts here, policy applied by the reader.
 */
export interface HarvestedForm {
  name: string;
  method: string;
  fields: { name: string; type: string; required: boolean }[];
  /** The submit control's words, which is what the policy reads. */
  submitLabel: string;
}

/** What the DOM harvest returns, before the URL and timing are attached. */
export interface HarvestedPage {
  title: string | null;
  headings: string[];
  links: string[];
  forms: HarvestedForm[];
  tables: ReadSurface["tables"];
  controls: ReadSurface["controls"];
}

/**
 * Read the shape of the current page.
 *
 * Self-contained on purpose: every helper is declared inline so Playwright can
 * serialise it into the page and jsdom can call it directly. Reads only
 * document APIs and changes nothing.
 */
export function harvestSurface(): HarvestedPage {
  const absolute = (href: string | null): string => {
    if (!href) return "";
    try {
      return new URL(href, document.location.href).toString();
    } catch {
      return "";
    }
  };

  const visible = (el: Element): boolean => {
    const style = window.getComputedStyle(el as HTMLElement);
    return style.display !== "none" && style.visibility !== "hidden";
  };

  /* textContent, NOT innerText, matching capture.ts. jsdom does not implement
     innerText, and the whole point of writing this self-contained is that a
     unit test can call it directly: a helper that only works in a real browser
     would quietly make every test here a no-op. */
  const text = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();

  return {
    title: document.title || null,
    headings: Array.prototype.slice
      .call(document.querySelectorAll("h1,h2"))
      .filter(visible)
      .map(text)
      .filter(Boolean)
      .slice(0, 8),
    links: Array.prototype.slice
      .call(document.querySelectorAll("a[href]"))
      .map((a: Element) => absolute(a.getAttribute("href")))
      .filter(Boolean),
    /* OBSERVED, NEVER SUBMITTED. A form is where information enters a system,
       and the list of them is the part a client most often cannot produce. */
    forms: Array.prototype.slice.call(document.querySelectorAll("form")).map((f: Element) => {
      /* Named the way a person would name it: the legend, else a heading
         inside it, else the submit label, else the action path. An unnamed
         form is harder to act on in a report than a badly named one. */
      const legend = f.querySelector("legend,h1,h2,h3");
      const submit = f.querySelector('[type="submit"],button');
      const submitLabel = submit
        ? ((submit.textContent ?? "") || (submit.getAttribute("value") ?? "")).replace(/\s+/g, " ").trim()
        : "";
      const name =
        (legend ? (legend.textContent ?? "").replace(/\s+/g, " ").trim() : "") ||
        submitLabel ||
        f.getAttribute("action") ||
        "unnamed form";
      return {
        name: name.slice(0, 60),
        method: (f.getAttribute("method") ?? "get").toLowerCase(),
        /* A submit or a reset is a control, not a field. Counting them would
           report "Send invite" as a piece of data somebody enters. */
        fields: Array.prototype.slice
          .call(f.querySelectorAll("input,select,textarea"))
          .filter((i: Element) => {
            const t = (i.getAttribute("type") ?? "").toLowerCase();
            return t !== "submit" && t !== "reset" && t !== "button" && t !== "image";
          })
          .map((i: Element) => ({
            name: i.getAttribute("name") ?? "",
            type: i.getAttribute("type") ?? i.tagName.toLowerCase(),
            required: i.hasAttribute("required"),
          })),
        submitLabel: submitLabel.slice(0, 60),
      };
    }),
    /* A table is how a business object shows itself. Column names describe the
       entity; row counts describe how much of it there is. */
    tables: Array.prototype.slice.call(document.querySelectorAll("table")).map((t: Element) => {
      const caption = t.querySelector("caption");
      return {
        caption: caption ? (caption.textContent ?? "").trim() : null,
        columns: Array.prototype.slice.call(t.querySelectorAll("thead th")).map(text),
        rowCount: t.querySelectorAll("tbody tr").length,
      };
    }),
    /* EVERY control, unfiltered. The policy decides what may be touched, not
       this: a reader that pre-filtered would hide what it declined. */
    controls: Array.prototype.slice
      .call(document.querySelectorAll("button,a,summary,[role=tab],[role=menuitem],[role=treeitem]"))
      .filter(visible)
      .map((el: Element) => {
        const e = el as HTMLElement & { disabled?: boolean };
        return {
          tag: e.tagName.toLowerCase(),
          text: text(e).slice(0, 60),
          label: e.getAttribute("aria-label") ?? e.getAttribute("title") ?? undefined,
          type: e.getAttribute("type") ?? undefined,
          role: e.getAttribute("role") ?? undefined,
          insideForm: !!e.closest("form"),
          href: e.getAttribute("href") ?? undefined,
          ariaExpanded: e.hasAttribute("aria-expanded")
            ? e.getAttribute("aria-expanded") === "true"
            : undefined,
          disabled: e.disabled || undefined,
        };
      }),
  };
}

/**
 * Decide whether a form would change something.
 *
 * REUSES THE CLICK POLICY rather than restating its word list. A form's submit
 * button is exactly the kind of control that policy exists to judge, and two
 * copies of "what counts as mutating" would drift apart the first time one was
 * updated.
 *
 * A non-GET method settles it on its own: the browser is declaring intent.
 */
export function judgeForm(form: HarvestedForm): MappedForm {
  const methodMutates = form.method !== "get" && form.method !== "";
  /* JUDGED ON ITS WORDS, NOT ON BEING A SUBMIT. Passing type="submit" here
     made the policy refuse every label it was given, because refusing submits
     is exactly that policy's job, and so EVERY form came back mutating. A
     search box is a GET form with a submit button and changes nothing.
     The method above already answers "does this post"; this asks the
     different question of what the button says it will do. */
  const verdict = mayClick({ tag: "button", text: form.submitLabel });
  const labelMutates = form.submitLabel.length > 0 && !verdict.allowed && /chang/i.test(verdict.because);
  return {
    name: form.name,
    method: form.method,
    fields: form.fields,
    mutating: methodMutates || labelMutates,
  };
}

export interface SurfaceReaderOptions {
  /** Injected so a test can drive time without waiting. */
  now?: () => number;
  /**
   * LET THE PAGE FINISH RENDERING BEFORE READING IT.
   *
   * goto resolves on load, and a client-side app draws its navigation after
   * hydration. Reading immediately harvests the empty shell: measured on this
   * product, the entry page reported ZERO links where it has 39, so the walk
   * ended after one surface and called itself complete.
   *
   * That is the worst shape of failure for a map, because it looks like a
   * finished run of a system with nothing in it.
   *
   * createSpecDiffBrowser already exposes a settle hook for exactly this, so
   * the caller passes it in rather than this file inventing a second answer to
   * a question the product has already answered.
   */
  settle?: (page: ScanPage) => Promise<void>;
}

/**
 * A reader over the page interface the rest of platform-scan already uses.
 *
 * Installs the read-only floor once, before anything is visited, so no
 * mutating request can leave the browser for the whole run.
 */
export async function createSurfaceReader(
  page: ScanPage,
  opts: SurfaceReaderOptions = {},
): Promise<SurfaceReader> {
  const now = opts.now ?? (() => Date.now());

  /* A BUNDLER HELPER THAT DOES NOT EXIST IN A BROWSER.
   *
   * esbuild, which tsx uses, wraps named functions in a __name() call to keep
   * their names for stack traces. When such a function is handed to
   * page.evaluate the call goes with it and the page throws
   * "ReferenceError: __name is not defined", so every read returns nothing.
   *
   * It cost two runs today before being recognised, and it is invisible in a
   * unit test because jsdom calls harvestSurface directly with no bundler in
   * between. Defended here rather than in each caller, since any bundler with
   * a name-preserving transform reintroduces it.
   *
   * The shim is a no-op identity function, and it is defined only if absent so
   * a page that has its own is left alone. Written with no named functions
   * inside, or it would need the very helper it is installing. */
  await page.addInitScript(() => {
    const g = globalThis as unknown as { __name?: (fn: unknown) => unknown };
    if (!g.__name) g.__name = (fn: unknown) => fn;
  });

  /* BEFORE THE FIRST NAVIGATION, not per page. A floor installed after a
     goto would leave the first surface unprotected, which is the one most
     likely to be somebody's dashboard. */
  await installReadOnlyFloor(page);

  return {
    async read(url: string): Promise<ReadSurface> {
      const started = now();
      const response = await page.goto(url);
      if (opts.settle) await opts.settle(page);
      const harvested = await page.evaluate(harvestSurface);
      return {
        url,
        status: response?.status() ?? null,
        loadMs: now() - started,
        ...harvested,
        forms: harvested.forms.map(judgeForm),
      };
    },
  };
}
