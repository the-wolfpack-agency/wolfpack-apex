/**
 * A map of a client system, built by walking it rather than by reading it.
 *
 * WHY THE EXISTING PROFILE IS NOT ENOUGH
 *
 * SystemProfile is assembled from source artifacts — migrations for entities,
 * package.json for integrations, a route manifest for the auth model. That
 * works for a repository we can read. A client's live Salesforce instance has
 * none of it: no migrations, no manifest, no sitemap, and a navigation tree
 * that only exists once you have logged in and the JavaScript has run.
 *
 * So this models what an authenticated browser can OBSERVE, and the observed
 * map feeds the same profile and recommendation pipeline that already exists.
 *
 * THE HONESTY PROBLEM AT THE CENTRE OF MAPPING
 *
 * A map is always partial. You stop because you ran out of budget, not because
 * you reached the end, and a client system is large enough that you will always
 * run out of budget first. A report that says "here is your system" when it
 * means "here are the 60 pages we reached" is the most damaging thing this
 * feature could produce, because every recommendation drawn from it inherits a
 * completeness nobody established.
 *
 * Hence `coverage`: what was reached, what was deliberately skipped, what was
 * still queued when we stopped, and why we stopped. Every consumer of this map
 * has the numbers to qualify its own claims.
 */

import type { ExportAffordance } from "./volume";

/** One page or view the map reached. */
export interface MappedSurface {
  /** Canonical URL as visited. */
  url: string;
  /** Path with volatile ids replaced, so /Account/001x and /Account/001y are
   *  recognised as one surface rather than two thousand. */
  signature: string;
  title: string | null;
  /** Depth from the entry point. */
  depth: number;
  /** Heading text, which is what names a screen to a human. */
  headings: string[];
  /** Where this surface links onward. Signatures, not URLs, so the graph is
   *  about structure rather than about record ids. */
  linksTo: string[];
  /** Data-entry surfaces found here. Observed, never submitted. */
  forms: MappedForm[];
  /** Tabular data on the page, which is how a business object shows itself. */
  tables: { caption: string | null; columns: string[]; rowCount: number }[];
  /**
   * How many records the screen said it holds. Null means it did not say,
   * which is NOT zero: "holds nothing" and "did not state" are opposite facts
   * and a migration plan built on the wrong one is wrong by a whole object.
   */
  recordCount?: number | null;
  /** The phrase the count was read from, so a reviewer can check. */
  recordCountFrom?: string | null;
  /** Ways data appeared to be gettable out. Detected, never pressed. */
  exports?: ExportAffordance[];
  /** HTTP status when the surface was fetched. */
  status: number | null;
  /** Milliseconds to load. A slow screen IS a finding for the report. */
  loadMs: number | null;
}

/**
 * A form, described but NEVER submitted.
 *
 * Mapping is read-only. Submitting a form on a client's live system could
 * create a record, send an email, or start a workflow, and no amount of "it was
 * only a test" makes that acceptable on someone else's production instance.
 * What a form reveals is its SHAPE — which is what the report needs anyway.
 */
export interface MappedForm {
  /** Best-effort human name: a legend, a heading, or the submit label. */
  name: string;
  method: string;
  fields: { name: string; type: string; required: boolean }[];
  /** True when the form would create or change something, inferred from method
   *  and labels. Drives the read-only refusal and flags it in the report. */
  mutating: boolean;
}

/** A business object the system appears to manage, inferred from what is on
 *  screen rather than from a schema we cannot see. */
export interface InferredEntity {
  name: string;
  /** Where the evidence came from, so a reviewer can check rather than trust. */
  evidence: { surface: string; kind: "table" | "form" | "heading" | "nav" }[];
  /** Field names observed across forms and table columns. */
  attributes: string[];
}

/** An external system this platform talks to, observed on the wire. */
export interface ObservedIntegration {
  host: string;
  /** Vendor when recognised. Null means unrecognised, not absent. */
  vendor: string | null;
  /** Surfaces that triggered it, so "what uses Stripe" is answerable. */
  seenOn: string[];
  requestCount: number;
}

/** A path a user could take, as a sequence of surface signatures. */
export interface UserPath {
  name: string;
  steps: string[];
  /** True when every step was actually reached. A path assembled from a
   *  partially-explored graph is a hypothesis, and must say so. */
  verified: boolean;
}

/** Why exploration stopped. Never omitted: it is the difference between a
 *  complete map and a truncated one. */
export type StopReason = "frontier-exhausted" | "page-budget" | "time-budget" | "depth-budget" | "refused" | "error";

export interface MapCoverage {
  surfacesReached: number;
  /** Still queued when we stopped. Non-zero means the map is INCOMPLETE, and
   *  every claim drawn from it inherits that. */
  frontierRemaining: number;
  /** Links deliberately not followed, with the reason. Off-origin, logout,
   *  and anything that looked mutating. */
  skipped: { signature: string; reason: string }[];
  /** Repeated screen shapes: how many instances exist, and how many were
   *  actually opened. The gap between those two numbers is the difference
   *  between a small system and a sample of a large one. */
  patterns: { shape: string; instances: string[]; visited: number }[];
  maxDepthReached: number;
  stopReason: StopReason;
  durationMs: number;
}

export interface SystemMap {
  platform: string;
  entryUrl: string;
  surfaces: MappedSurface[];
  entities: InferredEntity[];
  integrations: ObservedIntegration[];
  paths: UserPath[];
  coverage: MapCoverage;
  generatedAt: string;
  /** One sentence a person reads first. Says what was NOT covered. */
  headline: string;
}
