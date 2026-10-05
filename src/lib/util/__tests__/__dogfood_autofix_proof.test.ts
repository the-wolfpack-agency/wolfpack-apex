/** @jest-environment node */
import { dogfoodAdd } from "../__dogfood_autofix_proof";

it("adds two numbers (the loop must make this pass)", () => {
  expect(dogfoodAdd(2, 3)).toBe(5);
  expect(dogfoodAdd(-1, 1)).toBe(0);
});
