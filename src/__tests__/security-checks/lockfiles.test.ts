import {
  isImageFile,
  lockfileKind,
  parseImageRefs,
  parsePackageLock,
  parsePnpmLock,
  parseRequirements,
  parseTomlPackageBlocks,
  parseYarnLock,
  splitPnpmKey,
} from "../../../scripts/security/lib/lockfiles";

describe("lockfileKind", () => {
  it("recognizes every supported lockfile and nothing else", () => {
    expect(lockfileKind("package-lock.json")).toBe("package-lock");
    expect(lockfileKind("apps/web/pnpm-lock.yaml")).toBe("pnpm-lock");
    expect(lockfileKind("yarn.lock")).toBe("yarn-lock");
    expect(lockfileKind("requirements.txt")).toBe("requirements");
    expect(lockfileKind("svc/requirements-dev.txt")).toBe("requirements");
    expect(lockfileKind("poetry.lock")).toBe("poetry-lock");
    expect(lockfileKind("uv.lock")).toBe("uv-lock");
    expect(lockfileKind("package.json")).toBeNull();
    expect(lockfileKind("node_modules/x/package-lock.json")).toBeNull();
  });
});

describe("parsePackageLock", () => {
  it("reads v3 packages including nested and scoped entries, skipping root, links and git deps", () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root", version: "1.0.0" },
        "node_modules/@subql/common": { version: "5.8.3" },
        "node_modules/a/node_modules/lodash": { version: "4.17.15" },
        "node_modules/aliased": { name: "real-name", version: "2.0.0" },
        "node_modules/linked": { link: true, resolved: "packages/linked" },
        "node_modules/gitdep": { version: "git+https://github.com/x/y.git#abc" },
        "packages/linked": { version: "0.0.1" },
      },
    });
    expect(parsePackageLock(text)).toEqual([
      { ecosystem: "npm", name: "@subql/common", version: "5.8.3" },
      { ecosystem: "npm", name: "lodash", version: "4.17.15" },
      { ecosystem: "npm", name: "real-name", version: "2.0.0" },
    ]);
  });

  it("reads v1 nested dependencies", () => {
    const text = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0" } } } },
    });
    expect(parsePackageLock(text).map((p) => `${p.name}@${p.version}`)).toEqual(["a@1.0.0", "b@2.0.0"]);
  });

  it("returns nothing for invalid JSON instead of throwing", () => {
    expect(parsePackageLock("{not json")).toEqual([]);
  });
});

describe("pnpm", () => {
  it("splits v5, v6 and v9 keys, including peer suffixes", () => {
    expect(splitPnpmKey("/@scope/name/1.2.3")).toEqual({ name: "@scope/name", version: "1.2.3" });
    expect(splitPnpmKey("/name/1.2.3_react@18.2.0")).toEqual({ name: "name", version: "1.2.3" });
    expect(splitPnpmKey("/@scope/name@1.2.3(react@18.2.0)")).toEqual({ name: "@scope/name", version: "1.2.3" });
    expect(splitPnpmKey("tensorlake@0.5.144")).toEqual({ name: "tensorlake", version: "0.5.144" });
    expect(splitPnpmKey("'@subql/common@5.8.3'")).toEqual({ name: "@subql/common", version: "5.8.3" });
    expect(splitPnpmKey("link:../x")).toBeNull();
  });

  it("reads packages and snapshots sections only", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      not-a-package@1.0.0:",
      "packages:",
      "  '@subql/common@5.8.3':",
      "    resolution: {integrity: sha512-x}",
      "  left-pad@1.3.0:",
      "    resolution: {integrity: sha512-y}",
      "snapshots:",
      "  left-pad@1.3.0: {}",
      "  next@16.0.0(react@19.0.0):",
      "    dependencies:",
    ].join("\n");
    expect(parsePnpmLock(text).map((p) => `${p.name}@${p.version}`)).toEqual([
      "@subql/common@5.8.3",
      "left-pad@1.3.0",
      "next@16.0.0",
    ]);
  });
});

describe("parseYarnLock", () => {
  it("reads classic v1 entries with multiple descriptors", () => {
    const text = [
      "# yarn lockfile v1",
      "",
      '"@subql/common@^5.8.2", "@subql/common@~5.8.2":',
      '  version "5.8.3"',
      '  resolved "https://registry.yarnpkg.com/x"',
      "",
      "left-pad@^1.3.0:",
      '  version "1.3.0"',
    ].join("\n");
    expect(parseYarnLock(text).map((p) => `${p.name}@${p.version}`)).toEqual(["@subql/common@5.8.3", "left-pad@1.3.0"]);
  });

  it("reads berry entries and skips metadata and workspaces", () => {
    const text = [
      "__metadata:",
      "  version: 6",
      "",
      '"tensorlake@npm:^0.5.0":',
      "  version: 0.5.144",
      "  resolution: \"tensorlake@npm:0.5.144\"",
      "",
      '"root@workspace:.":',
      "  version: 0.0.0-use.local",
    ].join("\n");
    expect(parseYarnLock(text)).toEqual([{ ecosystem: "npm", name: "tensorlake", version: "0.5.144" }]);
  });
});

describe("parseRequirements", () => {
  it("reads == pins, normalizes names and ignores ranges, comments, options and markers", () => {
    const text = [
      "# comment",
      "-r base.txt",
      "LiteLLM==1.107.0",
      "requests[socks]==2.31.0 ; python_version > '3.8'",
      "Foo_Bar===1.0 --hash=sha256:abc",
      "flask>=2.0",
      "numpy",
    ].join("\n");
    expect(parseRequirements(text)).toEqual([
      { ecosystem: "PyPI", name: "litellm", version: "1.107.0" },
      { ecosystem: "PyPI", name: "requests", version: "2.31.0" },
      { ecosystem: "PyPI", name: "foo-bar", version: "1.0" },
    ]);
  });
});

describe("poetry.lock and uv.lock", () => {
  it("reads [[package]] name and version, ignoring sub-tables and inline dependency names", () => {
    const poetry = [
      "[[package]]",
      'name = "litellm"',
      'version = "1.107.0"',
      "",
      "[package.dependencies]",
      'name = "should-not-be-read"',
      "",
      "[[package]]",
      'name = "httpx"',
      'version = "0.27.0"',
      "",
      "[metadata]",
      'lock-version = "2.0"',
    ].join("\n");
    expect(parseTomlPackageBlocks(poetry).map((p) => `${p.name}@${p.version}`)).toEqual(["litellm@1.107.0", "httpx@0.27.0"]);

    const uv = [
      "version = 1",
      "[[package]]",
      'name = "Tensorlake"',
      'version = "0.5.144"',
      'source = { registry = "https://pypi.org/simple" }',
      "dependencies = [",
      '    { name = "anyio" },',
      "]",
    ].join("\n");
    expect(parseTomlPackageBlocks(uv)).toEqual([{ ecosystem: "PyPI", name: "tensorlake", version: "0.5.144" }]);
  });
});

describe("image references", () => {
  it("finds Dockerfiles and compose files", () => {
    expect(isImageFile("Dockerfile")).toBe(true);
    expect(isImageFile("deploy/Dockerfile.prod")).toBe(true);
    expect(isImageFile("docker-compose.yml")).toBe(true);
    expect(isImageFile("compose.yaml")).toBe(true);
    expect(isImageFile("src/index.ts")).toBe(false);
  });

  it("splits repo, tag and digest, including registry ports", () => {
    const text = [
      "FROM --platform=linux/amd64 ghcr.io/berriai/litellm:v1.107.0 AS base",
      "FROM node:20",
      "services:",
      "  proxy:",
      "    image: litellm/litellm@sha256:abc",
      "    image: localhost:5000/app",
    ].join("\n");
    expect(parseImageRefs(text)).toEqual([
      { image: "ghcr.io/berriai/litellm", tag: "v1.107.0", digest: null },
      { image: "node", tag: "20", digest: null },
      { image: "litellm/litellm", tag: null, digest: "sha256:abc" },
      { image: "localhost:5000/app", tag: null, digest: null },
    ]);
  });
});
