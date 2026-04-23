/**
 * Unit tests for src/lib/instinct-flags.ts — env-flag parsing + default-on
 * semantics for the Teams write gate.
 */

import { isTeamsWriteEnabled } from "@/lib/instinct-flags";

const ENV_KEY = "INSTINCT_TEAMS_WRITE_ENABLED";

function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env[ENV_KEY];
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = prev;
    }
  }
}

describe("isTeamsWriteEnabled", () => {
  it("defaults to true when env is unset (internal deployment)", () => {
    withEnv(undefined, () => {
      expect(isTeamsWriteEnabled()).toBe(true);
    });
  });

  it("returns true when env is empty string", () => {
    withEnv("", () => {
      expect(isTeamsWriteEnabled()).toBe(true);
    });
  });

  it("returns true when env is 'true'", () => {
    withEnv("true", () => {
      expect(isTeamsWriteEnabled()).toBe(true);
    });
  });

  it("returns true when env is 'TRUE' (case-insensitive)", () => {
    withEnv("TRUE", () => {
      expect(isTeamsWriteEnabled()).toBe(true);
    });
  });

  it("returns false when env is exactly 'false'", () => {
    withEnv("false", () => {
      expect(isTeamsWriteEnabled()).toBe(false);
    });
  });

  it("returns false when env is 'FALSE' (case-insensitive)", () => {
    withEnv("FALSE", () => {
      expect(isTeamsWriteEnabled()).toBe(false);
    });
  });

  it("returns false when env is '0'", () => {
    withEnv("0", () => {
      expect(isTeamsWriteEnabled()).toBe(false);
    });
  });

  it("returns true for garbage values (fail-open to enabled)", () => {
    withEnv("whatever", () => {
      expect(isTeamsWriteEnabled()).toBe(true);
    });
  });

  it("returns true for '1'", () => {
    withEnv("1", () => {
      expect(isTeamsWriteEnabled()).toBe(true);
    });
  });

  it("returns true for whitespace-padded 'true'", () => {
    withEnv("  true  ", () => {
      expect(isTeamsWriteEnabled()).toBe(true);
    });
  });

  it("returns false for whitespace-padded 'false'", () => {
    withEnv("  false  ", () => {
      expect(isTeamsWriteEnabled()).toBe(false);
    });
  });
});
