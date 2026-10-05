/**
 * Cached, fail-open value-score source for the router (A1c step 2). The safety
 * contract: cold cache / failure / flag-off / non-factory feature => {} => the
 * router's prior behavior. Value-routing can only refine, never break.
 */
import {
  valueRoutingEnabled, isFactoryFeature, cachedModelValueScores,
  _resetValueScoreCache, _primeValueScoreCache,
} from "../value-scores";

beforeEach(() => _resetValueScoreCache());

describe("valueRoutingEnabled (dark by default)", () => {
  it("is off when unset and on only for on/true/1", () => {
    expect(valueRoutingEnabled({})).toBe(false);
    expect(valueRoutingEnabled({ AI_VALUE_ROUTING: "off" })).toBe(false);
    for (const v of ["on", "true", "1", "TRUE"]) expect(valueRoutingEnabled({ AI_VALUE_ROUTING: v })).toBe(true);
  });
});

describe("isFactoryFeature (scope: code-authoring scores never steer other callers)", () => {
  it("matches factory/ai-code features only", () => {
    expect(isFactoryFeature("ai-code-pipeline-author")).toBe(true);
    expect(isFactoryFeature("dogfood")).toBe(true);
    expect(isFactoryFeature("assistant-chat")).toBe(false);
    expect(isFactoryFeature(undefined)).toBe(false);
  });
});

describe("cachedModelValueScores (fail-open, sync, never throws)", () => {
  it("returns {} on a COLD cache (prior router behavior) and never throws", () => {
    expect(cachedModelValueScores("w-1")).toEqual({});
  });
  it("returns a primed map synchronously", () => {
    _primeValueScoreCache("w-1", { "gpt-4o": 85.8 });
    expect(cachedModelValueScores("w-1")).toEqual({ "gpt-4o": 85.8 });
  });
  it("returns the still-cached map even when stale (stale-while-revalidate)", () => {
    _primeValueScoreCache("w-1", { "gpt-4o": 1 }, 0); // very old timestamp
    expect(cachedModelValueScores("w-1", 999_999_999_999)).toEqual({ "gpt-4o": 1 }); // returns stale, triggers bg refresh
  });
  it("scopes by workspace", () => {
    _primeValueScoreCache("w-1", { "gpt-4o": 9 });
    expect(cachedModelValueScores("w-2")).toEqual({}); // different ws -> cold -> {}
  });
});
