// Domain copy of packages/lang-csharp/src/facts/fact-rules.ts (PR 4 Part 2, issue #156), used by the text-scan
// fallback. It differs from the master only in this header and in importing types from @ctxo/cli/internal;
// packages/cli/tests/e2e/facts-shared-copies.test.ts checks that it does not drift.
import type { LiteralKind, StringLiteralDecoder, TrivialLiteral } from './fact-types.js';

/** Name fragments of `retry-timeout` bindings, matched on identifier-token boundaries (FC-5). */
export const RETRY_TIMEOUT_FRAGMENTS: readonly string[] = ['retry', 'retries', 'attempt', 'timeout', 'delay', 'backoff', 'ttl', 'expir'];

/** Longest fact text, in Unicode code points (FC-2). */
export const MAX_FACT_TEXT = 200;

/** Most facts kept per file (FC-10). */
export const MAX_FACTS_PER_FILE = 500;

/** At most 200 code points (never inside a surrogate pair), trimmed at the end after a cut; shorter values are unchanged. */
export function capFactValue(value: string): string {
  const points = Array.from(value);
  return points.length <= MAX_FACT_TEXT ? value : points.slice(0, MAX_FACT_TEXT).join('').trimEnd();
}

/** FC-2: whitespace runs become one space, trimmed, cut at 200 code points (never inside a surrogate pair). */
export function normalizeFactText(text: string): string {
  return capFactValue(text.replace(/\s+/g, ' ').trim());
}

// ── FC-7 canonical numbers ──────────────────────────────────────

/** A number token; `integer` is the literal's type (no `.`, no exponent, no floating suffix), not its value. */
type Token = { readonly kind: 'number'; readonly value: number; readonly integer: boolean } | { readonly kind: 'op'; readonly op: string };

/** An evaluated operand: its double and whether its type is integer (every literal in it is an integer literal). */
interface Operand { readonly value: number; readonly integer: boolean }

const NUMBER_LITERAL = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:[uU][lL]|[lL][uU]|[lLuUmMdDfFn])?/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_$.]/;

const LEADING_ZERO_INTEGER = /^0\d+(?:[uU][lL]|[lL][uU]|[lLuUn])?$/;

/** Hex, binary and octal literals are integers; a decimal one is when it has no `.`, no exponent and no `m`, `d` or `f` suffix. */
function isIntegerLiteral(text: string): boolean {
  if (/^0[xXbBoO]/.test(text)) return true;
  return !/[.eE]/.test(text) && !/[mMdDfF]$/.test(text);
}

function readNumber(text: string): number {
  // parseInt stops at the first non-digit, so a suffix after hex, binary or octal digits is ignored
  // (and a hex digit d or f is never taken for a suffix).
  const prefix = text.slice(0, 2).toLowerCase();
  if (prefix === '0x') return parseInt(text.slice(2), 16);
  if (prefix === '0b') return parseInt(text.slice(2), 2);
  if (prefix === '0o') return parseInt(text.slice(2), 8);
  return Number(text.replace(/(?:[uU][lL]|[lL][uU]|[lLuUmMdDfFn])$/, ''));
}

function tokenize(expression: string): Token[] | undefined {
  const source = expression.replace(/_/g, '');
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if ('+-*/()'.includes(ch)) {
      tokens.push({ kind: 'op', op: ch });
      i++;
    } else {
      const match = NUMBER_LITERAL.exec(source.slice(i));
      if (!match) return undefined;
      const end = i + match[0].length;
      if (end < source.length && IDENTIFIER_CHAR.test(source[end]!)) return undefined;
      // A leading-zero integer (017) is octal in Java and Go and decimal in C#: not a constant.
      if (LEADING_ZERO_INTEGER.test(match[0])) return undefined;
      tokens.push({ kind: 'number', value: readNumber(match[0]), integer: isIntegerLiteral(match[0]) });
      i = end;
    }
  }
  return tokens;
}

class Parser {
  private position = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  parse(): number | undefined {
    const operand = this.expression();
    return operand !== undefined && this.position === this.tokens.length ? operand.value : undefined;
  }

  private peekOp(): string | undefined {
    const token = this.tokens[this.position];
    return token?.kind === 'op' ? token.op : undefined;
  }

  private expression(): Operand | undefined {
    let left = this.term();
    while (left !== undefined && (this.peekOp() === '+' || this.peekOp() === '-')) {
      const op = this.peekOp();
      this.position++;
      const right = this.term();
      if (right === undefined) return undefined;
      left = { value: op === '+' ? left.value + right.value : left.value - right.value, integer: left.integer && right.integer };
    }
    return left;
  }

  private term(): Operand | undefined {
    let left = this.unary();
    while (left !== undefined && (this.peekOp() === '*' || this.peekOp() === '/')) {
      const op = this.peekOp();
      this.position++;
      const right = this.unary();
      if (right === undefined) return undefined;
      const integer = left.integer && right.integer;
      if (op === '*') {
        left = { value: left.value * right.value, integer };
        continue;
      }
      if (right.value === 0) return undefined;
      // Integer division truncates in C#, Java and Go but not in TypeScript: a remainder is not a constant.
      if (integer && left.value % right.value !== 0) return undefined;
      left = { value: left.value / right.value, integer };
    }
    return left;
  }

  private unary(): Operand | undefined {
    const op = this.peekOp();
    if (op === '-' || op === '+') {
      this.position++;
      const operand = this.unary();
      return operand === undefined ? undefined : op === '-' ? { value: -operand.value, integer: operand.integer } : operand;
    }
    return this.primary();
  }

  private primary(): Operand | undefined {
    const token = this.tokens[this.position];
    if (!token) return undefined;
    if (token.kind === 'number') {
      this.position++;
      return { value: token.value, integer: token.integer };
    }
    if (token.op !== '(') return undefined;
    this.position++;
    const operand = this.expression();
    if (operand === undefined || this.peekOp() !== ')') return undefined;
    this.position++;
    return operand;
  }
}

const MAX_EXACT_INTEGER = 2 ** 53;

/**
 * FC-7 evaluation, shared by `canonicalNumber` and the FC-6 number check: the IEEE double of a
 * constant expression, or `undefined` when it is not a constant. Not constants: names, strings,
 * division by zero, a leading-zero integer literal other than `0` (`017`), a division of two
 * integer operands with a non-zero remainder (`7 / 2`; `7.0 / 2` is a float division), non-finite
 * results, results with |v| >= 2^53, and non-zero results that round to 0 at 6 decimals.
 */
function evaluate(expression: string): number | undefined {
  const tokens = tokenize(expression);
  if (!tokens || tokens.length === 0) return undefined;
  const value = new Parser(tokens).parse();
  if (value === undefined || !Number.isFinite(value) || Math.abs(value) >= MAX_EXACT_INTEGER) return undefined;
  if (value !== 0 && Number(value.toFixed(6)) === 0) return undefined;
  return value;
}

/**
 * An integer prints as plain digits; anything else is the exact binary double rounded to 6
 * decimals as JS `toFixed(6)` does (0.0000015 gives 0.000002, 0.0000005 gives 0; an exact tie such
 * as 0.0078125 rounds half away from zero), trailing zeros removed; `-0` prints `0`. Java copies
 * round with `new BigDecimal(double).setScale(6, RoundingMode.HALF_UP)`; Go copies must not rely on
 * `strconv.FormatFloat` for exact ties, which it rounds to even.
 */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value === 0 ? '0' : String(value);
  const fixed = value.toFixed(6).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

/**
 * FC-7: the canonical text of a numeric constant (`_` and type suffixes removed; decimal, exponent,
 * hex, binary and octal forms; `+ - * /`, parentheses and unary minus in IEEE doubles), or
 * `undefined` when the expression is not a constant (see `evaluate` and `formatNumber`).
 */
export function canonicalNumber(expression: string): string | undefined {
  const value = evaluate(expression);
  return value === undefined ? undefined : formatNumber(value);
}

// ── FC-6 trivial literals ───────────────────────────────────────

const ESCAPES: Readonly<Record<string, string>> = { '"': '"', "'": "'", '\\': '\\', n: '\n', t: '\t', r: '\r' };
const PLAIN_STRING = /^"((?:[^"\\]|\\[\s\S])*)"$/;
const PLAIN_CHAR = /^'((?:[^'\\]|\\[\s\S])*)'$/;

/**
 * The body of a plain quoted literal with the common escapes decoded (a backslash before `"`, `'`,
 * a backslash, `n`, `t` or `r`); undefined when it holds any other escape.
 */
export function decodeCommonEscapes(body: string): string | undefined {
  let valid = true;
  const decoded = body.replace(/\\([\s\S])/g, (_, ch: string) => {
    const escaped = ESCAPES[ch];
    if (escaped === undefined) valid = false;
    return escaped ?? '';
  });
  return valid ? decoded : undefined;
}

/**
 * Decoded content of a string or char literal; undefined when it is not a constant. The shared
 * rules decode only a plain `"..."` string (a `'...'` char for kind `char`) with the common
 * escapes; every other form goes to the language's string literal decoder, and without one it is
 * not a string constant.
 */
function stringContent(literal: string, kind: 'string' | 'char', decode: StringLiteralDecoder | undefined): string | undefined {
  const text = literal.trim();
  const plain = (kind === 'char' ? PLAIN_CHAR : PLAIN_STRING).exec(text);
  if (plain) return decodeCommonEscapes(plain[1]!);
  return decode ? decode(text) : undefined;
}

/**
 * FC-6: true when the literal equals an entry of the trivial list of the same type: numbers when
 * the evaluated double (FC-7) equals the list's number exactly, strings and chars by decoded
 * content, `null`/`nil`/`None` with `null`, booleans case-insensitively. Each language supplies its
 * own `decodeStringLiteral` for every string form other than a plain quoted literal; without it
 * such a literal is never trivial.
 */
export function isTrivialLiteral(
  literal: string,
  kind: LiteralKind,
  trivial: readonly TrivialLiteral[],
  decodeStringLiteral?: StringLiteralDecoder,
): boolean {
  switch (kind) {
    case 'number': {
      const value = evaluate(literal);
      return value !== undefined && trivial.some(t => typeof t === 'number' && t === value);
    }
    case 'string':
    case 'char': {
      const content = stringContent(literal, kind, decodeStringLiteral);
      return content !== undefined && trivial.some(t => typeof t === 'string' && t === content);
    }
    case 'null':
      return (literal === 'null' || literal === 'nil' || literal === 'None') && trivial.includes(null);
    case 'boolean': {
      const lower = literal.toLowerCase();
      if (lower !== 'true' && lower !== 'false') return false;
      return trivial.includes(lower === 'true');
    }
    default:
      return false;
  }
}

// ── FC-4 normalization ──────────────────────────────────────────

/**
 * FC-4: `Name` matches exactly, `Name*` by prefix (case-sensitive), and `q.Name[*]` only when the
 * call is written `q.Name(...)` (`qualifier` is the receiver's source).
 */
export function matchesNormalizationPattern(method: string, qualifier: string | undefined, patterns: readonly string[]): boolean {
  return patterns.some(pattern => {
    const dot = pattern.indexOf('.');
    const patternQualifier = dot >= 0 ? pattern.slice(0, dot) : undefined;
    const name = dot >= 0 ? pattern.slice(dot + 1) : pattern;
    if (patternQualifier !== undefined && patternQualifier !== qualifier) return false;
    return name.endsWith('*') ? method.startsWith(name.slice(0, -1)) : method === name;
  });
}

// ── FC-5 retry and timeout names ────────────────────────────────

const NAME_TOKEN = /[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+|\d+/g;

/**
 * FC-5: the name is split into lower-cased ASCII tokens (camelCase, PascalCase, digit runs): only
 * A-Z, a-z and 0-9 form tokens, every other character (`_`, `-`, non-ASCII letters) separates them,
 * with no Unicode case tests and no locale-dependent lowercasing (`ñretry` matches). A fragment
 * matches when the tokens joined from the start of some token begin with it. A deliberate
 * narrowing of spec 12.1's "a name containing": `settlementDays` never matches `ttl`.
 */
export function hasRetryTimeoutFragment(name: string): boolean {
  const tokens = (name.match(NAME_TOKEN) ?? []).map(t => t.toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    const rest = tokens.slice(i).join('');
    if (RETRY_TIMEOUT_FRAGMENTS.some(fragment => rest.startsWith(fragment))) return true;
  }
  return false;
}

// ── FC-8 routes ─────────────────────────────────────────────────

/** FC-8: empty parts dropped, each part's outer `/` trimmed, joined with `/`, repeats collapsed, `/` prefixed. */
export function joinRoute(...parts: readonly (string | undefined)[]): string {
  const segments = parts
    .map(part => (part ?? '').replace(/^\/+|\/+$/g, ''))
    .filter(part => part.length > 0);
  return `/${segments.join('/')}`.replace(/\/{2,}/g, '/');
}
