/**
 * url-parser — unit tests against the three SharePoint URL shapes the
 * "Copy link" / "Open in browser" flows produce in 2025-2026.
 *
 * resolveSiteAndDrive is exercised separately (mocked Graph) — the
 * pure-function tests here focus on the parser.
 */

import {
  parseSharepointFolderUrl,
  resolveSiteAndDrive,
  type ParsedSharepointFolderUrl,
} from "@/lib/sharepoint/url-parser";

describe("parseSharepointFolderUrl", () => {
  /* ---- Pattern 1: folder-browse URL with ?id= ---------------------- */
  it("parses a folder-browse URL with ?id= query", () => {
    const url =
      "https://contoso.sharepoint.com/sites/PCNA/Shared%20Documents/SubFolder/More?id=%2Fsites%2FPCNA%2FShared%20Documents%2FSubFolder%2FMore&p=4";
    const out = parseSharepointFolderUrl(url);
    expect(out).toEqual<ParsedSharepointFolderUrl>({
      site_host: "contoso.sharepoint.com",
      site_path: "sites/PCNA",
      folder_path: "Shared Documents/SubFolder/More",
    });
  });

  /* ---- Pattern 2: share-by-link URL -------------------------------- */
  it("parses a share-by-link URL with /:f:/r/ prefix", () => {
    const url =
      "https://contoso.sharepoint.com/:f:/r/sites/PCNA/Shared%20Documents/SubFolder?csf=1&web=1&e=ABCDE";
    const out = parseSharepointFolderUrl(url);
    expect(out).toEqual<ParsedSharepointFolderUrl>({
      site_host: "contoso.sharepoint.com",
      site_path: "sites/PCNA",
      folder_path: "Shared Documents/SubFolder",
    });
  });

  /* ---- Pattern 3: plain hierarchy URL ------------------------------ */
  it("parses a plain hierarchy URL (no query string)", () => {
    const url =
      "https://contoso.sharepoint.com/sites/PCNA/Shared%20Documents/SubFolder";
    const out = parseSharepointFolderUrl(url);
    expect(out).toEqual<ParsedSharepointFolderUrl>({
      site_host: "contoso.sharepoint.com",
      site_path: "sites/PCNA",
      folder_path: "Shared Documents/SubFolder",
    });
  });

  it("decodes percent-encoded apostrophes and spaces", () => {
    const url =
      "https://contoso.sharepoint.com/sites/PCNA/Shared%20Documents/Alicia%27s%20Folder";
    const out = parseSharepointFolderUrl(url);
    expect(out?.folder_path).toBe("Shared Documents/Alicia's Folder");
  });

  it("strips trailing slashes", () => {
    const url =
      "https://contoso.sharepoint.com/sites/PCNA/Shared%20Documents/SubFolder/";
    const out = parseSharepointFolderUrl(url);
    expect(out?.folder_path).toBe("Shared Documents/SubFolder");
  });

  /* ---- Invalid inputs --------------------------------------------- */
  it("returns null for an empty string", () => {
    expect(parseSharepointFolderUrl("")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(parseSharepointFolderUrl("not a url")).toBeNull();
  });

  it("returns null for a non-sharepoint host", () => {
    expect(
      parseSharepointFolderUrl("https://drive.google.com/folder/abc"),
    ).toBeNull();
  });

  it("returns null for a sharepoint URL with no /sites/ segment", () => {
    expect(
      parseSharepointFolderUrl("https://contoso.sharepoint.com/_layouts/15/start.aspx"),
    ).toBeNull();
  });

  it("returns null when the folder path is empty (library root only)", () => {
    expect(
      parseSharepointFolderUrl("https://contoso.sharepoint.com/sites/PCNA"),
    ).toBeNull();
  });

  it("ignores a non-string input", () => {
    expect(parseSharepointFolderUrl(undefined as unknown as string)).toBeNull();
    expect(parseSharepointFolderUrl(null as unknown as string)).toBeNull();
  });

  it("trims whitespace before parsing", () => {
    const out = parseSharepointFolderUrl(
      "  https://contoso.sharepoint.com/sites/PCNA/Shared%20Documents/SubFolder  ",
    );
    expect(out?.folder_path).toBe("Shared Documents/SubFolder");
  });

  it("prefers the ?id= query over the pathname when both disagree", () => {
    /* SharePoint sometimes hands back a generic browse URL but with an
       authoritative ?id= pointing at a sibling folder. Honor the id. */
    const url =
      "https://contoso.sharepoint.com/sites/PCNA/Shared%20Documents/Wrong?id=%2Fsites%2FPCNA%2FShared%20Documents%2FRight";
    const out = parseSharepointFolderUrl(url);
    expect(out?.folder_path).toBe("Shared Documents/Right");
  });
});

/* ------------------------------------------------------------------ */
/* resolveSiteAndDrive — mocked Graph                                  */
/* ------------------------------------------------------------------ */

const mockGetValidToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

describe("resolveSiteAndDrive", () => {
  const PARSED: ParsedSharepointFolderUrl = {
    site_host: "contoso.sharepoint.com",
    site_path: "sites/PCNA",
    folder_path: "Shared Documents/SubFolder",
  };

  let originalFetch: typeof fetch;
  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns no_token when the user has no Microsoft connection", async () => {
    mockGetValidToken.mockResolvedValueOnce(null);
    const r = await resolveSiteAndDrive("user-1", PARSED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("no_token");
  });

  it("returns site_not_found on a 404 from the site lookup", async () => {
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tok",
      userEmail: "u@t",
    });
    global.fetch = jest.fn(async () =>
      new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch;
    const r = await resolveSiteAndDrive("user-1", PARSED);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("site_not_found");
  });

  it("happy path — resolves site_id + drive_id + remainder folder path", async () => {
    mockGetValidToken.mockResolvedValueOnce({
      accessToken: "tok",
      userEmail: "u@t",
    });
    const sequence = [
      new Response(
        JSON.stringify({ id: "contoso.sharepoint.com,abc,def" }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          value: [
            { id: "drive-default", name: "Documents", driveType: "documentLibrary" },
            { id: "drive-other", name: "Other", driveType: "documentLibrary" },
          ],
        }),
        { status: 200 },
      ),
    ];
    global.fetch = jest.fn(async () => sequence.shift()!) as unknown as typeof fetch;
    const r = await resolveSiteAndDrive("user-1", PARSED);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved).toEqual({
        site_id: "contoso.sharepoint.com,abc,def",
        // "Shared Documents" maps to the default "Documents" drive.
        drive_id: "drive-default",
        folder_path: "SubFolder",
      });
    }
  });
});
