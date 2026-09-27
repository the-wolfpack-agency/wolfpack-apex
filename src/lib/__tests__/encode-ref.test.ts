/**
 * encodeRef: a git ref used as a URL PATH segment must keep its slashes (a
 * branch like "factory/x" is one ref, not two). encodeURIComponent would percent-
 * encode the slash and GitHub would 404, which silently emptied every CI read for
 * a slashed branch (found by dogfooding: the CI-fixer saw zero checks). This
 * preserves safe refs verbatim and rejects anything that could traverse/inject.
 */
import { encodeRef } from "@/lib/github-client";

test("preserves a slashed branch verbatim (the whole point)", () => {
  expect(encodeRef("factory/dogfood-slugify-c6901e55")).toBe("factory/dogfood-slugify-c6901e55");
});

test("passes plain branches and SHAs through unchanged", () => {
  expect(encodeRef("main")).toBe("main");
  expect(encodeRef("release/2.0")).toBe("release/2.0");
  expect(encodeRef("1310e20e29528ddf22ffd6e569d70f149460c201")).toBe("1310e20e29528ddf22ffd6e569d70f149460c201");
});

test("rejects path traversal", () => {
  expect(() => encodeRef("../../etc/passwd")).toThrow(/unsafe/i);
  expect(() => encodeRef("factory/..")).toThrow(/unsafe/i);
});

test("rejects injection / unsafe characters (spaces, %, ?, ;, already-encoded)", () => {
  expect(() => encodeRef("a b")).toThrow(/unsafe/i);
  expect(() => encodeRef("factory%2Fx")).toThrow(/unsafe/i); // % is not a valid ref char
  expect(() => encodeRef("a?b=1")).toThrow(/unsafe/i);
  expect(() => encodeRef("a;rm -rf")).toThrow(/unsafe/i);
});
