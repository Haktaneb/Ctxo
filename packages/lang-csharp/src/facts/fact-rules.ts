// Shared fact rules (PR 4, issue #156, Fact contract FC-2 and FC-4 to FC-8). Copied unchanged into
// every official language plugin and @ctxo/domain; only import paths may differ. The rules are
// pinned by packages/plugin-api/conformance/fact-vectors.json.
import type { LiteralKind, RawStringDecoder, TrivialLiteral } from './fact-types.js';

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

type Token = { readonly kind: 'number'; readonly value: number } | { readonly kind: 'op'; readonly op: string };

const NUMBER_LITERAL = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:[uU][lL]|[lL][uU]|[lLuUmMdDfFn])?/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_$.]/;

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
      tokens.push({ kind: 'number', value: readNumber(match[0]) });
      i = end;
    }
  }
  return tokens;
}

class Parser {
  private position = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  parse(): number | undefined {
    const value = this.expression();
    return value !== undefined && this.position === this.tokens.length ? value : undefined;
  }

  private peekOp(): string | undefined {
    const token = this.tokens[this.position];
    return token?.kind === 'op' ? token.op : undefined;
  }

  private expression(): number | undefined {
    let left = this.term();
    while (left !== undefined && (this.peekOp() === '+' || this.peekOp() === '-')) {
      const op = this.peekOp();
      this.position++;
      const right = this.term();
      if (right === undefined) return undefined;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private term(): number | undefined {
    let left = this.unary();
    while (left !== undefined && (this.peekOp() === '*' || this.peekOp() === '/')) {
      const op = this.peekOp();
      this.position++;
      const right = this.unary();
      if (right === undefined) return undefined;
      if (op === '/' && right === 0) return undefined;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  private unary(): number | undefined {
    const op = this.peekOp();
    if (op === '-' || op === '+') {
      this.position++;
      const operand = this.unary();
      return operand === undefined ? undefined : op === '-' ? -operand : operand;
    }
    return this.primary();
  }

  private primary(): number | undefined {
    const token = this.tokens[this.position];
    if (!token) return undefined;
    if (token.kind === 'number') {
      this.position++;
      return token.value;
    }
    if (token.op !== '(') return undefined;
    this.position++;
    const value = this.expression();
    if (value === undefined || this.peekOp() !== ')') return undefined;
    this.position++;
    return value;
  }
}

const MAX_EXACT_INTEGER = 2 ** 53;

/**
 * FC-7 evaluation, shared by `canonicalNumber` and the FC-6 number check: the IEEE double of a
 * constant expression, or `undefined` when it is not a constant. Not constants: names, strings,
 * division by zero, non-finite results, results with |v| >= 2^53, and non-zero results that round
 * to 0 at 6 decimals.
 */
function evaluate(expression: string): number | undefined {
  const tokens = tokenize(expression);
  if (!tokens || tokens.length === 0) return undefined;
  const value = new Parser(tokens).parse();
  if (value === undefined || !Number.isFinite(value) || Math.abs(value) >= MAX_EXACT_INTEGER) return undefined;
  if (value !== 0 && Number(value.toFixed(6)) === 0) return undefined;
  return value;
}

/** An integer prints as plain digits; anything else rounded to 6 decimals, trailing zeros removed; `-0` prints `0`. */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value === 0 ? '0' : String(value);
  const fixed = value.toFixed(6).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

/**
 * FC-7: the canonical text of a numeric constant (`_` and type suffixes removed; decimal, exponent,
 * hex, binary and octal forms; `+ - * /`, parentheses and unary minus in IEEE doubles), or
 * `undefined` when the expression is not a constant (see `evaluate`).
 */
export function canonicalNumber(expression: string): string | undefined {
  const value = evaluate(expression);
  return value === undefined ? undefined : formatNumber(value);
}

// ── FC-6 trivial literals ───────────────────────────────────────

const ESCAPES: Readonly<Record<string, string>> = { '"': '"', "'": "'", '\\': '\\', n: '\n', t: '\t', r: '\r' };

/**
 * Decoded content of a string or char literal; undefined when the text is not one. A `"""` literal
 * goes to the language's raw-string decoder (C# raw strings, Java text blocks); without a decoder it
 * is not a string constant.
 */
function stringContent(literal: string, decodeRawString: RawStringDecoder | undefined): string | undefined {
  let text = literal.trim();
  let verbatim = false;
  while (text.length > 0 && (text[0] === '@' || text[0] === '$')) {
    if (text[0] === '@') verbatim = true;
    text = text.slice(1);
  }
  if (text.endsWith('u8')) text = text.slice(0, -2);

  if (text.startsWith('"""')) return decodeRawString ? decodeRawString(text) : undefined;
  const quote = text[0];
  if (text.length < 2 || (quote !== '"' && quote !== "'" && quote !== '`') || text[text.length - 1] !== quote) return undefined;
  const body = text.slice(1, -1);
  if (quote === '`') return body;
  if (verbatim) return body.split(quote + quote).join(quote);
  return body.replace(/\\(["'\\ntr])/g, (_, ch: string) => ESCAPES[ch]!);
}

/**
 * FC-6: true when the literal equals an entry of the trivial list of the same type: numbers when
 * the evaluated double (FC-7) equals the list's number exactly, strings and chars by decoded
 * content, `null`/`nil`/`None` with `null`, booleans case-insensitively. Each language supplies its
 * own `decodeRawString` for `"""` literals; without it such a literal is never trivial.
 */
export function isTrivialLiteral(
  literal: string,
  kind: LiteralKind,
  trivial: readonly TrivialLiteral[],
  decodeRawString?: RawStringDecoder,
): boolean {
  switch (kind) {
    case 'number': {
      const value = evaluate(literal);
      return value !== undefined && trivial.some(t => typeof t === 'number' && t === value);
    }
    case 'string':
    case 'char': {
      const content = stringContent(literal, decodeRawString);
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
