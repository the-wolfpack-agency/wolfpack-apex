/**
 * Smoke coverage for types.ts — ensures the MIME classifier stays
 * locked to the migration's CHECK constraint. If a kind is added here
 * without adding it to 028_central_brain.sql, the DB insert will fail
 * at runtime; this test is a cheap guardrail that catches the drift.
 */
import { classifyKind } from "../types";

const KINDS_IN_MIGRATION = [
  "pdf", "docx", "text", "markdown", "csv", "html",
  "audio", "video", "image", "email", "other",
] as const;

describe("types classifier <-> migration alignment", () => {
  it("classifyKind only ever returns kinds listed in the CHECK constraint", () => {
    const samples: Array<[string, string]> = [
      ["application/pdf", "x.pdf"],
      ["text/plain", "x.txt"],
      ["text/markdown", "x.md"],
      ["audio/wav", "x.wav"],
      ["application/unknown", "x.bin"],
    ];
    for (const [mime, name] of samples) {
      const kind = classifyKind(mime, name);
      expect(KINDS_IN_MIGRATION).toContain(kind);
    }
  });
});
