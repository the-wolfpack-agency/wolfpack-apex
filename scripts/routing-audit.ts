/**
 * Print the routing score.
 *
 *   npx tsx scripts/routing-audit.ts
 *   npm run assistant:routing
 *
 * THE LOGIC LIVES IN src/lib/assistant/routing-audit.ts, so this script, the
 * ratchet test and the /admin/insights panel cannot drift apart. Re-exported
 * here because existing importers point at this path.
 */
import { auditRouting, AUDIT_PROMPTS, type RoutingResult } from "../src/lib/assistant/routing-audit";

export { auditRouting, AUDIT_PROMPTS };
export type { RoutingResult };

async function main() {
  const r = await auditRouting();
  const pct = ((r.reachedOne / r.total) * 100).toFixed(0);
  console.log(`\nRouting audit: ${r.total} prompts\n`);
  console.log(`  reached exactly one tool   ${String(r.reachedOne).padStart(3)}  (${pct}%)`);
  console.log(`  reached nothing            ${String(r.reachedNone).padStart(3)}`);
  console.log(`  reached more than one      ${String(r.reachedMany).padStart(3)}`);

  console.log(`\n  by group (gaps show up as clusters)`);
  for (const [g, v] of Object.entries(r.byGroup)) {
    const bar = v.none === 0 ? "ok" : `${v.none}/${v.total} unreachable`;
    console.log(`    ${g.padEnd(13)} ${bar}`);
  }

  if (r.none.length) {
    console.log(`\n  --- reached nothing ---`);
    r.none.forEach((p) => console.log(`    ${p}`));
  }
  if (r.many.length) {
    console.log(`\n  --- more than one claimant (may be fine) ---`);
    r.many.forEach((m) => console.log(`    ${m.prompt}  ->  ${m.tools.join(", ")}`));
  }
  console.log("");
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error("[routing-audit]", (e as Error).message);
      process.exit(1);
    },
  );
}
