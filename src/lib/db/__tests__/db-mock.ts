/**
 * One faithful mock of @/lib/db, so a test double cannot silently omit an export.
 *
 * WHY THIS EXISTS
 *
 * 274 test files mock @/lib/db by hand, each listing the two or three exports it
 * happens to need. That works right up until the module under test starts using
 * a fourth, at which point the mock returns `undefined` and the test fails with
 * "is not a function" somewhere unrelated to the change that caused it.
 *
 * That is exactly what happened when per-client database routing landed:
 * `activePool()` replaced direct `pool` use in nine runtime modules, and 46
 * mocks had to be corrected. Three of them were worse than incomplete — they
 * spread `jest.requireActual` and overrode the `pool` EXPORT, which does
 * nothing, because activePool() closes over the module-internal pool. Those
 * tests opened real sockets and failed on SASL rather than on a wrong value.
 *
 * The lesson is the one this codebase keeps relearning: a double that does not
 * model the thing it doubles will eventually validate a mistake instead of
 * catching one. So new tests get a complete mock by construction, and the
 * fidelity test next door proves it stays complete as db.ts changes.
 *
 * USAGE
 *
 *   jest.mock("@/lib/db", () => makeDbMock({ safeQuery: mySafeQuery }));
 *
 * Everything not overridden is present and inert: queries resolve empty, writes
 * throw the same typed error the real module throws with no database, and the
 * pool accessors return a client that records nothing. Nothing reaches a socket.
 *
 * Not a test file itself — jest's testMatch only collects *.test.ts.
 */

/** A pg client that satisfies the interface and does nothing. */
export function inertClient() {
  return {
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    release: jest.fn(),
  };
}

/** A pool whose connect() hands back an inert client. */
export function inertPool() {
  const client = inertClient();
  return {
    connect: jest.fn(async () => client),
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    end: jest.fn(async () => {}),
    on: jest.fn(),
  };
}

/**
 * A complete mock of @/lib/db.
 *
 * `overrides` is applied last, so a test replaces only what it cares about and
 * inherits a working shape for everything else — including exports added to
 * db.ts after the test was written, which is the whole point.
 */
export function makeDbMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pool = inertPool();

  class WriteQueryError extends Error {
    readonly code: string;
    constructor(message: string, code = "no_database") {
      super(message);
      this.name = "WriteQueryError";
      this.code = code;
    }
  }

  return {
    // Reads: empty rather than throwing, matching shadow mode.
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
    safeQuery: jest.fn(async () => ({ rows: [], fromCache: true })),

    // Writes: the real module refuses without a database, and a mock that
    // silently succeeds would let a test assert a write that never happened.
    writeQuery: jest.fn(async () => {
      throw new WriteQueryError("writeQuery called in a test with no database mock");
    }),
    withTransaction: jest.fn(async () => {
      throw new WriteQueryError("withTransaction called in a test with no database mock");
    }),
    WriteQueryError,

    // Pools. BOTH are provided: overriding only `pool` does not change what
    // activePool() returns in the real module, so a mock that offers one and
    // not the other teaches a false lesson about which one matters.
    pool,
    activePool: jest.fn(() => pool),
    hasDatabase: jest.fn(() => true),

    // Scopes. Default to "not inside one", which is the common case, and run
    // the callback so a test never hangs waiting for a scope that never opens.
    activeWorkspaceScope: jest.fn(() => undefined),
    withWorkspaceScope: jest.fn(async (_workspaceId: string, fn: () => Promise<unknown>) => fn()),
    activeTenant: jest.fn(() => undefined),
    withTenant: jest.fn(async (_tenantId: string, fn: () => Promise<unknown>) => fn()),

    normalizeDatabaseUrlSsl: jest.fn((url?: string) => url),

    ...overrides,
  };
}
