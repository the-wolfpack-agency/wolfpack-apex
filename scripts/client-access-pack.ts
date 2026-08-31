/**
 * The document a client reads before their deployment can start.
 *
 * Generated from the scope list the product actually requests, so it cannot
 * drift from the Microsoft consent screen their administrator will see. A
 * security review that approves one list and then meets another is where trust
 * goes, and it happens by drift rather than by intent.
 *
 * Usage:
 *   npx tsx scripts/client-access-pack.ts              # phase one
 *   npx tsx scripts/client-access-pack.ts --all        # including later phases
 *   npx tsx scripts/client-access-pack.ts --out FILE   # write it somewhere
 */
import "./load-env";

import { writeFileSync } from "node:fs";
import { accessPackMarkdown, adminConsentRequests } from "@/lib/deployment/access-pack";

function main() {
  const phase = process.argv.includes("--all") ? ("all" as const) : (1 as const);
  const md = accessPackMarkdown(phase);

  const outIndex = process.argv.indexOf("--out");
  if (outIndex > -1 && process.argv[outIndex + 1]) {
    writeFileSync(process.argv[outIndex + 1], `${md}\n`);
    console.log(`wrote ${process.argv[outIndex + 1]}`);
  } else {
    console.log(md);
  }

  /* Printed to stderr so it never lands in a document handed to a client, and
     said every time because it is the one thing an account manager needs to
     know before the meeting: the short list of things only an administrator
     can approve. */
  console.error(
    `\n[${adminConsentRequests().length} of these need a Microsoft 365 administrator. ` +
      `All are switched OFF today and the deployment works without them.]`,
  );
}

main();
