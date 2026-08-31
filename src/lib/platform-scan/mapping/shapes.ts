/**
 * Recognizing that thirty screens are three screens, thirty times.
 *
 * WHAT IT FIXES. Mapping a real tenant, the walk spent its whole budget on
 * repetition: every one of thirteen forms has /build, /publish and /entries,
 * so fifty-two surfaces are four screens repeated. It stopped on budget with
 * thirty-four places queued, having learned nothing after the third form that
 * it had not learned from the first.
 *
 * VISIT FEW, RECORD ALL, WHICH IS THE WHOLE IDEA. The inventory is the
 * valuable part of that map and it is already known from the links: thirteen
 * form names are on the home page whether or not anybody opens them. So a
 * shape that has been sampled enough stops being VISITED while every instance
 * is still RECORDED.
 *
 * The output changes from "40 surfaces, incomplete, 34 queued" to "13 forms,
 * each with build, publish and entries, three sampled", which is both smaller
 * and more true.
 *
 * IT IS SAMPLING, AND IT SAYS SO. A map that quietly visited three of thirteen
 * and reported on the estate would be the worst kind of confident. Every
 * pattern carries how many instances exist and how many were opened, so a
 * reader can see the difference between a system with three forms and a sample
 * of a system with thirty.
 */

/**
 * How many instances of one shape are worth opening.
 *
 * Two. The first shows what the screen is and the second confirms it is a
 * pattern rather than a coincidence. On the real tenant this took fifty-two
 * surfaces down to twenty-six while still opening all thirteen forms, because
 * a form's own shape stays unsampled until somebody opens it.
 */
export const SAMPLES_PER_SHAPE = 2;

/** Below this a path has no shape to speak of and is always visited. */
const MIN_SEGMENTS = 2;

/**
 * The shapes a path could be an instance of.
 *
 * One per segment, with that segment replaced by a star. "/org/formA/build"
 * could be an instance of "every form's build screen", or of "every screen of
 * formA". Both are real groupings, and which one matters depends on the
 * system, so both are tracked and whichever fills up first stops the visiting.
 *
 * (Written in words rather than shown, because a star followed by a slash
 * closes the comment it is written in. Cost one compile to notice.)
 */
export function shapesOf(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < MIN_SEGMENTS) return [];
  return segments.map((_, i) => {
    const copy = [...segments];
    copy[i] = "*";
    return `/${copy.join("/")}`;
  });
}

/** The directory a path sits in. Null when it sits at the root. */
function parentOf(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return `/${segments.slice(0, -1).join("/")}`;
}

export interface ShapeReading {
  shape: string;
  /** Every instance seen, visited or not. This is the inventory. */
  instances: string[];
  /** How many were actually opened. */
  visited: number;
}

/**
 * Tracks how much of each shape has been seen.
 *
 * Deliberately not a filter over URLs: the caller asks before visiting and
 * tells it after, so the decision and the record stay in one place and a
 * skipped instance is still counted.
 */
export class ShapeSampler {
  private readonly seen = new Map<string, { instances: Set<string>; visited: number }>();
  /** Parent directories something has been opened under. See isSaturated. */
  private readonly entered = new Set<string>();

  constructor(private readonly samplesPerShape: number = SAMPLES_PER_SHAPE) {}

  /** Record that an instance exists, whether or not it will be opened. */
  note(pathname: string): void {
    for (const shape of shapesOf(pathname)) {
      const entry = this.seen.get(shape) ?? { instances: new Set<string>(), visited: 0 };
      entry.instances.add(pathname);
      this.seen.set(shape, entry);
    }
  }

  /**
   * Has every shape this path belongs to already been sampled enough?
   *
   * ALL of them must be full, not any. A path is an instance of several
   * shapes, and being the fourth build screen does not make it uninteresting
   * if it is also the first screen of a form nobody has opened.
   */
  isSaturated(pathname: string): boolean {
    /* NEVER PRUNE A BRANCH NOBODY HAS ENTERED.
     *
     * This is the one that matters, and it was found by a test rather than by
     * thinking. A skipped page is never READ, so its links are never
     * discovered, so everything behind it disappears from the map. On a system
     * of seven forms the sampler opened the first two landing screens, decided
     * it had seen that shape, and never learned that the other five forms had
     * any sub-screens at all. Five whole business objects, silently absent,
     * from a map that reported itself complete.
     *
     * So sampling applies WITHIN a branch, never to the branch itself. The
     * first page under any parent is always opened, whatever its shape, and
     * only its siblings are candidates for being skipped. */
    const parent = parentOf(pathname);
    if (parent && !this.entered.has(parent)) return false;

    /* ONLY SHAPES THAT ARE ACTUALLY SHAPES.
     *
     * Replacing the org segment of "/org/formB/build" yields a grouping that
     * exactly one page will ever match, because the org never varies. It can
     * therefore never reach the sample count, and requiring it made NOTHING
     * ever saturate: the first version of this ran the full fifty-two.
     *
     * A grouping needs at least two members to be a grouping. */
    const shapes = shapesOf(pathname).filter((s) => (this.seen.get(s)?.instances.size ?? 0) >= 2);
    if (shapes.length === 0) return false;
    return shapes.every((s) => (this.seen.get(s)?.visited ?? 0) >= this.samplesPerShape);
  }

  /** Record that an instance was actually opened. */
  markVisited(pathname: string): void {
    this.note(pathname);
    const parent = parentOf(pathname);
    if (parent) this.entered.add(parent);
    for (const shape of shapesOf(pathname)) {
      const entry = this.seen.get(shape)!;
      entry.visited += 1;
    }
  }

  /**
   * Shapes worth telling somebody about, largest first.
   *
   * A shape with one instance is not a pattern, it is a page, and listing it
   * would bury the ones that describe the system.
   */
  patterns(minInstances = 2): ShapeReading[] {
    return [...this.seen.entries()]
      .filter(([, v]) => v.instances.size >= minInstances)
      .map(([shape, v]) => ({
        shape,
        instances: [...v.instances].sort(),
        visited: v.visited,
      }))
      .sort((a, b) => b.instances.length - a.instances.length || a.shape.localeCompare(b.shape));
  }
}
