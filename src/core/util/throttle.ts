/**
 * Per-key rate limiter.
 *
 * A live transcript is written to many times a second; the UI only needs to
 * know that something is happening. `now` is injectable so the behaviour can
 * be tested without sleeping.
 */
export function createThrottle(intervalMs: number): (key: string, now?: number) => boolean {
  const last = new Map<string, number>();
  return (key: string, now = Date.now()): boolean => {
    const previous = last.get(key);
    if (previous !== undefined && now - previous < intervalMs) return false;
    last.set(key, now);
    return true;
  };
}
