/**
 * Assertion helpers for the ENVIRONMENT-NEUTRAL test suites (the FileStore
 * contract cases, the ported store cases, the golden sequence).
 *
 * Not vitest's expect, on purpose: these suites are bundled by Vite and run
 * INSIDE Chromium against the OPFS driver, where vitest does not exist. The
 * node runners wrap each case in an it() and let a thrown Error fail it, so
 * one implementation of "what failed and how" serves both lanes — the same
 * case list, the same messages, whichever driver is underneath.
 */
import { stableStringify } from '../../src/shared/util';

export function ok(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** Deep equality via stable stringification — key order never a difference. */
export function eq(actual: unknown, expected: unknown, message: string): void {
  const a = stableStringify(actual);
  const e = stableStringify(expected);
  if (a !== e) {
    throw new Error(`${message}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

/** Strict === for primitives, with both values in the failure. */
export function is(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\n  actual:   ${String(actual)}\n  expected: ${String(expected)}`);
  }
}

export function includes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${message}\n  expected to contain: ${needle}\n  got: ${haystack}`);
  }
}

/** The promise must reject; returns the error for further checks. */
export async function rejects(
  promise: Promise<unknown>,
  message: string,
  match?: { instanceOf?: abstract new (...args: never[]) => unknown; msgIncludes?: string },
): Promise<Error> {
  let err: unknown = null;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (e) {
    err = e;
  }
  if (resolved) throw new Error(`${message}: expected rejection, got resolution`);
  if (match?.instanceOf && !(err instanceof match.instanceOf)) {
    throw new Error(
      `${message}: rejected with ${String((err as Error)?.constructor?.name)}, expected ${match.instanceOf.name} (${String(err)})`,
    );
  }
  if (match?.msgIncludes !== undefined) {
    includes(String((err as Error)?.message ?? err), match.msgIncludes, message);
  }
  return err as Error;
}

/** The sync function must throw; returns the error for further checks. */
export function throws(fn: () => unknown, message: string, msgIncludes?: string): Error {
  try {
    fn();
  } catch (e) {
    if (msgIncludes !== undefined) includes(String((e as Error)?.message ?? e), msgIncludes, message);
    return e as Error;
  }
  throw new Error(`${message}: expected a throw, got a return`);
}
