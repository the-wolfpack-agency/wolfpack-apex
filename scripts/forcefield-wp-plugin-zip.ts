/**
 * Build the WordPress plugin zip for the WordPress.org directory submission.
 *
 *   npm run forcefield:wp-plugin-zip            # -> dist/wordpress/ogiam-forcefield-<version>.zip
 *   npm run forcefield:wp-plugin-zip -- --out <dir>
 *
 * Same zip writer as the in-app download (src/lib/forcefield-web/wordpress-plugin-zip.ts),
 * from the one plugin source. Checks before writing: the readme.txt Stable tag
 * matches the plugin Version, and the changelog has an entry for it (the same
 * rules src/lib/forcefield-web/__tests__/wordpress-readme.test.ts pins).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPluginZip, pluginSourceDir, PLUGIN_SLUG } from "@/lib/forcefield-web/wordpress-plugin-zip";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = resolve(__dirname, "..");
const { zip, version, files } = buildPluginZip(root);
const readme = readFileSync(join(pluginSourceDir(root), "readme.txt"), "utf8");
const stable = readme.match(/Stable tag:\s*([0-9.]+)/)?.[1];
if (stable !== version) {
  console.error(`readme.txt Stable tag (${stable}) does not match the plugin Version (${version}).`);
  process.exit(1);
}
if (!readme.slice(readme.indexOf("== Changelog ==")).includes(`= ${version} =`)) {
  console.error(`readme.txt has no changelog entry for ${version}.`);
  process.exit(1);
}
const out = resolve(arg("out") ?? join(root, "dist", "wordpress"));
mkdirSync(out, { recursive: true });
const file = join(out, `${PLUGIN_SLUG}-${version}.zip`);
writeFileSync(file, zip);
console.log(`${file} (${zip.length} bytes): ${files.join(", ")}`);
