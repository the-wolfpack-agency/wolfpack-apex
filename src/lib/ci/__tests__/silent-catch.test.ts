/**
 * Classifying catch blocks, including the shapes that made this necessary.
 */
import { findCatchSites, classify, readCatches } from "../silent-catch";

const one = (src: string) => classify(findCatchSites("f.ts", src)[0]);

describe("finding catch blocks", () => {
  it("finds a bare catch and a bound one", () => {
    expect(findCatchSites("f.ts", `try{}catch{}\ntry{}catch(e){}`)).toHaveLength(2);
  });

  /* A body spanning several lines with a nested object is exactly the kind
     that hides something, so line matching would not do. */
  it("takes the whole body, not the first line", () => {
    const [site] = findCatchSites(
      "f.ts",
      `try {} catch (e) {\n  const x = { a: 1, b: { c: 2 } };\n  return x;\n}`,
    );
    expect(site.body).toContain("c: 2");
    expect(site.body).toContain("return x");
  });

  it("is not ended early by a brace inside a string", () => {
    const [site] = findCatchSites("f.ts", `try {} catch { const s = "}"; return null; }`);
    expect(site.body).toContain("return null");
  });

  it("is not ended early by a brace inside a comment", () => {
    const [site] = findCatchSites("f.ts", `try {} catch { /* } */ return null; }`);
    expect(site.body).toContain("return null");
  });

  it("reports the line the catch is on", () => {
    const [site] = findCatchSites("f.ts", `const a = 1;\nconst b = 2;\ntry {} catch {}`);
    expect(site.line).toBe(3);
  });

  it("does not match a variable named catcher", () => {
    expect(findCatchSites("f.ts", `const catcher = { x: 1 };`)).toEqual([]);
  });
});

describe("deciding whether a failure can be found out about", () => {
  /* THE ONE THAT COST AN AFTERNOON. Retrieval threw, this returned empty, and
     every layer above honestly reported "nothing found". */
  it("calls an empty-array fallback silent", () => {
    expect(one(`try {} catch { return []; }`).state).toBe("silent");
  });

  it("calls an empty catch silent", () => {
    expect(one(`try {} catch {}`).state).toBe("silent");
  });

  it("accepts a log", () => {
    expect(one(`try {} catch (e) { console.warn("boom", e); return []; }`).state).toBe("reports");
  });

  it("accepts a rethrow", () => {
    expect(one(`try {} catch (e) { throw e; }`).state).toBe("reports");
  });

  /* The names are taken from this repository. A check looking for the wrong
     ones would report working code as silent and be turned off within a day. */
  it("accepts the degradation and analytics recorders this repo actually uses", () => {
    expect(one(`try {} catch { degradation.note("qdrant"); return []; }`).state).toBe("reports");
    expect(one(`try {} catch { trackEvent("x", "u", "r"); return []; }`).state).toBe("reports");
    expect(one(`try {} catch { await persistProbeResult(w, p); }`).state).toBe("reports");
  });

  it("accepts a declared quiet catch and keeps its reason", () => {
    const v = one(`try {} catch { /* silent-ok: the caller already reports it */ return null; }`);
    expect(v.state).toBe("declared");
    expect(v.state === "declared" && v.reason).toBe("the caller already reports it");
  });

  /* A marker with no reason is a mute button, and a mute button gets pressed.
     Writing why forces the question of whether it is actually fine. */
  it("does not accept the marker without a reason", () => {
    expect(one(`try {} catch { /* silent-ok: */ return null; }`).state).toBe("silent");
    expect(one(`try {} catch { /* silent-ok */ return null; }`).state).toBe("silent");
  });
});

describe("reading a set of files", () => {
  it("separates the three kinds", () => {
    const r = readCatches([
      { path: "a.ts", source: `try {} catch { return []; }` },
      { path: "b.ts", source: `try {} catch (e) { console.error(e); }` },
      { path: "c.ts", source: `try {} catch { /* silent-ok: best effort probe */ }` },
    ]);
    expect(r.silent).toHaveLength(1);
    expect(r.reports).toHaveLength(1);
    expect(r.declared).toHaveLength(1);
    expect(r.silent[0].site.file).toBe("a.ts");
  });

  it("finds nothing in a file with no catches", () => {
    expect(readCatches([{ path: "a.ts", source: `const x = 1;` }]).verdicts).toEqual([]);
  });
});
