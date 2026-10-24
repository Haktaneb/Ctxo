// Java string literal decoding (PR 4, issue #156). Java only: every string form beyond a plain "..."
// literal is language-specific, so the shared fact rules take it as a `StringLiteralDecoder` hook.
// Pinned by the `languageSpecific.java` vectors in packages/plugin-api/conformance/fact-vectors.json.
import type { StringLiteralDecoder } from './fact-types.js';

/** The opening delimiter: `"""`, optional spaces, tabs or form feeds, then a line terminator (JLS 3.10.6). */
const OPENING = /^"""[ \t\f]*(?:\r\n|\r|\n)/;

const ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  s: ' ',
  '"': '"',
  "'": "'",
  '\\': '\\',
};

/** `Character.isWhitespace`: Unicode space separators other than the non-breaking ones, line and paragraph separators, and the ASCII controls. */
function isJavaWhitespace(ch: string): boolean {
  if (ch === '\u00A0' || ch === '\u2007' || ch === '\u202F') return false;
  return /^[\t\n\u000B\f\r\u001C-\u001F\p{Zs}\u2028\u2029]$/u.test(ch);
}

function firstNonWhitespace(line: string): number {
  let i = 0;
  while (i < line.length && isJavaWhitespace(line[i]!)) i++;
  return i;
}

/** One past the last non-whitespace character; 0 for a blank line. */
function endOfNonWhitespace(line: string): number {
  let i = line.length;
  while (i > 0 && isJavaWhitespace(line[i - 1]!)) i--;
  return i;
}

/**
 * `String.stripIndent` on LF-only content: the smallest indentation of the non-blank lines and of
 * the last line (even when blank) is removed from every line, trailing whitespace is removed, blank
 * lines become empty; content that ends with a line terminator keeps its indentation and its final
 * `\n`.
 */
function stripIndent(content: string): string {
  if (content.length === 0) return '';
  const optOut = content.endsWith('\n');
  const lines = content.split('\n');
  if (optOut) lines.pop();
  let outdent = Number.MAX_SAFE_INTEGER;
  if (!optOut) {
    for (const line of lines) {
      const leading = firstNonWhitespace(line);
      if (leading !== line.length) outdent = Math.min(outdent, leading);
    }
    const last = lines[lines.length - 1]!;
    if (firstNonWhitespace(last) === last.length) outdent = Math.min(outdent, last.length);
  } else {
    outdent = 0;
  }
  const stripped = lines.map((line) => {
    const first = firstNonWhitespace(line);
    const end = endOfNonWhitespace(line);
    if (first >= end) return '';
    return line.slice(Math.min(outdent, first), end);
  });
  return stripped.join('\n') + (optOut ? '\n' : '');
}

/**
 * `String.translateEscapes`: the simple escapes (`\b \t \n \f \r \s \" \' \\`), octal escapes
 * (`\0` to `\377`) and a backslash before a line break (the line continues). Undefined for any
 * other escape, `\u` included: the shared rules treat a Unicode escape as not a constant.
 */
function translateEscapes(text: string): string | undefined {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) return undefined;
    i++;
    if (next === '\n') continue;
    const simple = ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    if (next >= '0' && next <= '7') {
      const max = next <= '3' ? 3 : 2;
      let digits = next;
      while (digits.length < max && text[i + 1] !== undefined && text[i + 1]! >= '0' && text[i + 1]! <= '7') {
        digits += text[i + 1];
        i++;
      }
      out += String.fromCharCode(parseInt(digits, 8));
      continue;
    }
    return undefined;
  }
  return out;
}

/**
 * The Java `StringLiteralDecoder`: a text block (JLS 3.10.6). The content after the opening line
 * terminator up to the closing `"""` (the first unescaped one, which must end the literal) has its
 * line terminators normalized to `\n`, then `stripIndent` (so a closing delimiter on its own line
 * keeps the final newline, and its column counts toward the indentation), then escape processing.
 * Undefined for anything else: a text block whose opening delimiter is not followed by a line
 * break, a `"""` inside the content, an invalid escape or a Unicode escape. A plain `"..."` string
 * never reaches the decoder: the shared rules decode it (other escapes, `\s` and `A`
 * included, make it not a constant).
 */
export const decodeJavaStringLiteral: StringLiteralDecoder = (literal: string): string | undefined => {
  const text = literal.trim();
  const opening = OPENING.exec(text);
  if (!opening || !text.endsWith('"""') || text.length < opening[0].length + 3) return undefined;
  const body = text.slice(opening[0].length);
  // The closing delimiter is the first `"""` that is not escaped; it must be the end of the literal.
  let close = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      i++;
      continue;
    }
    if (body.startsWith('"""', i)) {
      close = i;
      break;
    }
  }
  if (close !== body.length - 3) return undefined;
  const content = body.slice(0, close).replace(/\r\n?/g, '\n');
  return translateEscapes(stripIndent(content));
};
