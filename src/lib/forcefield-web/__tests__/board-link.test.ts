/** Deep links into the Forcefield board: built by the alert email, read by the page. */
import { boardHref, parseBoardDeepLink, BOARD_PATH } from "../board-link";

describe("boardHref", () => {
  it("bare board path with no params", () => {
    expect(boardHref()).toBe(BOARD_PATH);
  });
  it("stable param order, encoded finder", () => {
    expect(boardHref({ tab: "forcefield", view: "operator", find: "/_ff/records", days: 7 })).toBe("/admin/site-analytics?tab=forcefield&view=operator&find=%2F_ff%2Frecords&days=7");
  });
});

describe("parseBoardDeepLink", () => {
  it("round-trips what boardHref builds", () => {
    const link = { tab: "forcefield" as const, view: "operator" as const, find: "2ff4a2bb", days: 30 as const };
    expect(parseBoardDeepLink(boardHref(link).split("?")[1])).toEqual(link);
  });
  it("drops unknown tabs, views and ranges (a crafted link selects only known values)", () => {
    expect(parseBoardDeepLink("?tab=admin&view=x&days=5&find=%20%20")).toEqual({});
  });
  it("caps the finder length", () => {
    expect(parseBoardDeepLink(`?find=${"a".repeat(500)}`).find).toHaveLength(200);
  });
});
