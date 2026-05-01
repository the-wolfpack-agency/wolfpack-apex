/* Tiny shim re-exporting the parser's slugify() so the store can use
 * it without pulling in mammoth-adjacent imports at module load. */
export { slugify as slugifyForStore } from "@/lib/principles/parser";
