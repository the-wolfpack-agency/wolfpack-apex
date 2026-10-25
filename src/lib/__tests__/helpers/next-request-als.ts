/**
 * Next.js reads AsyncLocalStorage from globalThis (its server runtime installs
 * it). Jest does not, so Next's request storage would be a stub that throws on
 * run(). Import this FIRST in a test that needs to simulate a Next request.
 */
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as unknown as { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;

export {};
