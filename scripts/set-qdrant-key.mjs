#!/usr/bin/env node
/**
 * Set the Qdrant API key in .env.local, verify it, and say what happened.
 *
 * WHY A SCRIPT AND NOT A SHELL COMMAND. Three attempts at this as a one-liner
 * failed in three different ways: a variable name reused between two commands
 * leaked the string "AZURE_OPENAI_EMBEDDING_DEPLOYMENT" into the key, `read -p`
 * is bash and this shell is zsh, and an `&&` chain stopped halfway leaving the
 * file with TWO QDRANT_API_KEY lines. None of those were the operator's doing.
 *
 * The failure mode they share is that a shell one-liner reports success from
 * whichever part of it ran. This reads once, checks what it got, writes once,
 * and then asks the cluster whether the key actually works, which is the only
 * question that matters.
 *
 * NEVER PRINTS THE KEY. Length and a masked fragment only, so a terminal
 * scrollback or a pasted log cannot leak it.
 *
 *   node scripts/set-qdrant-key.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const ENV_FILE = ".env.local";

/** Values that are obviously not a key, each seen for real during this. */
function rejectReason(value) {
  if (!value) return "nothing was entered";
  if (/\s/.test(value)) return "it contains whitespace, so it is probably not just the key";
  if (value === "AZURE_OPENAI_EMBEDDING_DEPLOYMENT" || /^[A-Z][A-Z0-9_]{6,}$/.test(value)) {
    return "that is a variable NAME, not a key. This exact value leaked in once already";
  }
  if (value.length < 20) return `only ${value.length} characters, which is too short for a Qdrant key`;
  return null;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    /* Hide the paste. Not muted output, because a terminal that echoes nothing
       at all makes people think it is hung and press enter twice, which is how
       an empty value gets written. A single line of dots shows it is taking
       input without showing what. */
    const onData = (char) => {
      if (["\n", "\r", ""].includes(char.toString())) return;
      process.stdout.write("*");
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.off("data", onData);
      process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function verify(key) {
  const url = (process.env.QDRANT_URL ?? "").replace(/\/+$/, "");
  if (!url) return { ok: false, detail: "QDRANT_URL is not set, so there is nothing to verify against" };
  try {
    const res = await fetch(`${url}/collections`, { headers: { "api-key": key } });
    if (res.ok) {
      const body = await res.json();
      const names = (body?.result?.collections ?? []).map((c) => c.name);
      return { ok: true, detail: `cluster answers, ${names.length} collection(s): ${names.join(", ")}` };
    }
    return { ok: false, detail: `cluster refused it: HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: `could not reach the cluster: ${e.message}` };
  }
}

async function main() {

  /* Loaded for QDRANT_URL only, so the key can be checked before it is kept. */
  const { config } = await import("dotenv");
  config({ path: ENV_FILE });

  const key = await ask("Paste the Qdrant API key (input is hidden): ");
  const bad = rejectReason(key);
  if (bad) {
    console.error(`\nRefused: ${bad}.`);
    console.error("Nothing was written. The file is unchanged.");
    process.exit(1);
  }

  /* VERIFIED BEFORE IT IS WRITTEN. Writing first and checking after is how the
     file ended up holding two dead keys. */
  process.stdout.write("Checking it against the cluster... ");
  const check = await verify(key);
  console.log(check.ok ? "works." : "no.");
  console.log(`  ${check.detail}`);
  if (!check.ok) {
    console.error("\nNot written, because a key the cluster refuses is worse than none:");
    console.error("it looks configured and fails silently, keyword-only, with every count still green.");
    process.exit(1);
  }

  /* READ ONCE, then write. This checked existsSync first and read later, which
     CodeQL flagged as a check-then-use race and was right to: between the two
     the file can be moved, and the check adds nothing a failed read does not
     say better. A missing file now reports itself, at the moment it matters. */
  let current;
  try {
    current = readFileSync(ENV_FILE, "utf8");
  } catch (e) {
    console.error(`Could not read ${ENV_FILE}: ${e.message}`);
    console.error("Run this from the repository root.");
    process.exit(2);
  }

  writeFileSync(`${ENV_FILE}.bak`, current);
  const kept = current
    .split("\n")
    /* EVERY existing line, not the first. The file currently holds two, and a
       replace that removes one leaves the other deciding the value. */
    .filter((line) => !/^QDRANT_API_KEY=/.test(line));
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  kept.push(`QDRANT_API_KEY=${key}`, "");
  writeFileSync(ENV_FILE, kept.join("\n"));

  console.log(`\nWritten to ${ENV_FILE} (${key.length} chars, ${key.slice(0, 3)}...${key.slice(-3)}).`);
  console.log(`Previous contents saved to ${ENV_FILE}.bak.`);
  console.log("\nStill to do, because this script deliberately does not touch GitHub:");
  console.log("  gh secret set QDRANT_API_KEY     (paste the same key)");
  console.log("  npm run check:credentials        (confirms everything at once)");
}

main().catch((err) => {
  console.error("failed:", err.message);
  process.exit(1);
});
