import { dogfoodAdd } from "../__dogfood_autofix_proof";

describe("dogfoodAdd", () => {
  it("should correctly add two numbers", () => {
    expect(dogfoodAdd(2, 3)).toBe(5);
    expect(dogfoodAdd(-1, 1)).toBe(0);
    expect(dogfoodAdd(0, 0)).toBe(0);
    expect(dogfoodAdd(42, 58)).toBe(100);
  });
});