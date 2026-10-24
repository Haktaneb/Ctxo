// Text lexer for the text-scan fact fallback (PR 4 Part 2, issue #156, H2). A language-agnostic tokenizer:
// comments are dropped, strings are kept whole, and every token knows its 0-based line and UTF-16 offsets.
// It never throws; unterminated strings and comments end at the line end or the end of the text.
import { decodeCommonEscapes } from './facts/fact-rules.js';
import type { StringLiteralDecoder } from './facts/fact-types.js';

/** The comment and string syntax of a file, chosen by its extension. */
export type CommentStyle = 'c' | 'c-nested' | 'hash' | 'php' | 'sql';

export interface TextToken {
  readonly kind: 'word' | 'number' | 'string' | 'op' | 'punct';
  readonly text: string;
  /** 0-based line where the token starts. */
  readonly line: number;
  /** UTF-16 offsets into the text, end exclusive. */
  readonly start: number;
  readonly end: number;
}

const C_NESTED = new Set(['.kt', '.kts', '.rs', '.scala', '.swift']);
const HASH = new Set(['.ex', '.exs', '.pl', '.py', '.r', '.rb', '.sh']);

/** c-nested: .kt .kts .rs .scala .swift; hash: .ex .exs .pl .py .r .rb .sh; php: .php; sql: .sql; else c. */
export function commentStyleFor(file: string): CommentStyle {
  const base = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';
  if (C_NESTED.has(ext)) return 'c-nested';
  if (HASH.has(ext)) return 'hash';
  if (ext === '.php') return 'php';
  if (ext === '.sql') return 'sql';
  return 'c';
}

/** Operators of more than one character, longest first. */
const MULTI_OPS = ['===', '!==', '==', '!=', '<=', '>=', '=>', '->', '::', '&&', '||', ':=', '**', '?.'] as const;
const OP_CHARS = '=<>!+-*/%&|^~?:';
const WORD_CHAR = /[\p{L}\p{M}\p{N}_$]/u;
const WORD_START = /[\p{L}\p{M}_$]/u;
const DIGIT = /[0-9]/;
const NUMBER_FORM = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*(?:\.[0-9][0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9][0-9_]*)?)(?:[uU][lL]|[lL][uU]|[lLuUmMdDfFn])?/;
/** Python string prefixes (`r`, `b`, `f`, `u` and pairs) that are kept with their string in the hash style. */
const PY_PREFIX = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/;

function codePointAt(text: string, i: number): string {
  const cp = text.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/**
 * The tokens of a source text in order. Comments are dropped; strings stay whole (delimiters included);
 * `'...'`, `"..."` strings end at the line end; block comments, triple-quoted strings and backticks span lines.
 */
export function lexSource(text: string, style: CommentStyle): TextToken[] {
  const tokens: TextToken[] = [];
  const n = text.length;
  let i = 0;
  let line = 0;

  /** Moves from `from` to `to`, counting the line breaks passed (CRLF counts once). */
  const advance = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) {
      const ch = text.charCodeAt(k);
      if (ch === 10) line++;
      else if (ch === 13 && text.charCodeAt(k + 1) !== 10) line++;
    }
  };
  const push = (kind: TextToken['kind'], start: number, end: number): void => {
    const startLine = line;
    tokens.push({ kind, text: text.slice(start, end), line: startLine, start, end });
    advance(start, end);
    i = end;
  };
  const isLineEnd = (k: number): boolean => text[k] === '\n' || text[k] === '\r';
  /** Index of the line end at or after `k` (or n). */
  const lineEnd = (k: number): number => {
    while (k < n && !isLineEnd(k)) k++;
    return k;
  };

  /** End of a single-line string opened at `k` with `quote`; backslash escapes unless `doubled`. */
  const singleLineString = (k: number, quote: string, doubled: boolean): number => {
    let j = k + 1;
    while (j < n && !isLineEnd(j)) {
      const ch = text[j]!;
      if (!doubled && ch === '\\') {
        j += isLineEnd(j + 1) ? 1 : 2;
        continue;
      }
      if (ch === quote) {
        if (doubled && text[j + 1] === quote) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return j;
  };
  /** End of a string or comment spanning lines from `k + open.length` to the closing `close`, escapes optional. */
  const spanning = (k: number, openLength: number, close: string, escapes: boolean): number => {
    let j = k + openLength;
    while (j < n) {
      if (escapes && text[j] === '\\') {
        j += 2;
        continue;
      }
      if (text.startsWith(close, j)) return j + close.length;
      j++;
    }
    return n;
  };
  const blockComment = (k: number, nested: boolean): number => {
    let depth = 1;
    let j = k + 2;
    while (j < n) {
      if (nested && text.startsWith('/*', j)) {
        depth++;
        j += 2;
      } else if (text.startsWith('*/', j)) {
        depth--;
        j += 2;
        if (depth === 0) return j;
      } else {
        j++;
      }
    }
    return n;
  };
  const skip = (to: number): void => {
    advance(i, to);
    i = to;
  };

  while (i < n) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ' || ch === '﻿') {
      skip(i + 1);
      continue;
    }

    // Comments.
    if (style === 'sql') {
      if (text.startsWith('--', i)) {
        skip(lineEnd(i));
        continue;
      }
    } else if (style === 'hash') {
      if (ch === '#') {
        skip(lineEnd(i));
        continue;
      }
    } else if (text.startsWith('//', i) || (style === 'php' && ch === '#' && text[i + 1] !== '[')) {
      skip(lineEnd(i));
      continue;
    }
    if (style !== 'hash' && text.startsWith('/*', i)) {
      skip(blockComment(i, style === 'c-nested'));
      continue;
    }

    // Strings.
    if (style === 'sql') {
      if (ch === "'") {
        push('string', i, singleLineString(i, "'", true));
        continue;
      }
      if (ch === '"') {
        // A delimited identifier, not a string.
        push('word', i, singleLineString(i, '"', true));
        continue;
      }
    } else {
      if (text.startsWith('"""', i)) {
        push('string', i, spanning(i, 3, '"""', true));
        continue;
      }
      if (style === 'hash' && text.startsWith("'''", i)) {
        push('string', i, spanning(i, 3, "'''", true));
        continue;
      }
      if (ch === '"' || ch === "'") {
        push('string', i, singleLineString(i, ch, false));
        continue;
      }
      if (ch === '`' && style !== 'hash') {
        push('string', i, spanning(i, 1, '`', true));
        continue;
      }
    }

    // Numbers (a leading `.` only when it does not follow a word, a number or a closing bracket).
    const prev = tokens[tokens.length - 1];
    const afterOperand = prev !== undefined && prev.end === i && (prev.kind === 'word' || prev.kind === 'number' || /[)\]}]/.test(prev.text));
    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(text[i + 1] ?? '') && !afterOperand)) {
      const match = NUMBER_FORM.exec(text.slice(i, i + 256));
      let end = i + (match ? match[0].length : 1);
      if (end < n && WORD_CHAR.test(codePointAt(text, end))) {
        // A number running into letters (`5px`) is a word.
        while (end < n && WORD_CHAR.test(codePointAt(text, end))) end += codePointAt(text, end).length;
        push('word', i, end);
      } else {
        push('number', i, end);
      }
      continue;
    }

    // Words.
    const point = codePointAt(text, i);
    if (WORD_START.test(point)) {
      let end = i;
      while (end < n && WORD_CHAR.test(codePointAt(text, end))) end += codePointAt(text, end).length;
      const word = text.slice(i, end);
      if (style === 'hash' && PY_PREFIX.test(word) && (text[end] === '"' || text[end] === "'")) {
        const quote = text[end]!;
        const triple = text.startsWith(quote.repeat(3), end);
        const stringEnd = triple ? spanning(end, 3, quote.repeat(3), true) : singleLineString(end, quote, false);
        push('string', i, stringEnd);
        continue;
      }
      push('word', i, end);
      continue;
    }

    // Operators and punctuation.
    const multi = MULTI_OPS.find((op) => text.startsWith(op, i));
    if (multi !== undefined) {
      push('op', i, i + multi.length);
      continue;
    }
    if (OP_CHARS.includes(ch)) {
      push('op', i, i + 1);
      continue;
    }
    push('punct', i, i + point.length);
  }
  return tokens;
}

/** The body between `open` and `close` delimiters, or undefined when the literal is not closed. */
function body(literal: string, open: string, close: string): string | undefined {
  if (literal.length < open.length + close.length || !literal.startsWith(open) || !literal.endsWith(close)) return undefined;
  return literal.slice(open.length, literal.length - close.length);
}

/**
 * The string literal decoder of a style (W5): `'...'` with the common escapes (doubled quotes and no backslash
 * escapes in `sql`), `'''...'''` and `"""..."""`, and backticks without `${`. Prefixed strings (`r'..'`, `f".."`)
 * and unterminated ones are not constants.
 */
export function stringDecoderFor(style: CommentStyle): StringLiteralDecoder {
  return (literal) => {
    const text = literal.trim();
    if (style === 'sql') {
      const inner = body(text, "'", "'");
      if (inner === undefined || /'(?!')/.test(inner.replace(/''/g, ''))) return undefined;
      return inner.replace(/''/g, "'");
    }
    for (const quote of ['"""', "'''"]) {
      if (text.startsWith(quote)) {
        if (quote === "'''" && style !== 'hash') return undefined;
        const inner = body(text, quote, quote);
        return inner === undefined ? undefined : decodeCommonEscapes(inner);
      }
    }
    if (text.startsWith('`')) {
      const inner = body(text, '`', '`');
      return inner === undefined || inner.includes('${') ? undefined : decodeCommonEscapes(inner);
    }
    for (const quote of ["'", '"']) {
      if (text.startsWith(quote)) {
        const inner = body(text, quote, quote);
        // An escaped closing quote (`'abc\'`) is not a closed string.
        if (inner === undefined || /(?:^|[^\\])(?:\\\\)*\\$/.test(inner)) return undefined;
        return decodeCommonEscapes(inner);
      }
    }
    return undefined;
  };
}
