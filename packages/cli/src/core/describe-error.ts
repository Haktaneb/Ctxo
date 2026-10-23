/**
 * Text for a thrown value, safe for a log line or an error payload. It never throws: a non-Error throw
 * (a string, a null-prototype object, a value with a hostile `message` or `toString`) still gives a string.
 */
export function describeError(err: unknown): string {
  try {
    if (err instanceof Error) {
      const message = err.message;
      if (typeof message === 'string') return message;
    }
    if (typeof err === 'string') return err;
    return String(err);
  } catch {
    try {
      return Object.prototype.toString.call(err);
    } catch {
      return '[unprintable error]';
    }
  }
}
