// Text-scan fact evidence (PR 4 Part 2, issue #156, H2): single-line heuristics over the text lexer's tokens for
// files whose plugin has no fact detector and for languages without a plugin. The evidence goes through the same
// finisher as the plugins' (the domain copy of finish-facts.ts), so the facts follow the fact contract.
import type { CodeFact, SymbolNode } from '@ctxo/cli/internal';
import type { DurationUnit, FactEvidence, FactOptions, LiteralKind } from './facts/fact-types.js';
import { matchesNormalizationPattern } from './facts/fact-rules.js';
import { finishFacts } from './facts/finish-facts.js';
import { commentStyleFor, lexSource, stringDecoderFor } from './text-lexer.js';
import type { CommentStyle, TextToken } from './text-lexer.js';

const COMPARISON_OPS = new Set(['==', '!=', '===', '!==', '<', '<=', '>', '>=']);
const CONDITION_WORDS = new Set(['if', 'elif', 'elsif', 'while', 'until', 'unless', 'when', 'guard']);
const LOGICAL_WORDS = new Set(['and', 'or', 'not']);
/** Operator tokens that end an operand run (FC-3 stops) or sit next to a whole operand (assignment, ternary). */
const BOUNDARY_OPS = new Set(['&&', '||', '!', ':', '?', '=', ':=', '=>']);
const MEMBER_OPS = new Set(['.', '::', '->', '?.']);
const LITERAL_WORDS: Readonly<Record<string, LiteralKind>> = {
  null: 'null',
  nil: 'null',
  None: 'null',
  true: 'boolean',
  false: 'boolean',
  True: 'boolean',
  False: 'boolean',
};
const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

const TIMESPAN_UNITS: Readonly<Record<string, DurationUnit>> = {
  FromMilliseconds: 'ms', FromSeconds: 's', FromMinutes: 'min', FromHours: 'h', FromDays: 'd', FromMicroseconds: 'us',
};
const DURATION_UNITS: Readonly<Record<string, DurationUnit>> = {
  ofMillis: 'ms', ofSeconds: 's', ofMinutes: 'min', ofHours: 'h', ofDays: 'd', ofNanos: 'ns',
};
const GO_TIME_UNITS: Readonly<Record<string, DurationUnit>> = {
  Nanosecond: 'ns', Microsecond: 'us', Millisecond: 'ms', Second: 's', Minute: 'min', Hour: 'h',
};
const ROUTER_VERBS: Readonly<Record<string, string>> = {
  get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH', head: 'HEAD', options: 'OPTIONS', all: 'ANY',
};
const DECORATOR_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch']);
const HTTP_ATTRIBUTE = /^Http(Get|Post|Put|Delete|Patch|Head|Options)$/;
const MAPPING_ANNOTATION = /^(Get|Post|Put|Delete|Patch)Mapping$/;
const MAP_CALL = /^Map(Get|Post|Put|Delete|Patch)$/;

/** One line's tokens and what the rules need to know about them. */
interface Line {
  readonly tokens: readonly TextToken[];
  readonly style: CommentStyle;
  readonly decode: (literal: string) => string | undefined;
}

const adjacent = (a: TextToken | undefined, b: TextToken | undefined): boolean => a !== undefined && b !== undefined && a.end === b.start;
const isOp = (t: TextToken | undefined, text: string): boolean => t !== undefined && (t.kind === 'op' || t.kind === 'punct') && t.text === text;

/** The tokens from `from` to `to` (inclusive) as text, one space where the source had a gap. */
function joinTokens(tokens: readonly TextToken[], from: number, to: number): string {
  let out = '';
  for (let k = from; k <= to; k++) {
    if (k > from && tokens[k - 1]!.end !== tokens[k]!.start) out += ' ';
    out += tokens[k]!.text;
  }
  return out;
}

/** The index of the bracket matching the one at `at`, on this line, or -1. */
function matching(tokens: readonly TextToken[], at: number): number {
  const open = tokens[at]!.text;
  const forward = OPENERS[open] !== undefined;
  const close = forward ? OPENERS[open]! : CLOSERS[open];
  if (close === undefined) return -1;
  let depth = 0;
  for (let k = at; forward ? k < tokens.length : k >= 0; k += forward ? 1 : -1) {
    const t = tokens[k]!;
    if (t.kind !== 'punct') continue;
    if (t.text === open) depth++;
    else if (t.text === close && --depth === 0) return k;
  }
  return -1;
}

function lowerIfSql(line: Line, word: string): string {
  return line.style === 'sql' ? word.toLowerCase() : word;
}

function isConditionWord(line: Line, t: TextToken | undefined): boolean {
  return t !== undefined && t.kind === 'word' && CONDITION_WORDS.has(lowerIfSql(line, t.text));
}

/** True for a token that can be part of an operand run: words (not stops), numbers, strings and member operators. */
function isOperandToken(line: Line, t: TextToken): boolean {
  if (t.kind === 'word') return !LOGICAL_WORDS.has(lowerIfSql(line, t.text)) && !isConditionWord(line, t);
  if (t.kind === 'number' || t.kind === 'string') return true;
  return MEMBER_OPS.has(t.text);
}

/** True when the token beyond an operand run lets the run stand as a whole operand. */
function isBoundary(t: TextToken | undefined): boolean {
  if (t === undefined || t.kind === 'word' || t.kind === 'punct') return true;
  return t.kind === 'op' && BOUNDARY_OPS.has(t.text);
}

/** The literal kind of a single-token operand (or a sign followed by a number), or undefined. */
function literalOf(tokens: readonly TextToken[], from: number, to: number): LiteralKind | undefined {
  if (from === to) {
    const t = tokens[from]!;
    if (t.kind === 'number') return 'number';
    if (t.kind === 'string') return 'string';
    if (t.kind === 'word') return LITERAL_WORDS[t.text];
    return undefined;
  }
  if (to === from + 1 && (isOp(tokens[from], '-') || isOp(tokens[from], '+')) && tokens[to]!.kind === 'number' && adjacent(tokens[from], tokens[to])) {
    return 'number';
  }
  return undefined;
}

/** The operand run ending at `end` (scanning left), as `[from, end]`, or undefined when it is not a whole operand. */
function leftOperand(line: Line, end: number): readonly [number, number] | undefined {
  const { tokens } = line;
  let k = end;
  let from = -1;
  while (k >= 0) {
    if (from !== -1 && !adjacent(tokens[k], tokens[from])) break;
    const t = tokens[k]!;
    if (t.kind === 'punct' && CLOSERS[t.text] !== undefined) {
      const open = matching(tokens, k);
      if (open < 0) break;
      from = open;
      k = open - 1;
      continue;
    }
    if (!isOperandToken(line, t)) break;
    from = k;
    k--;
  }
  if (from === -1) return undefined;
  // A sign directly before a number ("-5 < x").
  if (from === end && tokens[end]!.kind === 'number' && (isOp(tokens[from - 1], '-') || isOp(tokens[from - 1], '+')) && adjacent(tokens[from - 1], tokens[from])) {
    const before = tokens[from - 2];
    if (before === undefined || !adjacent(before, tokens[from - 1])) from--;
  }
  const beyond = tokens[from - 1];
  if (beyond !== undefined && beyond.kind === 'punct' && OPENERS[beyond.text] !== undefined) return [from, end];
  return isBoundary(beyond) ? [from, end] : undefined;
}

/** The operand run starting at `start` (scanning right), as `[start, to]`, or undefined when it is not a whole operand. */
function rightOperand(line: Line, start: number): readonly [number, number] | undefined {
  const { tokens } = line;
  let k = start;
  let to = -1;
  if ((isOp(tokens[k], '-') || isOp(tokens[k], '+')) && tokens[k + 1]?.kind === 'number' && adjacent(tokens[k], tokens[k + 1])) {
    to = k + 1;
    k += 2;
  }
  while (k < tokens.length) {
    if (to !== -1 && !adjacent(tokens[to], tokens[k])) break;
    const t = tokens[k]!;
    if (t.kind === 'punct' && OPENERS[t.text] !== undefined) {
      const close = matching(tokens, k);
      if (close < 0) break;
      to = close;
      k = close + 1;
      continue;
    }
    if (!isOperandToken(line, t)) break;
    to = k;
    k++;
  }
  if (to === -1) return undefined;
  const beyond = tokens[to + 1];
  if (beyond !== undefined && beyond.kind === 'punct' && CLOSERS[beyond.text] !== undefined) return [start, to];
  return isBoundary(beyond) ? [start, to] : undefined;
}

function comparisons(line: Line, lineNo: number, out: FactEvidence[]): void {
  const { tokens } = line;
  for (let i = 0; i < tokens.length; i++) {
    const op = tokens[i]!;
    if (op.kind !== 'op' || !COMPARISON_OPS.has(op.text)) continue;
    let condition = false;
    for (let k = 0; k < i && !condition; k++) condition = isConditionWord(line, tokens[k]);
    for (let k = i + 1; k < tokens.length && !condition; k++) condition = isOp(tokens[k], '?');
    if (!condition || i === 0) continue;
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
      text: joinTokens(tokens, left[0], right[1]),
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
  const keyword = lowerIfSql(line, first.text);
  if (keyword !== 'case' && keyword !== 'when') return;
  const signed = (isOp(tokens[1], '-') || isOp(tokens[1], '+')) && adjacent(tokens[1], tokens[2]) ? 2 : 1;
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
    let from = i;
    let k = i - 1;
    while (k >= 0 && adjacent(tokens[k], tokens[from])) {
      const t = tokens[k]!;
      if (t.kind === 'punct' && CLOSERS[t.text] !== undefined) {
        const open = matching(tokens, k);
        if (open < 0) break;
        from = open;
        k = open - 1;
        continue;
      }
      if (!isOperandToken(line, t)) break;
      from = k;
      k--;
    }
    const close = matching(tokens, i + 1);
    const to = close >= 0 ? close : tokens.length - 1;
    out.push({ kind: 'call', line: lineNo, text: joinTokens(tokens, from, to), method: word.text, ...(qualifier !== undefined ? { qualifier } : {}) });
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

/** The top-level arguments of the call whose `(` is at `open`, as token ranges; undefined without a `)` on the line. */
function callArguments(tokens: readonly TextToken[], open: number): { readonly close: number; readonly args: readonly (readonly [number, number])[] } | undefined {
  const close = matching(tokens, open);
  if (close < 0) return undefined;
  const args: (readonly [number, number])[] = [];
  let start = open + 1;
  let depth = 0;
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k]!;
    if (t.kind === 'punct' && OPENERS[t.text] !== undefined) depth++;
    else if (t.kind === 'punct' && CLOSERS[t.text] !== undefined) depth--;
    else if (depth === 0 && t.text === ',' && t.kind === 'punct') {
      args.push([start, k - 1]);
      start = k + 1;
    }
  }
  if (start <= close - 1) args.push([start, close - 1]);
  return { close, args };
}

function durations(line: Line): Duration[] {
  const { tokens } = line;
  const found: Duration[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== 'word') continue;
    // TimeSpan.From<Unit>(n), Duration.of<Unit>(n)
    if ((t.text === 'TimeSpan' || t.text === 'Duration') && isOp(tokens[i + 1], '.') && tokens[i + 2]?.kind === 'word' && isOp(tokens[i + 3], '(')) {
      const unit = (t.text === 'TimeSpan' ? TIMESPAN_UNITS : DURATION_UNITS)[tokens[i + 2]!.text];
      const call = unit !== undefined ? callArguments(tokens, i + 3) : undefined;
      if (unit !== undefined && call !== undefined && call.args.length === 1) {
        const [a, b] = call.args[0]!;
        found.push({ from: i, to: call.close, constructor: `${t.text}.${tokens[i + 2]!.text}`, unit, amount: joinTokens(tokens, a, b) });
      }
      continue;
    }
    // n * time.<Unit>, time.<Unit> * n
    if (t.text === 'time' && isOp(tokens[i + 1], '.') && tokens[i + 2]?.kind === 'word') {
      const unit = GO_TIME_UNITS[tokens[i + 2]!.text];
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
      const call = callArguments(tokens, i + 1);
      if (call !== undefined && call.args.length >= 2) {
        const [a, b] = call.args[call.args.length - 1]!;
        found.push({ from: i, to: call.close, constructor: 'setTimeout', unit: 'ms', amount: joinTokens(tokens, a, b) });
      }
    }
  }
  return found;
}

const BINDING_OPS = new Set(['=', ':', ':=']);
const VALUE_ENDS = new Set([';', ',', ')', '}']);

function bindingsAndDurations(line: Line, lineNo: number, out: FactEvidence[]): void {
  const { tokens } = line;
  const found = durations(line);
  const named = new Map<Duration, string>();
  for (let i = 0; i + 2 < tokens.length; i++) {
    const name = tokens[i]!;
    const op = tokens[i + 1]!;
    if (name.kind !== 'word' || op.kind !== 'op' || !BINDING_OPS.has(op.text)) continue;
    // The value runs to `;`, `,`, `)` or `}` at depth 0, or to the line end.
    let depth = 0;
    let end = i + 2;
    for (; end < tokens.length; end++) {
      const t = tokens[end]!;
      if (t.kind !== 'punct') continue;
      if (OPENERS[t.text] !== undefined) depth++;
      else if (depth === 0 && VALUE_ENDS.has(t.text)) break;
      else if (CLOSERS[t.text] !== undefined) depth--;
    }
    const last = end - 1;
    if (last < i + 2) continue;
    const duration = found.find((d) => d.from === i + 2 && d.to === last);
    if (duration !== undefined) {
      named.set(duration, name.text);
      continue;
    }
    out.push({ kind: 'binding', line: lineNo, name: name.text, value: joinTokens(tokens, i + 2, last) });
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

/** Verbs from a `methods=[...]` list on the line. */
function methodsList(line: Line): string[] {
  const { tokens } = line;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i]!.kind === 'word' && tokens[i]!.text === 'methods' && isOp(tokens[i + 1], '=') && isOp(tokens[i + 2], '[')) {
      const close = matching(tokens, i + 2);
      const verbs: string[] = [];
      for (let k = i + 3; k < (close < 0 ? tokens.length : close); k++) {
        const value = stringValue(line, tokens[k]);
        if (value !== undefined && value !== '') verbs.push(value);
      }
      return verbs;
    }
  }
  return [];
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
    const verb = ROUTER_VERBS[t.text];
    if (!decorated && verb !== undefined && firstArg.startsWith('/')) add(verb, firstArg);
  }
}

/**
 * The facts of one file from its text: comparisons, case labels, normalization calls, retry and timeout bindings,
 * durations and routes, each found on a single line, then finished like the plugins' facts (FC-2 to FC-10) with the
 * style's string decoder (W5). Never throws.
 */
export function scanTextFacts(file: string, text: string, symbols: readonly SymbolNode[], options: FactOptions): CodeFact[] {
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
    const line: Line = { tokens, style, decode };
    try {
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
}
