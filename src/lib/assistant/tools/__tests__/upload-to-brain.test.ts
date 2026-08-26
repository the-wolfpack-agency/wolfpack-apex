/**
 * upload-to-brain tool — intent matching + handler returns the right
 * UploadToBrainWidgetSpec.
 */

const mockTrackEvent = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import {
  matchUploadToBrainIntent,
  uploadToBrainTool,
} from "@/lib/assistant/tools/upload-to-brain";
import {
  UPLOAD_FILTER_ALLOWED_MIME_TYPES,
  UPLOAD_FILTER_MAX_FILE_SIZE_BYTES,
} from "@/lib/brain/upload-filter";

const CTX = { userId: "u1", userRole: "cto" };

beforeEach(() => mockTrackEvent.mockReset());

describe("upload-to-brain intent matching", () => {
  test.each([
    "/upload",
    "upload",
    "upload to brain",
    "/upload to brain",
    "Upload to Brain",
    "/Upload",
    "I want to upload",
    "i want to upload something",
    "i would like to upload a file",
    "let me upload",
    "how do i upload",
    "how do I upload files",
  ])("'%s' matches", (q) => {
    expect(matchUploadToBrainIntent(q)).not.toBeNull();
  });

  test.each([
    "",
    "what is uploaded?",
    "search for upload logs",
    "upload https://example.com/foo.pdf",
    "upload /Users/nick/notes.md",
    "show me uploaded files",
    "uploads dashboard",
  ])("'%s' does NOT match", (q) => {
    expect(matchUploadToBrainIntent(q)).toBeNull();
  });
});

describe("upload-to-brain handler", () => {
  test("returns the upload_to_brain widget spec with config from upload-filter", async () => {
    const res = await uploadToBrainTool.handler({}, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.widget).toBeDefined();
    expect(res.widget!.kind).toBe("upload_to_brain");
    const spec = res.widget as {
      kind: "upload_to_brain";
      uploadUrl: string;
      maxFileSize: number;
      allowedMimeTypes: readonly string[];
    };
    expect(spec.uploadUrl).toBe("/api/brain/upload");
    expect(spec.maxFileSize).toBe(UPLOAD_FILTER_MAX_FILE_SIZE_BYTES);
    expect(spec.allowedMimeTypes).toEqual(UPLOAD_FILTER_ALLOWED_MIME_TYPES);
  });

  test("handler answer is a short prompt to drop files", async () => {
    const res = await uploadToBrainTool.handler({}, CTX);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.answer).toMatch(/drop files/i);
    expect(res.sources).toEqual([]);
  });

  test("fires assistant.widget_offered analytics with widget_kind", async () => {
    await uploadToBrainTool.handler({}, CTX);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "cto",
      expect.objectContaining({ widget_kind: "upload_to_brain" }),
    );
  });

  test("forwards workflow_id when provided", async () => {
    await uploadToBrainTool.handler({}, { ...CTX, workflowId: "wf-1" });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "cto",
      expect.objectContaining({ workflow_id: "wf-1" }),
    );
  });

  test("tool metadata: name + capability + description", () => {
    expect(uploadToBrainTool.name).toBe("upload_to_brain");
    expect(uploadToBrainTool.capability).toBe("brain.ingest");
    expect(uploadToBrainTool.description.length).toBeGreaterThan(20);
  });
});

/**
 * The way people actually ask to put a document in.
 *
 * A prompt sweep on 2026-08-26 found that "upload a document to the brain"
 * and "add this file to the knowledge base" reached NO tool at all. Only the
 * bare "upload to brain", the "/upload" slash form, and a few "I want to
 * upload" openers worked.
 *
 * This is the path a client engagement opens with: phase one is their library
 * read into the Brain, so the first thing anybody tries is putting a document
 * in, named, with the destination said out loud. That sentence did nothing.
 */
describe("the sentences somebody actually types", () => {
  it.each([
    "upload a document to the brain",
    "add this file to the knowledge base",
    "put this doc in the brain",
    "save the contract to the library",
    "please add this pdf to the knowledge base",
  ])("claims %s", (prompt) => {
    expect(matchUploadToBrainIntent(prompt)).not.toBeNull();
  });

  /* THE DESTINATION IS THE TELL, and it is required rather than optional.
     Without that, an upload verb alone claims sentences about other places. */
  it.each([
    "upload the deck to Dropbox",
    "add this to my calendar",
    "send the invoice to the client",
    "put the notes in the shared folder",
  ])("leaves %s alone", (prompt) => {
    expect(matchUploadToBrainIntent(prompt)).toBeNull();
  });

  /* A URL or a path is the ingest-from-source flow, not this one. The guard
     predates this change and must survive it. */
  it("still defers a URL to the ingest flow", () => {
    expect(matchUploadToBrainIntent("upload https://x.example/a.pdf to the brain")).toBeNull();
  });
});
