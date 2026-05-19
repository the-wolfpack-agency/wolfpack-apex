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
