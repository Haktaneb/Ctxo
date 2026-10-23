// C# raw string literal decoding (PR 4, issue #156). C# only: raw-string decoding is
// language-specific, so the shared fact rules take it as a `RawStringDecoder` hook. Pinned by the
// `languageSpecific.csharp` vectors in packages/plugin-api/conformance/fact-vectors.json.
import type { RawStringDecoder } from './fact-types.js';

/**
 * Content of a C# raw string literal (prefixes such as `$` already removed): a delimiter of 3 or
 * more quotes; a single-line literal is taken as written; in a multi-line literal the opening line
 * and the closing line (with the line break before it) are dropped, and the closing line's leading
 * whitespace is removed from every content line. Lines are joined with `\n`, so CRLF and LF sources
 * agree. Undefined when the text is not a well-formed raw string literal.
 */
export const decodeCsharpRawString: RawStringDecoder = (text: string): string | undefined => {
  let quotes = 0;
  while (text[quotes] === '"') quotes++;
  if (quotes < 3 || text.length < 2 * quotes) return undefined;
  if (!text.endsWith('"'.repeat(quotes))) return undefined;
  const body = text.slice(quotes, text.length - quotes);
  if (!/[\r\n]/.test(body)) return body;

  const lines = body.split(/\r?\n/);
  const closing = lines[lines.length - 1]!;
  if (lines[0]!.trim() !== '' || closing.trim() !== '') return undefined;
  return lines
    .slice(1, -1)
    .map(line => (line.startsWith(closing) ? line.slice(closing.length) : line.trim() === '' ? '' : line))
    .join('\n');
};
