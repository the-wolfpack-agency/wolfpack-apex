/**
 * Read a folder of design-spec images into text, using the Azure Vision OCR
 * this platform already has.
 *
 * WHY THIS EXISTS
 *
 * A client sent an updated spec as 14 PNGs. Reading them by eye hits an image
 * limit partway through, and the reflex was to write a throwaway OCR script in
 * /tmp — while `ocrImage` had been sitting in src/lib/azure/vision-ocr.ts the
 * whole time, wired into the assistant that same day.
 *
 * Design updates arrive as images every time. That makes this a repeatable
 * execution, and repeatable executions belong in the repo rather than being
 * rebuilt from scratch whenever one shows up.
 *
 * WHY IT LIVES IN THIS REPO
 *
 * The Azure credentials are here (AZURE_COGNITIVE_ENDPOINT / _KEY). A client
 * site has none and should not gain any — the platform holds the tooling, the
 * client repo holds the product. Point --dir at any folder on disk.
 *
 * USAGE
 *   npm run spec:read -- --dir ~/Downloads/FOR_REVIEW
 *   npm run spec:read -- --dir ~/Downloads/FOR_REVIEW --json
 *
 * Reads PNG/JPG/PDF, in sorted order, skipping anything the Vision cap rejects
 * rather than aborting the run — one oversized image should not cost you the
 * other thirteen.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { ocrImage, isVisionConfigured, VISION_MAX_BYTES } from "../src/lib/azure/vision-ocr";

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = argv.includes("--json");

const dir = flag("dir");
if (!dir) {
  console.error("--dir <folder> is required, e.g. --dir ~/Downloads/FOR_REVIEW");
  process.exit(1);
}
if (!isVisionConfigured()) {
  console.error(
    "Azure Vision is not configured. Needs AZURE_VISION_ENDPOINT/_KEY or\n" +
      "AZURE_COGNITIVE_ENDPOINT/_KEY. Pull them with: npx vercel env pull",
  );
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/** Every readable file under dir, one level of subfolders included, sorted so
 *  numbered spec screens come out in the order the designer numbered them. */
function specFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      for (const sub of readdirSync(full).sort()) {
        if (MIME[extname(sub).toLowerCase()]) out.push(join(full, sub));
      }
    } else if (MIME[extname(entry).toLowerCase()]) {
      out.push(full);
    }
  }
  return out;
}

const files = specFiles(dir.replace(/^~/, process.env.HOME ?? "~"));
if (files.length === 0) {
  console.error(`No readable images under ${dir}`);
  process.exit(1);
}

const results: { file: string; ok: boolean; text: string; reason?: string }[] = [];

for (const file of files) {
  const bytes = readFileSync(file);
  if (bytes.length > VISION_MAX_BYTES) {
    /* Skipped, not fatal: one oversized screen should not cost the rest. Say so
       loudly, because a silently missing screen is a missing requirement. */
    results.push({
      file,
      ok: false,
      text: "",
      reason: `${(bytes.length / 1024 / 1024).toFixed(1)} MB exceeds the ${(VISION_MAX_BYTES / 1024 / 1024).toFixed(1)} MB Vision cap — downscale it and re-run`,
    });
    continue;
  }
  const res = await ocrImage(bytes, {
    triggeredBy: "spec:read",
    triggeredByRole: "system",
    contentType: MIME[extname(file).toLowerCase()],
  });
  results.push(
    res.ok
      ? { file, ok: true, text: (res.text ?? "").trim() }
      : { file, ok: false, text: "", reason: res.detail || res.reason },
  );
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`\n${"=".repeat(70)}\n${r.file}\n${"=".repeat(70)}`);
    console.log(r.ok ? r.text : `  COULD NOT READ: ${r.reason}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} screens read.` +
      (failed.length ? ` ${failed.length} could not be read — see above.` : ""),
  );
}

/* Non-zero when anything was unreadable, so a caller cannot mistake a partial
   read for a complete spec. */
process.exit(results.some((r) => !r.ok) ? 1 : 0);
