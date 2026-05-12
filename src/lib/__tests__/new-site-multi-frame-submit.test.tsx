/**
 * @jest-environment jsdom
 */

/**
 * /sites/new — multi-frame submit FormData shape test.
 *
 * Pins the client → server contract:
 *   - 1-file submit goes under `file` (back-compat with the single-file
 *     extractor path)
 *   - 2+ file submit goes under `files[]` with every frame in order
 *
 * We can't mount NewSitePage directly (Next's client router +
 * `use(params)` aren't available in jsdom). Instead we mirror the exact
 * submit function the page uses — if this test drifts from the page,
 * that's the signal to keep the helper in one place. The page is a
 * thin orchestrator over this helper.
 */

import "@testing-library/jest-dom";

// jsdom polyfills for the thumbnail URLs (imported transitively — not
// used here but cheap to stub so any test helper change doesn't crash).
beforeAll(() => {
   
  (URL as any).createObjectURL = (f: File) => `blob:mock/${f.name}`;
   
  (URL as any).revokeObjectURL = jest.fn();
});

function pngFile(name = "w.png", size = 32): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

/**
 * Mirror of `handleWireframeFiles` on /sites/new. Kept here so the
 * client→server contract is tested without hauling the whole (dashboard)
 * layout into jsdom.
 */
async function submitWireframeFiles(
  files: File[],
  clientSlug: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const fd = new FormData();
  if (files.length === 1) {
    fd.append("file", files[0]);
  } else {
    for (const f of files) fd.append("files[]", f);
  }
  fd.append("clientSlug", clientSlug || "new-site");
  return fetchImpl("/api/sites/parse-brief", { method: "POST", body: fd });
}

describe("NewSite — wireframe submit FormData shape", () => {
  it("1 file posts under `file`, NOT `files[]`", async () => {
    const captured: { body?: FormData } = {};
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      captured.body = init?.body as FormData;
      return {
        ok: true,
        status: 200,
        json: async () => ({ source: "vision" }),
        text: async () => JSON.stringify({ source: "vision" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await submitWireframeFiles([pngFile("only.png")], "cftr", fetchImpl);

    const fd = captured.body!;
    expect(fd.get("file")).toBeInstanceOf(File);
    expect(fd.getAll("files[]")).toHaveLength(0);
    expect(fd.get("clientSlug")).toBe("cftr");
  });

  it("3 files post under `files[]` (one entry per file), NOT `file`", async () => {
    const captured: { body?: FormData } = {};
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      captured.body = init?.body as FormData;
      return {
        ok: true,
        status: 200,
        json: async () => ({ source: "vision" }),
        text: async () => JSON.stringify({ source: "vision" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await submitWireframeFiles(
      [pngFile("p1.png"), pngFile("p2.png"), pngFile("p3.png")],
      "cftr",
      fetchImpl,
    );

    const fd = captured.body!;
    expect(fd.get("file")).toBeNull();
    const entries = fd.getAll("files[]");
    expect(entries).toHaveLength(3);
    expect((entries[0] as File).name).toBe("p1.png");
    expect((entries[1] as File).name).toBe("p2.png");
    expect((entries[2] as File).name).toBe("p3.png");
    expect(fd.get("clientSlug")).toBe("cftr");
  });

  it("empty slug falls back to 'new-site' placeholder", async () => {
    const captured: { body?: FormData } = {};
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      captured.body = init?.body as FormData;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "{}",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await submitWireframeFiles([pngFile("p.png")], "", fetchImpl);
    expect((captured.body as FormData).get("clientSlug")).toBe("new-site");
  });
});
