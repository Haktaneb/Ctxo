// Go string literal decoding (PR 4, issue #156). Go only: every string form beyond a plain "..." literal
// is language-specific, so the shared fact rules take it as a `StringLiteralDecoder` hook. Pinned by the
// `languageSpecific.go` vectors in packages/plugin-api/conformance/fact-vectors.json.
import type { StringLiteralDecoder } from './fact-types.js';

const RAW_STRING = /^`([^`]*)`$/;

/**
 * The Go `StringLiteralDecoder`: a raw string `` `...` `` is its text as written, with no escapes (a
 * backslash is a backslash) and every carriage return removed, as the Go spec says for raw string values.
 * Undefined for anything else; interpreted `"..."` strings and `'...'` runes are decoded by the shared
 * rules before the hook is asked, so an interpreted string with an escape they do not know (`\x41`,
 * `A`) is not a constant.
 */
export const decodeGoStringLiteral: StringLiteralDecoder = (literal: string): string | undefined => {
  const raw = RAW_STRING.exec(literal.trim());
  return raw ? raw[1]!.replace(/\r/g, '') : undefined;
};
