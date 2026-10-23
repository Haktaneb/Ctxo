export const DOMAIN_UNCHANGED_TRAILER = 'Domain-Unchanged';

export interface Acknowledgement {
  readonly ids: readonly string[];
  readonly reason?: string;
}

/**
 * Parses one `Domain-Unchanged` trailer value: `<id>[, <id>...] [(reason)]`. When the trimmed value ends
 * with `)`, the reason is the text of the balanced group that closes at the end, so nested parentheses
 * stay in the reason. An unbalanced `)` leaves the whole value as ids.
 */
export function parseDomainUnchanged(value: string): Acknowledgement {
  const text = value.trim();
  let idText = text;
  let reason: string | undefined;

  if (text.endsWith(')')) {
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === ')') depth++;
      else if (ch === '(') {
        depth--;
        if (depth === 0) {
          idText = text.slice(0, i);
          const inner = text.slice(i + 1, -1).trim();
          if (inner.length > 0) reason = inner;
          break;
        }
      }
    }
  }

  const ids = idText
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return reason !== undefined ? { ids, reason } : { ids };
}
