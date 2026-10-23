// TypeScript and JavaScript string literal decoding (PR 4, issue #156). TypeScript only: every string
// form beyond a plain "..." literal is language-specific, so the shared fact rules take it as a
// `StringLiteralDecoder` hook. Pinned by the `languageSpecific.typescript` vectors in
// packages/plugin-api/conformance/fact-vectors.json.
import type { StringLiteralDecoder } from './fact-types.js';
import { decodeCommonEscapes } from './fact-rules.js';

const SINGLE_QUOTED = /^'((?:[^'\\\r\n]|\\[\s\S])*)'$/;
const TEMPLATE = /^`((?:[^`\\]|\\[\s\S])*)`$/;

/**
 * Content of a template literal body without substitutions: `` \` `` and `\$` become the plain
 * characters, the common escapes are decoded, and a CRLF line break becomes `\n` (as the template's
 * cooked value). Undefined for an unescaped `${` (a substitution) or any other escape.
 */
function templateContent(body: string): string | undefined {
  let plain = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '\\') {
      const next = body[i + 1];
      plain += next === '`' || next === '$' ? next : `\\${next ?? ''}`;
      i++;
      continue;
    }
    if (ch === '$' && body[i + 1] === '{') return undefined;
    plain += ch;
  }
  // The escaped forms were turned into plain characters above; the rest goes through the shared escapes.
  return decodeCommonEscapes(plain.replace(/\r\n?/g, '\n'));
}

/**
 * The TypeScript `StringLiteralDecoder`: a single-quoted `'...'` string and a template literal without
 * substitutions, both with the shared common escapes (a backslash before `"`, `'`, a backslash, `n`,
 * `t` or `r`), plus `` \` `` and `\$` in templates, so `'...'` and `"..."` decode alike. Undefined for
 * anything that is not such a constant: a template with a substitution, a tagged template, other
 * escapes (`A`, `\x41`), and a line break inside a single-quoted string.
 */
export const decodeTypescriptStringLiteral: StringLiteralDecoder = (literal: string): string | undefined => {
  const text = literal.trim();
  const single = SINGLE_QUOTED.exec(text);
  if (single) return decodeCommonEscapes(single[1]!);
  const template = TEMPLATE.exec(text);
  return template ? templateContent(template[1]!) : undefined;
};
