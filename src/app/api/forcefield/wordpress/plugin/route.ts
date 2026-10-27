/**
 * GET /api/forcefield/wordpress/plugin - the Forcefield WordPress plugin zip.
 *
 * PUBLIC: the plugin is a public download (the same file goes to the
 * WordPress.org directory); it carries no key, account or secret. Built on
 * request from the one plugin source (integrations/wordpress/ogiam-forcefield/,
 * pinned into the function bundle in next.config.ts) by the same zip writer the
 * directory build script uses, so the download can never drift from the source.
 */
import { NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics";
import { buildPluginZip, PLUGIN_SLUG } from "@/lib/forcefield-web/wordpress-plugin-zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUBLIC: a public file download; see the file header.
export async function GET(): Promise<NextResponse> {
  try {
    const { zip, version } = buildPluginZip();
    void trackEvent("forcefield.wordpress_plugin_downloaded", "anonymous", "public", { version });
    return new NextResponse(new Uint8Array(zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${PLUGIN_SLUG}.zip"`,
        "Cache-Control": "public, max-age=300",
        "X-Plugin-Version": version,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}
