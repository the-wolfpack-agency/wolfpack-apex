/** @jest-environment node */
/**
 * Our own live proofs must never count as real attacks. Proof runs sent without the synthetic
 * header were once recorded as real attacks on the board, in the digest and in replays. Every script that sends attack-shaped traffic at a live site must send
 * x-forcefield-synthetic and refuse to run without FORCEFIELD_SYNTHETIC_TOKEN.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Scripts that send attack-shaped requests at a deployed site. Add any new one here. */
const LIVE_ATTACK_SENDERS = ["scripts/forcefield-redteam.ts", "scripts/competitive-benchmark.mjs"];

describe("live Forcefield proofs are marked as our own traffic", () => {
  it.each(LIVE_ATTACK_SENDERS)("%s sends the synthetic header", (p) => {
    const src = read(p);
    expect(src).toMatch(/SYNTHETIC_HEADER|x-forcefield-synthetic/);
    expect(src).toMatch(/FORCEFIELD_SYNTHETIC_TOKEN/);
  });

  it("the red-team refuses without the token and reads back unmarked rows", () => {
    const src = read("scripts/forcefield-redteam.ts");
    expect(src).toMatch(/SYNTHETIC_TOKEN\.length < 32\)[\s\S]{0,300}return 2/);
    expect(src).toMatch(/\[SYNTHETIC_HEADER\]: SYNTHETIC_TOKEN/);
    expect(src).toMatch(/unmarkedProofRows\(/);
  });

  it("no other script fetches a corpus of attack shapes without being listed", () => {
    const { readdirSync } = jest.requireActual("node:fs") as typeof import("node:fs");
    const senders = readdirSync(join(root, "scripts"))
      .filter((f) => /\.(ts|mjs|js)$/.test(f))
      .filter((f) => { const s = read(`scripts/${f}`); return /ADVERSARIAL_CORPUS|EXPLOIT_SHAPES/.test(s) && /fetch\(/.test(s); })
      .map((f) => `scripts/${f}`);
    for (const s of senders) expect(LIVE_ATTACK_SENDERS).toContain(s);
  });
});
