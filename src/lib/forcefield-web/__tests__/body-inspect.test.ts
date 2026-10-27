/** @jest-environment node */
/**
 * Bounded request-body inspection: the two body-borne RCEs it must catch
 * (PHP2Shell, React2Shell) and the benign bodies a real site sends every day
 * that MUST pass through untouched. Precision first: a false block on a normal
 * upload or Server Action is worse than none.
 */
import { inspectRequestBody, bodyInspectionApplies, BODY_SCAN_CAP_BYTES, type BodyInspectInput } from "../body-inspect";

const MULTIPART = (parts: string) => ({
  method: "POST",
  contentType: "multipart/form-data; boundary=WpBoundary",
  truncated: false,
  body: parts,
});

/** Build a multipart body from (name, value, filename?) tuples. */
function multipart(parts: Array<{ name: string; value?: string; filename?: string }>): string {
  let out = "";
  for (const p of parts) {
    out += "--WpBoundary\r\n";
    out += `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) out += `; filename="${p.filename}"`;
    out += "\r\n\r\n";
    out += `${p.value ?? "x"}\r\n`;
  }
  out += "--WpBoundary--\r\n";
  return out;
}

describe("PHP2Shell (CVE-2026-109618 / CVE-2026-109619) - hits", () => {
  it("blocks PHP_SESSION_UPLOAD_PROGRESS combined with deep field-name nesting", () => {
    const body = multipart([
      { name: "PHP_SESSION_UPLOAD_PROGRESS", value: "x" },
      { name: "files[a][b][c][d][e][f]", value: "y" },
    ]);
    const r = inspectRequestBody(MULTIPART(body));
    expect(r?.attack).toBe("php2shell");
  });

  it("blocks an abnormal part count on its own (no marker needed)", () => {
    const parts = Array.from({ length: 300 }, (_, i) => ({ name: `f${i}`, value: "1" }));
    const r = inspectRequestBody(MULTIPART(multipart(parts)));
    expect(r?.attack).toBe("php2shell");
  });

  it("blocks machine-generated deep nesting even without the upload-progress field", () => {
    const r = inspectRequestBody(MULTIPART(multipart([{ name: "files[a][b][c][d][e][f][g][h]", value: "1" }])));
    expect(r?.attack).toBe("php2shell");
  });

  it("blocks a PHP open tag in an upload filename", () => {
    const r = inspectRequestBody(MULTIPART(multipart([{ name: "file", filename: "<?php system($_GET[0]);?>.jpg", value: "data" }])));
    expect(r?.attack).toBe("php2shell");
  });

  it("blocks a serialized-object marker (|O:) in an upload filename", () => {
    const r = inspectRequestBody(MULTIPART(multipart([{ name: "file", filename: "x|O:4:\"Evil\":0:{}", value: "data" }])));
    expect(r?.attack).toBe("php2shell");
  });

  it("blocks a single oversized urlencoded field name full of control bytes", () => {
    const body = "A".repeat(70_000) + "\u0000\u0001\u0002" + "B".repeat(2_000);
    const r = inspectRequestBody({ method: "POST", contentType: "application/x-www-form-urlencoded", truncated: false, body });
    expect(r?.attack).toBe("php2shell");
  });

  it("blocks a trickled urlencoded single field (truncated at the cap) with control bytes", () => {
    const body = "k".repeat(1000) + "\u0000" + "k".repeat(1000);
    const r = inspectRequestBody({ method: "POST", contentType: "application/x-www-form-urlencoded", truncated: true, body });
    expect(r?.attack).toBe("php2shell");
  });
});

describe("PHP2Shell - benign near-misses that MUST pass", () => {
  it("a normal WordPress media upload (one file + a few fields) is untouched", () => {
    const body = multipart([
      { name: "action", value: "upload-attachment" },
      { name: "_wpnonce", value: "abc123" },
      { name: "post_id", value: "42" },
      { name: "async-upload", filename: "vacation-photo.jpg", value: "\xff\xd8\xff\xe0 JFIF binary image data" },
      { name: "name", value: "vacation-photo.jpg" },
    ]);
    expect(inspectRequestBody(MULTIPART(body))).toBeNull();
  });

  it("a large but legitimate form with nested fields (depth 2-3) is untouched", () => {
    const parts = [
      { name: "order[billing][street]", value: "1 Main St" },
      { name: "order[billing][city]", value: "Dubai" },
      { name: "order[shipping][street]", value: "2 Side St" },
      ...Array.from({ length: 40 }, (_, i) => ({ name: `line_items[${i}][qty]`, value: "1" })),
    ];
    expect(inspectRequestBody(MULTIPART(multipart(parts)))).toBeNull();
  });

  it("a PHP session-upload-progress field in an OTHERWISE normal upload is not enough on its own", () => {
    // The field CAN appear in legitimate traffic (Datadog): without an abnormal
    // part count or nesting it must NOT block.
    const body = multipart([
      { name: "PHP_SESSION_UPLOAD_PROGRESS", value: "myupload" },
      { name: "file", filename: "doc.pdf", value: "%PDF-1.7 binary" },
    ]);
    expect(inspectRequestBody(MULTIPART(body))).toBeNull();
  });

  it("a normal urlencoded login form (key=value&key=value) is untouched", () => {
    const body = "log=admin&pwd=hunter2&wp-submit=Log+In&redirect_to=%2Fwp-admin%2F";
    expect(inspectRequestBody({ method: "POST", contentType: "application/x-www-form-urlencoded", truncated: false, body })).toBeNull();
  });

  it("a GET request is never inspected", () => {
    expect(inspectRequestBody({ ...MULTIPART(multipart([{ name: "x" }])), method: "GET" })).toBeNull();
  });
});

describe("React2Shell (CVE-2025-55182) - hits", () => {
  it("blocks a Flight reference paired with __proto__ in a multipart Server Action body", () => {
    const body = multipart([{ name: "1_$ACTION", value: '[{"payload":"$1:__proto__:then"}]' }]);
    const r = inspectRequestBody(MULTIPART(body));
    expect(r?.attack).toBe("react2shell");
  });

  it("blocks a Flight reference paired with constructor:constructor", () => {
    const body = "0:$2:constructor:constructor\n1:$1:a:b";
    const r = inspectRequestBody({ method: "POST", contentType: "text/plain;charset=UTF-8", truncated: false, body });
    expect(r?.attack).toBe("react2shell");
  });
});

describe("React2Shell - benign near-misses that MUST pass", () => {
  it("a real Next.js Server Action (Next-Action header, ordinary Flight body) is untouched", () => {
    // Legitimate Flight data carries $N references but never the prototype-chain
    // traversal token, so the Next-Action header alone never triggers a block.
    const body = multipart([{ name: "1_$ACTION_abc123", value: '[{"id":42,"name":"Nick"}]' }]);
    expect(inspectRequestBody(MULTIPART(body))).toBeNull();
  });

  it("a plain JSON body that merely mentions __proto__ (no Flight reference) is untouched", () => {
    const body = JSON.stringify({ note: "we sanitize __proto__ and prototype keys" });
    expect(inspectRequestBody({ method: "POST", contentType: "text/plain", truncated: false, body })).toBeNull();
  });
});

describe("bodyInspectionApplies - the read gate", () => {
  it("applies to multipart and urlencoded POSTs", () => {
    expect(bodyInspectionApplies("POST", "multipart/form-data; boundary=x", false)).toBe(true);
    expect(bodyInspectionApplies("POST", "application/x-www-form-urlencoded", false)).toBe(true);
  });
  it("applies to a POST carrying a next-action header even for text/plain", () => {
    expect(bodyInspectionApplies("POST", "text/plain", true)).toBe(true);
  });
  it("does not apply to a GET or to an application/json POST without next-action", () => {
    expect(bodyInspectionApplies("GET", "multipart/form-data", false)).toBe(false);
    expect(bodyInspectionApplies("POST", "application/json", false)).toBe(false);
  });
});

describe("bounds + safety", () => {
  it("exposes a constant scan cap", () => {
    expect(BODY_SCAN_CAP_BYTES).toBe(262_144);
  });
  it("never throws on a malformed input and returns null", () => {
    const weird = { method: "POST", contentType: "multipart/form-data; boundary=", truncated: true, body: "garbage without parts" } as BodyInspectInput;
    expect(inspectRequestBody(weird)).toBeNull();
  });
  it("an empty body is null", () => {
    expect(inspectRequestBody({ method: "POST", contentType: "multipart/form-data; boundary=x", truncated: false, body: "" })).toBeNull();
  });
});
