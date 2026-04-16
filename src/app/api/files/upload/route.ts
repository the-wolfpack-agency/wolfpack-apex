/**
 * POST /api/files/upload — single-PUT small-file upload (< 4 MB).
 *
 * Accepts multipart/form-data with:
 *   file      — the File blob
 *   parentId  — Graph parent folder id, or "root"
 *   filename  — overrides file.name if provided
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  uploadSmallFile,
  SMALL_UPLOAD_MAX_BYTES,
  GraphFilesError,
} from "@/lib/integrations/microsoft-files";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = form.get("file");
  const parentId = (form.get("parentId") as string | null) || "root";
  const filenameOverride = (form.get("filename") as string | null) || null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (file.size > SMALL_UPLOAD_MAX_BYTES) {
    return NextResponse.json(
      { error: "File exceeds small-upload limit — use /api/files/upload-session" },
      { status: 413 },
    );
  }

  const filename = filenameOverride || file.name;
  if (!filename || filename.includes("/") || filename.includes("\\")) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const out = await uploadSmallFile(
      user.id,
      parentId,
      filename,
      file.type || "application/octet-stream",
      buffer,
      { user_id: user.id, role: user.role },
    );
    return NextResponse.json({ file: out }, { status: 201 });
  } catch (err) {
    if (err instanceof GraphFilesError) {
      if (err.status === 401) return NextResponse.json({ error: "Microsoft not connected" }, { status: 401 });
      if (err.status === 403) return NextResponse.json({ error: "scope_missing", scope: "Files.ReadWrite" }, { status: 403 });
      if (err.status === 429) {
        return NextResponse.json(
          { error: "Microsoft Graph rate limit" },
          { status: 429, headers: err.retryAfter ? { "Retry-After": String(err.retryAfter) } : undefined },
        );
      }
      return NextResponse.json({ error: err.message }, { status: err.status >= 500 ? 502 : err.status });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
