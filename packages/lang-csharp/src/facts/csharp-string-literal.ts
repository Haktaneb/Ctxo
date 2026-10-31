// C# string literal decoding (PR 4, issue #156). C# only: every string form beyond a plain
// "..." literal is language-specific, so the shared fact rules take it as a `StringLiteralDecoder`
// hook. Pinned by the `languageSpecific.csharp` vectors in
// packages/plugin-api/conformance/fact-vectors.json.
import type { StringLiteralDecoder } from './fact-types.js';
import { decodeCommonEscapes } from './fact-rules.js';

const REGULAR = /^"((?:[^"\\]|\\[\s\S])*)"$/;
const VERBATIM = /^"((?:[^"]|"")*)"$/;

/**
 * Content of a C# raw string literal (prefixes such as `$` already removed): a delimiter of 3 or
 * more quotes. A single-line literal is taken as written. In a multi-line literal the opening line
 * and the closing line (with the line break before it) are dropped, and the closing line's leading
 * whitespace is removed from every content line; a whitespace-only content line becomes empty.
 * Lines are joined with `\n`, so CRLF and LF sources agree. Undefined when the text is not a raw
 * string literal that compiles: no content line in a multi-line literal (CS9002), a content line
 * that does not start with the closing line's whitespace (CS8999), a quote run as long as the
 * delimiter in the content, or a quote right before the closing delimiter of a single-line literal.
 */
export function decodeCsharpRawString(text: string): string | undefined {
  let quotes = 0;
  while (text[quotes] === '"') quotes++;
  if (quotes < 3 || text.length < 2 * quotes) return undefined;
  if (!text.endsWith('"'.repeat(quotes))) return undefined;
  const body = text.slice(quotes, text.length - quotes);
  const delimiterRun = new RegExp(`"{${quotes},}`);

  if (!/[\r\n]/.test(body)) {
    if (body.length === 0 || body.endsWith('"') || delimiterRun.test(body)) return undefined;
    return body;
  }

  const lines = body.split(/\r?\n/);
  const opening = lines.shift()!;
  const closing = lines.pop()!;
  if (opening.trim() !== '' || closing.trim() !== '') return undefined;
  if (lines.length === 0) return undefined;
  const content: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      content.push('');
      continue;
    }
    if (!line.startsWith(closing)) return undefined;
    content.push(line.slice(closing.length));
  }
  const decoded = content.join('\n');
  return delimiterRun.test(decoded) ? undefined : decoded;
}

/** Interpolated `{{` and `}}` become single braces; a lone brace opens or closes a hole: undefined. */
function unescapeBraces(body: string): string | undefined {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '{' || ch === '}') {
      if (body[i + 1] !== ch) return undefined;
      i++;
    }
    out += ch;
  }
  return out;
}

/**
 * The C# `StringLiteralDecoder`: regular `"..."` (common escapes), verbatim `@"..."` (`""` is a
 * quote), interpolated `$"..."`, `$@"..."` and `@$"..."` (`{{` and `}}` are braces), the `u8`
 * suffix, and raw strings (`"""`, with any number of `$`). Undefined for anything that is not a
 * C# string constant: an interpolation hole (in a raw string with N `$`, any run of N or more
 * braces), `u8` on an interpolated string, other escapes, and raw strings that do not compile.
 */
export const decodeCsharpStringLiteral: StringLiteralDecoder = (literal: string): string | undefined => {
  let text = literal.trim();
  const prefix = /^(\$*)(@?)(\$*)/.exec(text)!;
  if (prefix[1]!.length > 0 && prefix[3]!.length > 0) return undefined;
  const dollars = prefix[1]!.length + prefix[3]!.length;
  const verbatim = prefix[2] === '@';
  text = text.slice(prefix[0].length);
  if (text.endsWith('u8') || text.endsWith('U8')) {
    if (dollars > 0) return undefined;
    text = text.slice(0, -2);
  }

  if (!verbatim && text.startsWith('"""')) {
    const content = decodeCsharpRawString(text);
    if (content === undefined || dollars === 0) return content;
    return new RegExp(`\\{{${dollars},}|\\}{${dollars},}`).test(content) ? undefined : content;
  }
  if (dollars > 1) return undefined;

  const match = (verbatim ? VERBATIM : REGULAR).exec(text);
  if (!match) return undefined;
  const body = dollars === 1 ? unescapeBraces(match[1]!) : match[1]!;
  if (body === undefined) return undefined;
  return verbatim ? body.split('""').join('"') : decodeCommonEscapes(body);
};
