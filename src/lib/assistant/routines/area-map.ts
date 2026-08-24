/**
 * Which parts of a company each chain belongs to, and where they meet.
 *
 * A list of chains tells somebody what they can run. It does not tell
 * them how their work touches anybody else's, which is the question a
 * company asks before it buys middleware: not "can this automate my
 * morning" but "does automating my morning help the person after me".
 *
 * DERIVED, NOT DRAWN. Every area, every chain and every crossing here
 * comes from the templates themselves: the audience each declares and the
 * tools its steps actually run. Nothing is arranged by hand, so the map
 * cannot show a relationship the product does not have, and it changes
 * the day somebody adds a chain rather than the day somebody remembers to
 * redraw it.
 *
 * That constraint is the point. A map of how a business SHOULD flow is a
 * diagram anybody can make in an afternoon and nobody can check. This one
 * is only ever a picture of what is built.
 */

import { ROUTINE_TEMPLATES, type RoutineTemplate } from "./templates";

export interface AreaChain {
  command: string;
  description: string;
  /** Tools this chain runs, in order, deduped. */
  touches: string[];
  /** How many steps hand back to a person. */
  humanSteps: number;
}

export interface Crossing {
  /** The system both areas reach. */
  tool: string;
  /** Areas that both run a chain touching it, always two or more. */
  areas: string[];
  /** The chains involved, so a claim can be checked rather than believed. */
  chains: string[];
}

export interface AreaMap {
  areas: Array<{ area: string; forRole: string; chains: AreaChain[] }>;
  crossings: Crossing[];
}

function toolsOf(t: RoutineTemplate): string[] {
  const seen: string[] = [];
  for (const step of t.steps) {
    if (step.kind !== "tool") continue;
    const tool = (step as { tool?: string }).tool;
    if (tool && !seen.includes(tool)) seen.push(tool);
  }
  return seen;
}

export function buildAreaMap(templates: readonly RoutineTemplate[] = ROUTINE_TEMPLATES): AreaMap {
  const byArea = new Map<string, { forRole: string; chains: AreaChain[] }>();

  for (const t of templates) {
    const entry = byArea.get(t.audience) ?? {
      forRole: t.forRole,
      chains: [] as AreaChain[],
    };
    entry.chains.push({
      command: t.command,
      description: t.description,
      touches: toolsOf(t),
      humanSteps: t.steps.filter((s: { kind: string }) => s.kind === "human").length,
    });
    byArea.set(t.audience, entry);
  }

  /* A crossing is one system reached by chains from more than one area.
     Same area twice is not a crossing: two sales chains both reading the
     pipeline is sales doing its job, not two parts of a company meeting. */
  const areasByTool = new Map<string, Set<string>>();
  const chainsByTool = new Map<string, Set<string>>();
  for (const t of templates) {
    for (const tool of toolsOf(t)) {
      (areasByTool.get(tool) ?? areasByTool.set(tool, new Set()).get(tool)!).add(t.audience);
      (chainsByTool.get(tool) ?? chainsByTool.set(tool, new Set()).get(tool)!).add(t.command);
    }
  }

  const crossings: Crossing[] = [...areasByTool.entries()]
    .filter(([, areas]) => areas.size > 1)
    .map(([tool, areas]) => ({
      tool,
      areas: [...areas].sort(),
      chains: [...(chainsByTool.get(tool) ?? [])].sort(),
    }))
    /* Most-shared first: the systems more of the company depends on are
       the ones worth connecting first, and the ones worth worrying about
       when they are down. */
    .sort((a, b) => b.areas.length - a.areas.length || a.tool.localeCompare(b.tool));

  return {
    areas: [...byArea.entries()]
      .map(([area, v]) => ({ area, forRole: v.forRole, chains: v.chains }))
      .sort((a, b) => b.chains.length - a.chains.length || a.area.localeCompare(b.area)),
    crossings,
  };
}

/**
 * The map in a sentence, for somebody who will not read the table.
 *
 * Says what is there and, when it is thin, says that too: three chains
 * across two areas is not a picture of a company, and a summary that
 * described it as one would be the same overclaim as a coverage report
 * that calls a failed walk a mapped system.
 */
export function describeAreaMap(map: AreaMap): string {
  const chains = map.areas.reduce((n, a) => n + a.chains.length, 0);
  if (chains === 0) return "No chains are defined yet, so there is nothing to map.";

  const shared = map.crossings.length;
  const head =
    `${chains} chains across ${map.areas.length} ${map.areas.length === 1 ? "area" : "areas"}.`;
  if (shared === 0) {
    return `${head} None of them touch the same system, so nothing here shows one area's work reaching another's.`;
  }
  const top = map.crossings[0];
  return (
    `${head} ${shared} ${shared === 1 ? "system is" : "systems are"} reached from more than one ` +
    `area, most shared being ${top.tool} across ${top.areas.join(" and ")}.`
  );
}
