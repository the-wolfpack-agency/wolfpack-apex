import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  generateApiDoc,
  generateFeatureDoc,
  generateReleaseNotes,
  saveDocument,
  getDocuments,
} from "@/lib/doc-generator";

/**
 * GET /api/docs — List generated documents.
 *
 * Query params:
 *   ?doc_type=api_doc   — filter by type
 *   ?mine=true          — only my docs
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "docs.view");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const url = new URL(req.url);
  const docType = url.searchParams.get("doc_type") ?? undefined;
  const mine = url.searchParams.get("mine");

  try {
    const docs = await getDocuments(mine === "true" ? user.id : undefined, docType);
    return NextResponse.json({ documents: docs });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/docs — Generate a document.
 *
 * Body: { type: "api_doc" | "feature_doc" | "release_notes", ...params }
 *
 * For api_doc:       { repo_path, file_path }
 * For feature_doc:   { feature_request_id }
 * For release_notes: { repo_path, since_date }
 */
export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "docs.generate");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const body = await req.json();
    const { type, repo_path, file_path, feature_request_id, since_date, save } = body as {
      type?: string;
      repo_path?: string;
      file_path?: string;
      feature_request_id?: string;
      since_date?: string;
      save?: boolean;
    };

    if (!type) {
      return NextResponse.json({ error: "type is required" }, { status: 400 });
    }

    let doc;

    switch (type) {
      case "api_doc":
        if (!repo_path || !file_path) {
          return NextResponse.json({ error: "repo_path and file_path are required" }, { status: 400 });
        }
        doc = generateApiDoc(repo_path, file_path);
        break;

      case "feature_doc":
        if (!feature_request_id) {
          return NextResponse.json({ error: "feature_request_id is required" }, { status: 400 });
        }
        doc = await generateFeatureDoc(feature_request_id);
        break;

      case "release_notes":
        if (!repo_path || !since_date) {
          return NextResponse.json({ error: "repo_path and since_date are required" }, { status: 400 });
        }
        doc = generateReleaseNotes(repo_path, since_date);
        break;

      default:
        return NextResponse.json({ error: `Unknown doc type: ${type}` }, { status: 400 });
    }

    trackEvent("knowledge.doc_generated", user.id, user.role, {
      doc_type: type,
      tokens_used: 0,
    });

    // Optionally persist
    if (save) {
      const saved = await saveDocument(
        {
          title: doc.title,
          doc_type: doc.doc_type,
          content: doc.content,
          format: doc.format,
          generated_from: doc.generated_from,
          generated_by: user.id,
          tokens_used: 0,
        },
        user.id,
      );
      if (saved) doc = saved;
    }

    return NextResponse.json({ document: doc, tokens_used: 0 });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
