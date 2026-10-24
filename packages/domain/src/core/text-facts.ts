// Text-scan fact evidence (PR 4 Part 2, issue #156, H2): single-line heuristics over the text lexer's tokens for
// files whose plugin has no fact detector and for languages without a plugin. The evidence goes through the same
// finisher as the plugins' (the domain copy of finish-facts.ts), so the facts follow the fact contract.
// Every per-line rule is linear in the line length: bracket pairs, operand runs and the condition positions are
// computed once per line, and lookups use Maps, so names such as `constructor` or `hasOwnProperty` are ordinary.
import type { CodeFact, SymbolNode } from '@ctxo/cli/internal';
import type { DurationUnit, FactEvidence, FactOptions, LiteralKind } from './facts/fact-types.js';
import { MAX_FACT_TEXT, hasRetryTimeoutFragment, matchesNormalizationPattern } from './facts/fact-rules.js';
import { finishFacts } from './facts/finish-facts.js';
import { commentStyleFor, lexSource, stringDecoderFor } from './text-lexer.js';
import type { CommentStyle, TextToken } from './text-lexer.js';

const COMPARISON_OPS = new Set(['==', '!=', '===', '!==', '<', '<=', '>', '>=']);
const CONDITION_WORDS = new Set(['if', 'elif', 'elsif', 'while', 'until', 'unless', 'when', 'guard']);
const LOGICAL_WORDS = new Set(['and', 'or', 'not']);
/** Operator tokens that end an operand run (FC-3 stops) or sit next to a whole operand (assignment, ternary). */
const BOUNDARY_OPS = new Set(['&&', '||', '!', ':', '?', '=', ':=', '=>']);
const MEMBER_OPS = new Set(['.', '::', '->', '?.']);
const LITERAL_WORDS: ReadonlyMap<string, LiteralKind> = new Map([
  ['null', 'null'],
  ['nil', 'null'],
  ['None', 'null'],
  ['true', 'boolean'],
  ['false', 'boolean'],
  ['True', 'boolean'],
  ['False', 'boolean'],
]);
const OPENERS: ReadonlyMap<string, string> = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
const CLOSERS: ReadonlyMap<string, string> = new Map([[')', '('], [']', '['], ['}', '{']]);

const TIMESPAN_UNITS: ReadonlyMap<string, DurationUnit> = new Map([
  ['FromMilliseconds', 'ms'], ['FromSeconds', 's'], ['FromMinutes', 'min'], ['FromHours', 'h'], ['FromDays', 'd'], ['FromMicroseconds', 'us'],
]);
const DURATION_UNITS: ReadonlyMap<string, DurationUnit> = new Map([
  ['ofMillis', 'ms'], ['ofSeconds', 's'], ['ofMinutes', 'min'], ['ofHours', 'h'], ['ofDays', 'd'], ['ofNanos', 'ns'],
]);
const GO_TIME_UNITS: ReadonlyMap<string, DurationUnit> = new Map([
  ['Nanosecond', 'ns'], ['Microsecond', 'us'], ['Millisecond', 'ms'], ['Second', 's'], ['Minute', 'min'], ['Hour', 'h'],
]);
const ROUTER_VERBS: ReadonlyMap<string, string> = new Map([
  ['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['delete', 'DELETE'], ['patch', 'PATCH'], ['head', 'HEAD'], ['options', 'OPTIONS'], ['all', 'ANY'],
]);
const DECORATOR_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch']);
const HTTP_ATTRIBUTE = /^Http(Get|Post|Put|Delete|Patch|Head|Options)$/;
const MAPPING_ANNOTATION = /^(Get|Post|Put|Delete|Patch)Mapping$/;
const MAP_CALL = /^Map(Get|Post|Put|Delete|Patch)$/;
/** Operators a numeric constant (FC-7) may hold besides numbers and parentheses. */
const ARITHMETIC_OPS = new Set(['+', '-', '*', '/']);

/** One line's tokens and what the rules need to know about them, computed once per line. */
interface Line {
  readonly tokens: readonly TextToken[];
  readonly style: CommentStyle;
  readonly decode: (literal: string) => string | undefined;
  /** The index of the bracket matching each bracket token (per bracket type, as a stack pairs them), else -1. */
  readonly pairs: Int32Array;
  /** Whether each token can be part of an operand run. */
  readonly operand: Uint8Array;
  /** Where an operand run that has reached index k (as its first token) ends when walked to the left. */
  readonly runStart: Int32Array;
  /** Where an operand run that has reached index k (as its last token) ends when walked to the right. */
  readonly runEnd: Int32Array;
  /** Index of the first condition word, or the token count. */
  readonly firstCondition: number;
  /** Index of the last `?`, or -1. */
  readonly lastQuestion: number;
  methods?: readonly string[];
}

const adjacent = (a: TextToken | undefined, b: TextToken | undefined): boolean => a !== undefined && b !== undefined && a.end === b.start;
const isOp = (t: TextToken | undefined, text: string): boolean => t !== undefined && (t.kind === 'op' || t.kind === 'punct') && t.text === text;
const isOpener = (t: TextToken | undefined): boolean => t !== undefined && t.kind === 'punct' && OPENERS.has(t.text);
const isCloser = (t: TextToken | undefined): boolean => t !== undefined && t.kind === 'punct' && CLOSERS.has(t.text);

/** The tokens from `from` to `to` (inclusive) as text, one space where the source had a gap. */
function joinTokens(tokens: readonly TextToken[], from: number, to: number): string {
  let out = '';
  for (let k = from; k <= to; k++) {
    if (k > from && tokens[k - 1]!.end !== tokens[k]!.start) out += ' ';
    out += tokens[k]!.text;
  }
  return out;
}

/**
 * `joinTokens` for a fact text, stopped once the text is longer than FC-2 keeps: when the whitespace-collapsed,
 * trimmed text has more than 200 code points, later tokens cannot change what `normalizeFactText` returns.
 */
function joinFactText(tokens: readonly TextToken[], from: number, to: number): string {
  let out = '';
  let check = 1024;
  for (let k = from; k <= to; k++) {
    if (k > from && tokens[k - 1]!.end !== tokens[k]!.start) out += ' ';
    out += tokens[k]!.text;
    if (out.length >= check) {
      if (Array.from(out.replace(/\s+/g, ' ').trim()).length > MAX_FACT_TEXT) break;
      check = out.length * 2;
    }
  }
  return out;
}

function lowerIfSql(style: CommentStyle, word: string): string {
  return style === 'sql' ? word.toLowerCase() : word;
}

function isConditionWord(style: CommentStyle, t: TextToken | undefined): boolean {
  return t !== undefined && t.kind === 'word' && CONDITION_WORDS.has(lowerIfSql(style, t.text));
}

/** True for a token that can be part of an operand run: words (not stops), numbers, strings and member operators. */
function isOperandToken(style: CommentStyle, t: TextToken): boolean {
  if (t.kind === 'word') return !LOGICAL_WORDS.has(lowerIfSql(style, t.text)) && !isConditionWord(style, t);
  if (t.kind === 'number' || t.kind === 'string') return true;
  return MEMBER_OPS.has(t.text);
}

/** The per-line tables: bracket pairs (one stack per bracket type), operand runs and condition positions. */
function buildLine(tokens: readonly TextToken[], style: CommentStyle, decode: (literal: string) => string | undefined): Line {
  const n = tokens.length;
  const pairs = new Int32Array(n).fill(-1);
  const stacks = new Map<string, number[]>([['(', []], ['[', []], ['{', []]]);
  const operand = new Uint8Array(n);
  let firstCondition = n;
  let lastQuestion = -1;
  for (let k = 0; k < n; k++) {
    const t = tokens[k]!;
    if (t.kind === 'punct' && OPENERS.has(t.text)) {
      stacks.get(t.text)!.push(k);
    } else if (t.kind === 'punct' && CLOSERS.has(t.text)) {
      const open = stacks.get(CLOSERS.get(t.text)!)!.pop();
      if (open !== undefined) {
        pairs[k] = open;
        pairs[open] = k;
      }
    }
    if (isOperandToken(style, t)) operand[k] = 1;
    if (firstCondition === n && isConditionWord(style, t)) firstCondition = k;
    if (isOp(t, '?')) lastQuestion = k;
  }
  // runStart[f]: the run has reached token f; it grows left over an adjacent operand token or balanced group.
  const runStart = new Int32Array(n);
  for (let f = 0; f < n; f++) {
    const p = f - 1;
    if (p >= 0 && adjacent(tokens[p], tokens[f])) {
      if (isCloser(tokens[p])) runStart[f] = pairs[p]! >= 0 ? runStart[pairs[p]!]! : f;
      else runStart[f] = operand[p] ? runStart[p]! : f;
    } else {
      runStart[f] = f;
    }
  }
  // runEnd[t]: the run has reached token t; it grows right over an adjacent operand token or balanced group.
  const runEnd = new Int32Array(n);
  for (let t = n - 1; t >= 0; t--) {
    const q = t + 1;
    if (q < n && adjacent(tokens[t], tokens[q])) {
      if (isOpener(tokens[q])) runEnd[t] = pairs[q]! >= 0 ? runEnd[pairs[q]!]! : t;
      else runEnd[t] = operand[q] ? runEnd[q]! : t;
    } else {
      runEnd[t] = t;
    }
  }
  return { tokens, style, decode, pairs, operand, runStart, runEnd, firstCondition, lastQuestion };
}

/** True when the token beyond an operand run lets the run stand as a whole operand. */
function isBoundary(t: TextToken | undefined): boolean {
  if (t === undefined || t.kind === 'word' || t.kind === 'punct') return true;
  return t.kind === 'op' && BOUNDARY_OPS.has(t.text);
}

const isSign = (t: TextToken | undefined): boolean => isOp(t, '-') || isOp(t, '+');

/** The literal kind of a single-token operand (or a sign followed by a number), or undefined. */
function literalOf(tokens: readonly TextToken[], from: number, to: number): LiteralKind | undefined {
  if (from === to) {
    const t = tokens[from]!;
    if (t.kind === 'number') return 'number';
    if (t.kind === 'string') return 'string';
    if (t.kind === 'word') return LITERAL_WORDS.get(t.text);
    return undefined;
  }
  if (to === from + 1 && isSign(tokens[from]) && tokens[to]!.kind === 'number' && adjacent(tokens[from], tokens[to])) {
    return 'number';
  }
  return undefined;
}

/** The operand run ending at `end` (scanning left), as `[from, end]`, or undefined when it is not a whole operand. */
function leftOperand(line: Line, end: number): readonly [number, number] | undefined {
  const { tokens, pairs } = line;
  let from: number;
  if (isCloser(tokens[end])) {
    if (pairs[end]! < 0) return undefined;
    from = line.runStart[pairs[end]!]!;
  } else if (line.operand[end]) {
    from = line.runStart[end]!;
  } else {
    return undefined;
  }
  // A sign directly before a number ("-5 < x").
  if (from === end && tokens[end]!.kind === 'number' && isSign(tokens[from - 1]) && adjacent(tokens[from - 1], tokens[from])) {
    const before = tokens[from - 2];
    if (before === undefined || !adjacent(before, tokens[from - 1])) from--;
  }
  const beyond = tokens[from - 1];
  return isBoundary(beyond) ? [from, end] : undefined;
}

/** The operand run starting at `start` (scanning right), as `[start, to]`, or undefined when it is not a whole operand. */
function rightOperand(line: Line, start: number): readonly [number, number] | undefined {
  const { tokens, pairs } = line;
  if (start >= tokens.length) return undefined;
  let to: number;
  if (isSign(tokens[start]) && tokens[start + 1]?.kind === 'number' && adjacent(tokens[start], tokens[start + 1])) {
    to = line.runEnd[start + 1]!;
  } else if (isOpener(tokens[start])) {
    if (pairs[start]! < 0) return undefined;
    to = line.runEnd[pairs[start]!]!;
  } else if (line.operand[start]) {
    to = line.runEnd[start]!;
  } else {
    return undefined;
  }
  const beyond = tokens[to + 1];
  return isBoundary(beyond) ? [start, to] : undefined;
}

function comparisons(line: Line, lineNo: number, out: FactEvidence[]): void {
  const { tokens } = line;
  for (let i = 1; i < tokens.length; i++) {
    const op = tokens[i]!;
    if (op.kind !== 'op' || !COMPARISON_OPS.has(op.text)) continue;
    if (!(line.firstCondition < i || line.lastQuestion > i)) continue;
    const left = leftOperand(line, i - 1);
    const right = rightOperand(line, i + 1);
    if (!left || !right) continue;
    const leftKind = literalOf(tokens, left[0], left[1]);
    const rightKind = literalOf(tokens, right[0], right[1]);
    if ((leftKind === undefined) === (rightKind === undefined)) continue;
    const [from, to] = leftKind !== undefined ? left : right;
    out.push({
      kind: 'comparison',
      line: lineNo,
      text: joinFactText(tokens, left[0], right[1]),
      operator: op.text,
      literal: joinTokens(tokens, from, to),
      literalKind: (leftKind ?? rightKind)!,
    });
  }
}

function caseLabel(line: Line, lineNo: number, out: FactEvidence[]): void {
  const { tokens } = line;
  const first = tokens[0];
  if (first?.kind !== 'word') return;
  const keyword = lowerIfSql(line.style, first.text);
  if (keyword !== 'case' && keyword !== 'when') return;
  const signed = isSign(tokens[1]) && adjacent(tokens[1], tokens[2]) ? 2 : 1;
  if (tokens[signed] === undefined) return;
  const kind = literalOf(tokens, 1, signed);
  if (kind === undefined) return;
  const next = tokens[signed + 1];
  if (next !== undefined && (adjacent(tokens[signed], next) && next.kind !== 'op' && next.kind !== 'punct')) return;
  if (next !== undefined && next.kind === 'op' && !BOUNDARY_OPS.has(next.text) && next.text !== '->') return;
  const literal = joinTokens(tokens, 1, signed);
  out.push({ kind: 'comparison', line: lineNo, text: `case ${literal}`, operator: 'case', literal, literalKind: kind });
}

function calls(line: Line, lineNo: number, options: FactOptions, out: FactEvidence[]): void {
  const { tokens } = line;
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!;
    if (word.kind !== 'word' || !isOp(tokens[i + 1], '(') || !adjacent(word, tokens[i + 1])) continue;
    const member = tokens[i - 1];
    const qualifierToken = member !== undefined && MEMBER_OPS.has(member.text) ? tokens[i - 2] : undefined;
    const qualifier = qualifierToken?.kind === 'word' && adjacent(qualifierToken, member) ? qualifierToken.text : undefined;
    if (!matchesNormalizationPattern(word.text, qualifier, options.normalizationMethods)) continue;
    // The receiver run: the adjacent operand tokens and bracket groups before the method.
    const from = line.runStart[i]!;
    const close = line.pairs[i + 1]!;
    const to = close >= 0 ? close : tokens.length - 1;
    out.push({ kind: 'call', line: lineNo, text: joinFactText(tokens, from, to), method: word.text, ...(qualifier !== undefined ? { qualifier } : {}) });
  }
}

/** A duration expression found on the line, with its token range. */
interface Duration {
  readonly from: number;
  readonly to: number;
  readonly constructor: string;
  readonly unit: DurationUnit;
  readonly amount: string;
}

/** True for a token a numeric constant (FC-7) may hold: numbers, `+ - * /` and parentheses. */
function isNumericToken(t: TextToken): boolean {
  if (t.kind === 'number') return true;
  if (t.kind === 'op') return ARITHMETIC_OPS.has(t.text);
  return t.kind === 'punct' && (t.text === '(' || t.text === ')');
}

/**
 * The amount of a one-argument call whose `(` is at `open`: the argument tokens when they can form a numeric
 * constant (anything else is never a constant, so the duration would be dropped), else undefined.
 */
function numericArgument(line: Line, open: number): { readonly close: number; readonly amount: string } | undefined {
  const close = line.pairs[open]!;
  if (close < 0 || close === open + 1) return undefined;
  for (let k = open + 1; k < close; k++) if (!isNumericToken(line.tokens[k]!)) return undefined;
  return { close, amount: joinTokens(line.tokens, open + 1, close - 1) };
}

/** The last argument of `setTimeout(..., n)` when it can form a numeric constant and the call has two or more arguments. */
function lastNumericArgument(line: Line, open: number): { readonly close: number; readonly amount: string } | undefined {
  const { tokens } = line;
  const close = line.pairs[open]!;
  if (close < 0) return undefined;
  for (let k = close - 1; k > open; k--) {
    const t = tokens[k]!;
    if (t.kind === 'punct' && t.text === ',') {
      return k + 1 <= close - 1 ? { close, amount: joinTokens(tokens, k + 1, close - 1) } : undefined;
    }
    if (!isNumericToken(t)) return undefined;
  }
  return undefined;
}

function durations(line: Line): Duration[] {
  const { tokens } = line;
  const found: Duration[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== 'word') continue;
    // TimeSpan.From<Unit>(n), Duration.of<Unit>(n)
    if ((t.text === 'TimeSpan' || t.text === 'Duration') && isOp(tokens[i + 1], '.') && tokens[i + 2]?.kind === 'word' && isOp(tokens[i + 3], '(')) {
      const unit = (t.text === 'TimeSpan' ? TIMESPAN_UNITS : DURATION_UNITS).get(tokens[i + 2]!.text);
      const call = unit !== undefined ? numericArgument(line, i + 3) : undefined;
      if (unit !== undefined && call !== undefined) {
        found.push({ from: i, to: call.close, constructor: `${t.text}.${tokens[i + 2]!.text}`, unit, amount: call.amount });
      }
      continue;
    }
    // n * time.<Unit>, time.<Unit> * n
    if (t.text === 'time' && isOp(tokens[i + 1], '.') && tokens[i + 2]?.kind === 'word') {
      const unit = GO_TIME_UNITS.get(tokens[i + 2]!.text);
      if (unit === undefined) continue;
      const constructor = `time.${tokens[i + 2]!.text}`;
      if (isOp(tokens[i - 1], '*') && tokens[i - 2]?.kind === 'number') {
        found.push({ from: i - 2, to: i + 2, constructor, unit, amount: tokens[i - 2]!.text });
      } else if (isOp(tokens[i + 3], '*') && tokens[i + 4]?.kind === 'number') {
        found.push({ from: i, to: i + 4, constructor, unit, amount: tokens[i + 4]!.text });
      }
      continue;
    }
    // setTimeout(..., n)
    if (t.text === 'setTimeout' && isOp(tokens[i + 1], '(')) {
      const call = lastNumericArgument(line, i + 1);
      if (call !== undefined) found.push({ from: i, to: call.close, constructor: 'setTimeout', unit: 'ms', amount: call.amount });
    }
  }
  return found;
}

const BINDING_OPS = new Set(['=', ':', ':=']);
const VALUE_ENDS = new Set([';', ',', ')', '}']);

const isValueEnd = (t: TextToken | undefined): boolean => t === undefined || (t.kind === 'punct' && VALUE_ENDS.has(t.text));

function bindingsAndDurations(line: Line, lineNo: number, out: FactEvidence[]): void {
  const { tokens } = line;
  const found = durations(line);
  const byStart = new Map<number, Duration>();
  for (const d of found) if (!byStart.has(d.from)) byStart.set(d.from, d);
  const named = new Map<Duration, string>();
  for (let i = 0; i + 2 < tokens.length; i++) {
    const name = tokens[i]!;
    const op = tokens[i + 1]!;
    if (name.kind !== 'word' || op.kind !== 'op' || !BINDING_OPS.has(op.text)) continue;
    // A duration that is the whole value (up to `;`, `,`, `)`, `}` or the line end) is bound to the name.
    const duration = byStart.get(i + 2);
    if (duration !== undefined && isValueEnd(tokens[duration.to + 1])) {
      named.set(duration, name.text);
      continue;
    }
    if (!hasRetryTimeoutFragment(name.text)) continue;
    // The value runs to `;`, `,`, `)` or `}` at depth 0, or to the line end; only a numeric constant is kept.
    let depth = 0;
    let end = i + 2;
    let numeric = true;
    for (; end < tokens.length; end++) {
      const t = tokens[end]!;
      if (depth === 0 && t.kind === 'punct' && VALUE_ENDS.has(t.text)) break;
      if (!isNumericToken(t)) {
        numeric = false;
        break;
      }
      if (t.text === '(') depth++;
      else if (t.text === ')') depth--;
    }
    if (!numeric || end - 1 < i + 2) continue;
    out.push({ kind: 'binding', line: lineNo, name: name.text, value: joinTokens(tokens, i + 2, end - 1) });
  }
  for (const d of found) {
    const name = named.get(d);
    out.push({ kind: 'duration', line: lineNo, ...(name !== undefined ? { name } : {}), constructor: d.constructor, unit: d.unit, amount: d.amount });
  }
}

/** The decoded content of a string token, or undefined. */
function stringValue(line: Line, t: TextToken | undefined): string | undefined {
  if (t?.kind !== 'string') return undefined;
  const plain = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(t.text);
  if (plain && line.style !== 'sql') {
    const inner = plain[1]!;
    return /\\/.test(inner) ? line.decode(t.text) ?? undefined : inner;
  }
  return line.decode(t.text);
}

/** Verbs from the first `methods=[...]` list on the line (computed once per line). */
function methodsList(line: Line): readonly string[] {
  if (line.methods !== undefined) return line.methods;
  const { tokens } = line;
  let verbs: string[] = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i]!.kind === 'word' && tokens[i]!.text === 'methods' && isOp(tokens[i + 1], '=') && isOp(tokens[i + 2], '[')) {
      const close = line.pairs[i + 2]!;
      verbs = [];
      for (let k = i + 3; k < (close < 0 ? tokens.length : close); k++) {
        const value = stringValue(line, tokens[k]);
        if (value !== undefined && value !== '') verbs.push(value);
      }
      break;
    }
  }
  line.methods = verbs;
  return verbs;
}

/** Go's `HandleFunc` pattern: an optional verb, a space, then the path from its first `/`. */
function httpPattern(pattern: string): { verb: string; route: string } | undefined {
  let verb = 'ANY';
  let rest = pattern.trim();
  const space = rest.search(/[ \t]/);
  if (space >= 0) {
    verb = rest.slice(0, space);
    rest = rest.slice(space).replace(/^[ \t]+/, '');
  }
  const slash = rest.indexOf('/');
  return slash < 0 ? undefined : { verb, route: rest.slice(slash) };
}

function routes(line: Line, lineNo: number, out: FactEvidence[]): void {
  const { tokens } = line;
  const add = (verb: string, route: string): void => {
    out.push({ kind: 'route', line: lineNo, verb, route });
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== 'word' || !isOp(tokens[i + 1], '(')) continue;
    const firstArg = stringValue(line, tokens[i + 2]);
    if (firstArg === undefined) continue;
    const prev = tokens[i - 1];
    // [Http<Verb>("x")]
    const attribute = HTTP_ATTRIBUTE.exec(t.text);
    if (attribute && (isOp(prev, '[') || isOp(prev, ','))) {
      add(attribute[1]!, firstArg);
      continue;
    }
    // @<Verb>Mapping("x")
    const mapping = MAPPING_ANNOTATION.exec(t.text);
    if (mapping && isOp(prev, '@')) {
      add(mapping[1]!, firstArg);
      continue;
    }
    // Map<Verb>("x")
    const map = MAP_CALL.exec(t.text);
    if (map) {
      add(map[1]!, firstArg);
      continue;
    }
    // HandleFunc("x")
    if (t.text === 'HandleFunc') {
      const pattern = httpPattern(firstArg);
      if (pattern) add(pattern.verb, pattern.route);
      continue;
    }
    if (!isOp(prev, '.') || tokens[i - 2]?.kind !== 'word') continue;
    const decorated = isOp(tokens[i - 3], '@');
    // @<word>.(get|post|put|delete|patch|route)("x")
    if (decorated && (DECORATOR_VERBS.has(t.text) || t.text === 'route')) {
      if (t.text === 'route') {
        const verbs = methodsList(line);
        for (const verb of verbs.length > 0 ? verbs : ['ANY']) add(verb, firstArg);
      } else {
        add(t.text, firstArg);
      }
      continue;
    }
    // <word>.(get|post|put|delete|patch|head|options|all)("/x")
    const verb = ROUTER_VERBS.get(t.text);
    if (!decorated && verb !== undefined && firstArg.startsWith('/')) add(verb, firstArg);
  }
}

/**
 * The facts of one file from its text: comparisons, case labels, normalization calls, retry and timeout bindings,
 * durations and routes, each found on a single line, then finished like the plugins' facts (FC-2 to FC-10) with the
 * style's string decoder (W5). Never throws: a line whose rules fail loses its evidence, and a file whose facts
 * cannot be finished gives none (warn-and-continue; the caller keeps the other files).
 */
export function scanTextFacts(file: string, text: string, symbols: readonly SymbolNode[], options: FactOptions): CodeFact[] {
  try {
    const style = commentStyleFor(file);
    const decode = stringDecoderFor(style);
    const byLine = new Map<number, TextToken[]>();
    for (const token of lexSource(text, style)) {
      const list = byLine.get(token.line);
      if (list) list.push(token);
      else byLine.set(token.line, [token]);
    }
    const evidence: FactEvidence[] = [];
    for (const [lineNo, tokens] of byLine) {
      try {
        const line = buildLine(tokens, style, decode);
        comparisons(line, lineNo, evidence);
        caseLabel(line, lineNo, evidence);
        calls(line, lineNo, options, evidence);
        bindingsAndDurations(line, lineNo, evidence);
        routes(line, lineNo, evidence);
      } catch {
        // A heuristic that trips on odd input loses this line's evidence only.
      }
    }
    return finishFacts(file, evidence, symbols, options, decode);
  } catch {
    return [];
  }
}
