import type { SymbolAnnotation } from '@ctxo/plugin-api';

/** One struct field's tag text, as the analyzer emits it and the tree-sitter tier reads it. */
export interface FieldTag {
  readonly field: string;
  readonly tag: string;
}

const MAX_ANNOTATIONS = 20;
const MAX_NAMED_PAIRS = 10;
const MAX_VALUE_LENGTH = 200;

/**
 * Parses a struct tag the way reflect.StructTag.Lookup walks it: skip leading
 * spaces; a key is a run of characters above space other than ':', '"' and
 * DEL, followed by ':"'; the value runs to the next unescaped '"' and is
 * decoded as a quoted string. Parsing stops at the first malformed pair or
 * undecodable value. The first occurrence of a key wins.
 */
export function parseStructTag(tag: string): Array<[key: string, value: string]> {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < tag.length) {
    while (i < tag.length && tag[i] === ' ') i++;
    if (i >= tag.length) break;

    const keyStart = i;
    while (i < tag.length) {
      const c = tag.charCodeAt(i);
      if (c <= 0x20 || c === 0x3a || c === 0x22 || c === 0x7f) break;
      i++;
    }
    if (i === keyStart || i + 1 >= tag.length || tag[i] !== ':' || tag[i + 1] !== '"') break;
    const key = tag.slice(keyStart, i);
    i++; // past ':'

    const valueStart = i; // at the opening quote
    i++;
    while (i < tag.length && tag[i] !== '"') {
      if (tag[i] === '\\') i++;
      i++;
    }
    if (i >= tag.length) break;
    const quoted = tag.slice(valueStart, i + 1);
    i++; // past closing quote

    let value: string;
    try {
      value = JSON.parse(quoted) as string;
    } catch {
      break;
    }
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push([key, value]);
    }
  }
  return pairs;
}

/**
 * Builds one `{ name: 'tag', named: { member: <field>, ...pairs } }` per field
 * that has at least one usable pair. Struct fields are not symbols, so the
 * field name goes in the reserved key `member` (it wins over a tag key of the
 * same name and does not count toward the 10 pairs); `type` is reserved too
 * and dropped. Caps: 20 annotations, 10 pairs, 200 characters per value.
 */
export function structTagAnnotations(tags: readonly FieldTag[]): SymbolAnnotation[] | undefined {
  const out: SymbolAnnotation[] = [];
  for (const { field, tag } of tags) {
    if (out.length >= MAX_ANNOTATIONS) break;
    const entries: Array<[string, string]> = [];
    for (const [key, value] of parseStructTag(tag)) {
      if (key === 'member' || key === 'type') continue;
      if (entries.length >= MAX_NAMED_PAIRS) break;
      entries.push([key, value.slice(0, MAX_VALUE_LENGTH)]);
    }
    if (entries.length === 0) continue;
    out.push({
      name: 'tag',
      named: Object.fromEntries([['member', field.slice(0, MAX_VALUE_LENGTH)], ...entries]),
    });
  }
  return out.length > 0 ? out : undefined;
}
