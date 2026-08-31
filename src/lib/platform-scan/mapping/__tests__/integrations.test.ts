/**
 * Turning observed traffic into "which outside companies does this system
 * send data to, and from which screens".
 */
import { observedIntegrations, describeIntegrations } from "../integrations";
import type { NetworkObservation } from "../../network/observations";

const obs = (url: string, pageUrl: string, atMs = 0): NetworkObservation => ({
  url,
  pageUrl,
  resourceType: "fetch",
  atMs,
  status: 200,
});

const APP = "https://app.acme.example";

describe("grouping third-party traffic by host", () => {
  it("names a vendor it recognizes", () => {
    const out = observedIntegrations([obs("https://www.google-analytics.com/g", `${APP}/home`)]);
    /* hostOf normalizes the www prefix away, so one vendor reached two ways is
       one entry rather than two. */
    expect(out[0].host).toBe("google-analytics.com");
    expect(out[0].vendor).toBe("Google Analytics");
  });

  /* UNRECOGNIZED IS NOT BENIGN. On somebody else's system the hosts we cannot
     name are the ones most worth asking about, and dropping them would make an
     unfamiliar system look cleaner than a familiar one. */
  it("keeps a host it cannot name, with a null vendor", () => {
    const out = observedIntegrations([obs("https://telemetry.unknown.example/x", `${APP}/home`)]);
    expect(out).toHaveLength(1);
    expect(out[0].vendor).toBeNull();
  });

  it("ignores the system's own requests", () => {
    expect(observedIntegrations([obs(`${APP}/api/data`, `${APP}/home`)])).toEqual([]);
  });

  /* A static asset host belonging to the same company is not an integration,
     and listing it would bury the ones that are. */
  it("ignores a subdomain of the system itself", () => {
    expect(
      observedIntegrations([obs("https://static.acme.example/logo.png", `${APP}/home`)]),
    ).toEqual([]);
  });

  /* WHERE, not just whether. "The entries export talks to an analytics vendor"
     is a finding; "somewhere in this product, something does" is not. */
  it("says which screens contacted the host", () => {
    const out = observedIntegrations([
      obs("https://vendor.example/a", `${APP}/reports`),
      obs("https://vendor.example/b", `${APP}/settings`),
      obs("https://vendor.example/c", `${APP}/reports`),
    ]);
    expect(out[0].seenOn).toEqual([`${APP}/reports`, `${APP}/settings`]);
  });

  /* seenOn answers "where" and requestCount answers "how much". Conflating
     them would make one chatty screen look like broad usage. */
  it("counts every request but each screen once", () => {
    const out = observedIntegrations([
      obs("https://vendor.example/a", `${APP}/reports`),
      obs("https://vendor.example/b", `${APP}/reports`),
      obs("https://vendor.example/c", `${APP}/reports`),
    ]);
    expect(out[0].requestCount).toBe(3);
    expect(out[0].seenOn).toHaveLength(1);
  });

  it("puts the most contacted host first", () => {
    const out = observedIntegrations([
      obs("https://quiet.example/a", `${APP}/home`),
      obs("https://busy.example/a", `${APP}/home`),
      obs("https://busy.example/b", `${APP}/home`),
    ]);
    expect(out.map((i) => i.host)).toEqual(["busy.example", "quiet.example"]);
  });

  it("finds nothing in an empty capture", () => {
    expect(observedIntegrations([])).toEqual([]);
  });
});

describe("saying it in one sentence", () => {
  /* THE DISTINCTION THAT MATTERS MOST. A scan that was not watching and a
     system that contacts nobody are opposite findings, and most tools render
     them as the same sentence. */
  it("does not let an unwatched walk read as a clean system", () => {
    const notWatched = describeIntegrations([], false);
    const watchedAndClean = describeIntegrations([], true);
    expect(notWatched).toMatch(/gap in the scan, not a clean result/i);
    expect(watchedAndClean).toMatch(/No third-party hosts were contacted/i);
    expect(notWatched).not.toEqual(watchedAndClean);
  });

  it("names what it recognized and counts what it did not", () => {
    const text = describeIntegrations(
      [
        { host: "google-analytics.com", vendor: "Google Analytics", seenOn: [], requestCount: 4 },
        { host: "telemetry.unknown.example", vendor: null, seenOn: [], requestCount: 1 },
      ],
      true,
    );
    expect(text).toContain("Google Analytics");
    expect(text).toMatch(/1 unrecognized/);
    expect(text).toMatch(/worth asking about/i);
  });
});
