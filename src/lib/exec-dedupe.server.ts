/**
 * In-flight request de-duplication for evaluation and submission.
 *
 * Double clicks, browser/network retries and React re-renders can send the
 * exact same evaluation twice. Instead of compiling and running the same
 * program twice on the Piston VMs, the second caller joins the evaluation that
 * is already running and receives its result.
 */
const inFlight = new Map<string, Promise<unknown>>();

/** Cheap, stable, non-cryptographic fingerprint of a source buffer. */
export function fingerprint(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}:${value.length}`;
}

/**
 * Runs `fn` once per key while a call with that key is still in flight.
 * The entry is cleared as soon as the work settles, so a later, deliberate
 * re-evaluation of the same code always executes again.
 */
export function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    console.info(`[dedupe] joined in-flight request ${key}`);
    return existing as Promise<T>;
  }
  const promise = fn().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
