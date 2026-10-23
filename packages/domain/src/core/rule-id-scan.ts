import type { FileIndex, SymbolNode } from '@ctxo/cli/internal';
import { DEFAULT_DOMAIN_CONFIG, type DomainConfig } from './domain-config.js';
import type { DomainRegistry } from './registry.js';

/** Card rule ids, and the prefixes of card ids and of registry `rulePrefix` values. */
export interface RuleIndex {
  readonly ids: ReadonlySet<string>;
  readonly prefixes: ReadonlySet<string>;
}

export type RuleRefKind = 'annotation' | 'rule-comment' | 'test-title' | 'category' | 'mention';

export interface RuleRef {
  readonly file: string;
  readonly line: number;
  readonly raw: string;
  /** Normalised to PREFIX-digits. */
  readonly id: string;
  readonly kind: RuleRefKind;
  readonly testTitle?: string;
  readonly symbolId?: string;
  /** The annotation name of 'annotation' and 'category' refs (Trait, Category, TestCategory, Tag). */
  readonly annotation?: string;
}

export interface ScanOptions {
  readonly rules: RuleIndex;
  readonly idPattern: RegExp;
  readonly trackerPrefixes: ReadonlySet<string>;
  readonly ruleTraitKeys: ReadonlySet<string>;
}

export interface RuleLinks {
  readonly links: ReadonlyMap<string, readonly RuleRef[]>;
  readonly unknown: readonly RuleRef[];
}

// P16: `[ \t]*`, never `\s*`, so a comment marker, `rule:` and its ID sit on one line. `\/\*+` covers `/** rule: X */`.
const RULE_COMMENT = /(?:\/\/|\/\*+|#|--|^[ \t]*\*)[ \t]*rule:[ \t]*([A-Za-z][A-Za-z0-9]*[-_]?\d+)(?![A-Za-z0-9])/gim;
const TEST_DECLARATION =
  /(?:\b(?:it|test|describe)(?:\.(?:only|skip))?\s*\(|\bt\.Run\s*\(|@DisplayName\s*\(|\[(?:Fact|Theory)\s*\(\s*DisplayName\s*=)\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const SHAPED_TOKEN = /^([A-Za-z][A-Za-z0-9]*?)[-_]?(\d+)$/;
const SHAPED_TOKEN_AT_START = /^\s*([A-Za-z][A-Za-z0-9]*[-_]?\d+)(?![A-Za-z0-9])/;
const CATEGORY_NAMES: ReadonlySet<string> = new Set(['Category', 'TestCategory', 'Tag']);
const KIND_ORDER: Record<RuleRefKind, number> = { annotation: 0, 'rule-comment': 1, 'test-title': 2, category: 3, mention: 4 };

interface Variant {
  readonly prefix: string;
  readonly body: string;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One variant per known prefix; each letter of the prefix is written [Xx]. Matches carry the digits in group 1. */
function knownVariants(prefixes: ReadonlySet<string>): Variant[] {
  return [...prefixes].sort(compare).map((prefix) => ({
    prefix,
    body:
      [...prefix].map((ch) => (/[A-Za-z]/.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : escapeRegExp(ch))).join('') +
      '[-_]?(\\d+)(?![0-9a-z])',
  }));
}

function matchesIdPattern(pattern: RegExp, id: string): boolean {
  pattern.lastIndex = 0;
  const ok = pattern.test(id);
  pattern.lastIndex = 0;
  return ok;
}

/** Upper-cases the letters and makes the separator '-'; undefined when the token is not ID-shaped. */
function normaliseShaped(token: string, options: ScanOptions): string | undefined {
  const m = SHAPED_TOKEN.exec(token);
  if (m === null) return undefined;
  const id = `${m[1]!.toUpperCase()}-${m[2]!}`;
  return matchesIdPattern(options.idPattern, id) ? id : undefined;
}

/** The ID a text starts with (leading whitespace allowed): a known-ID variant first, then an ID-shaped token. */
function leadingId(text: string, variants: readonly Variant[], options: ScanOptions): { id: string; raw: string } | undefined {
  const rest = text.replace(/^\s+/, '');
  for (const v of variants) {
    const m = new RegExp(`^${v.body}`).exec(rest);
    if (m !== null) return { id: `${v.prefix}-${m[1]!}`, raw: m[0] };
  }
  const shaped = SHAPED_TOKEN_AT_START.exec(text);
  if (shaped === null) return undefined;
  const id = normaliseShaped(shaped[1]!, options);
  return id === undefined ? undefined : { id, raw: shaped[1]! };
}

/** The innermost symbol spanning the 1-based line (index lines are 0-based): smallest span, then index order. */
function innermostSymbol(index: FileIndex | undefined, line: number): SymbolNode | undefined {
  if (index === undefined) return undefined;
  let best: SymbolNode | undefined;
  for (const symbol of index.symbols) {
    if (line < symbol.startLine + 1 || line > symbol.endLine + 1) continue;
    if (best === undefined || symbol.endLine - symbol.startLine < best.endLine - best.startLine) best = symbol;
  }
  return best;
}

/**
 * How far below a `rule:` comment the symbol it introduces may start (F4). The window assumes attribute-inclusive
 * spans, which is what Roslyn, tree-sitter and ts-morph report: a method under any number of stacked attributes or
 * decorators starts at its first attribute, right below the comment.
 */
const LEADING_SYMBOL_LINES = 3;

/**
 * The symbol a `rule:` comment on the 1-based `line` belongs to (F4): the symbol starting within three lines below
 * it (nearest start, then smallest span, then index order), else the innermost symbol spanning the line. A symbol
 * below counts only when it sits inside the innermost symbol that spans the comment (or no symbol spans it), so a
 * comment at the end of a short method body stays with that method and never links to the next declaration.
 */
export function leadingSymbol(index: FileIndex | undefined, line: number): string | undefined {
  if (index === undefined) return undefined;
  const spanning = innermostSymbol(index, line);
  let best: SymbolNode | undefined;
  for (const symbol of index.symbols) {
    const start = symbol.startLine + 1;
    if (start <= line || start > line + LEADING_SYMBOL_LINES) continue;
    if (
      spanning !== undefined &&
      (symbol === spanning || symbol.startLine < spanning.startLine || symbol.endLine > spanning.endLine)
    ) {
      continue;
    }
    if (
      best === undefined ||
      symbol.startLine < best.startLine ||
      (symbol.startLine === best.startLine && symbol.endLine - symbol.startLine < best.endLine - best.startLine)
    ) {
      best = symbol;
    }
  }
  return (best ?? spanning)?.symbolId;
}

/** Scan options from the domain config, the card rule IDs and the registry `rulePrefix` values. */
export function buildScanOptions(config: DomainConfig, ruleIds: Iterable<string>, registry: DomainRegistry | undefined): ScanOptions {
  const ids = new Set<string>();
  const prefixes = new Set<string>();
  for (const id of ruleIds) {
    ids.add(id);
    prefixes.add(prefixOf(id));
  }
  for (const context of registry?.contexts ?? []) if (context.rulePrefix !== undefined) prefixes.add(context.rulePrefix);
  return {
    rules: { ids, prefixes },
    idPattern: idRegExp(config.rules.idPattern),
    trackerPrefixes: new Set(config.rules.trackerPrefixes),
    ruleTraitKeys: new Set(config.tests.ruleTraitKeys),
  };
}

function idRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(DEFAULT_DOMAIN_CONFIG.rules.idPattern);
  }
}

/** Structured references from `Trait` rule keys and category-like annotations, at the symbol's start line. */
export function annotationRefs(index: FileIndex, options: ScanOptions): RuleRef[] {
  const variants = knownVariants(options.rules.prefixes);
  const refs: RuleRef[] = [];
  for (const symbol of index.symbols) {
    for (const annotation of symbol.annotations ?? []) {
      const args = annotation.args ?? [];
      let kind: RuleRefKind | undefined;
      let value: string | undefined;
      if (annotation.name === 'Trait' && args[0] !== undefined && options.ruleTraitKeys.has(args[0])) {
        kind = 'annotation';
        value = args[1];
      } else if (CATEGORY_NAMES.has(annotation.name)) {
        kind = 'category';
        value = args[0];
      }
      if (kind === undefined || value === undefined) continue;
      const found = leadingId(value, variants, options);
      if (found === undefined) continue;
      refs.push({
        file: index.file,
        line: symbol.startLine + 1,
        raw: found.raw,
        id: found.id,
        kind,
        symbolId: symbol.symbolId,
        annotation: annotation.name,
      });
    }
  }
  return refs;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line of a character offset. */
function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The `rule:` comments of a text: 1-based line, the raw ID and its normalised form. */
function ruleCommentMatches(text: string, starts: readonly number[], options: ScanOptions): { line: number; raw: string; id: string }[] {
  const out: { line: number; raw: string; id: string }[] = [];
  for (const m of text.matchAll(new RegExp(RULE_COMMENT.source, RULE_COMMENT.flags))) {
    const raw = m[1]!;
    const id = normaliseShaped(raw, options);
    if (id !== undefined) out.push({ line: lineOf(starts, m.index + m[0].length - raw.length), raw, id });
  }
  return out;
}

/**
 * The `rule:` comments of a production (non-test) file (F4): 'rule-comment' refs only, each linked to the symbol
 * `leadingSymbol` picks. Nothing else in a production file is a reference.
 */
export function scanRuleComments(file: string, text: string, index: FileIndex | undefined, options: ScanOptions): RuleRef[] {
  const refs: RuleRef[] = [];
  const seen = new Set<string>();
  for (const { line, raw, id } of ruleCommentMatches(text, lineStarts(text), options)) {
    const key = `${line}|${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const symbolId = leadingSymbol(index, line);
    refs.push(symbolId === undefined ? { file, line, raw, id, kind: 'rule-comment' } : { file, line, raw, id, kind: 'rule-comment', symbolId });
  }
  return refs.sort((a, b) => a.line - b.line || compare(a.id, b.id));
}

/** Scans one test file's text, plus its indexed annotations, for rule references. */
export function scanTestText(file: string, text: string, index: FileIndex | undefined, options: ScanOptions): RuleRef[] {
  const starts = lineStarts(text);
  const variants = knownVariants(options.rules.prefixes);
  const refs: RuleRef[] = [];
  const titleByLine = new Map<number, string>();
  const seen = new Set<string>();
  const push = (line: number, raw: string, id: string, kind: RuleRefKind): void => {
    const key = `${line}|${id}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    // F4: a `rule:` comment introduces the declaration below it; every other ref sits inside its symbol.
    const symbolId = kind === 'rule-comment' ? leadingSymbol(index, line) : innermostSymbol(index, line)?.symbolId;
    refs.push(symbolId === undefined ? { file, line, raw, id, kind } : { file, line, raw, id, kind, symbolId });
  };

  for (const m of ruleCommentMatches(text, starts, options)) push(m.line, m.raw, m.id, 'rule-comment');

  for (const m of text.matchAll(new RegExp(TEST_DECLARATION.source, TEST_DECLARATION.flags))) {
    const title = m[2]!;
    const line = lineOf(starts, m.index);
    titleByLine.set(line, title);
    const found = leadingId(title, variants, options);
    if (found !== undefined) push(line, found.raw, found.id, 'test-title');
  }

  // Mentions: a known id counts as a mention only when no structured reference of it sits on the line.
  const structuredOnLine = new Set(refs.map((r) => `${r.line}|${r.id}`));
  for (const v of variants) {
    const re = new RegExp(`(?<![A-Za-z0-9])${v.body}`, 'g');
    for (const m of text.matchAll(re)) {
      const line = lineOf(starts, m.index);
      const id = `${v.prefix}-${m[1]!}`;
      if (!structuredOnLine.has(`${line}|${id}`)) push(line, m[0], id, 'mention');
    }
  }

  if (index !== undefined) {
    for (const ref of annotationRefs(index, options)) {
      const symbol = index.symbols.find((s) => s.symbolId === ref.symbolId);
      // A mention of the same id inside the annotated symbol adds nothing to the structured reference.
      for (let i = refs.length - 1; i >= 0; i--) {
        const r = refs[i]!;
        if (r.kind === 'mention' && r.id === ref.id && symbol !== undefined && r.line >= symbol.startLine + 1 && r.line <= symbol.endLine + 1) {
          refs.splice(i, 1);
        }
      }
      refs.push(ref);
    }
  }

  const out = refs.map((ref) => {
    const title = titleByLine.get(ref.line);
    return title === undefined ? ref : { ...ref, testTitle: title };
  });
  out.sort((a, b) => a.line - b.line || compare(a.id, b.id) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return out;
}

/** A tracked test file's text, with its index entry when it has one. */
export interface TestText {
  readonly file: string;
  readonly text: string;
  readonly index?: FileIndex;
}

/**
 * P15: the one test scan of verify-domain and the index pass. Every test text goes through `scanTestText` (which
 * folds in its annotations); indexed test files without a text add their `annotationRefs`.
 */
export function scanTestFiles(
  texts: readonly TestText[],
  indices: readonly FileIndex[],
  isTestFile: (path: string) => boolean,
  options: ScanOptions,
): RuleRef[] {
  const refs: RuleRef[] = [];
  const scanned = new Set<string>();
  for (const test of texts) {
    scanned.add(test.file.replace(/\\/g, '/'));
    refs.push(...scanTestText(test.file, test.text, test.index, options));
  }
  for (const index of indices) {
    if (scanned.has(index.file.replace(/\\/g, '/')) || !isTestFile(index.file)) continue;
    refs.push(...annotationRefs(index, options));
  }
  return refs;
}

function prefixOf(id: string): string {
  const dash = id.indexOf('-');
  return dash < 0 ? id : id.slice(0, dash);
}

/** K6 and K19: links known ids (trackers only through structured refs) and collects unknown ids (PF13). */
export function resolveRuleRefs(refs: readonly RuleRef[], options: ScanOptions): RuleLinks {
  const links = new Map<string, RuleRef[]>();
  const unknown: RuleRef[] = [];
  const seen = new Set<string>();
  const trackers = new Set([...options.trackerPrefixes].map((p) => p.toUpperCase()));
  for (const ref of refs) {
    const key = `${ref.file}|${ref.line}|${ref.id}|${ref.kind}|${ref.symbolId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const prefix = prefixOf(ref.id);
    if (options.rules.ids.has(ref.id)) {
      if (ref.kind !== 'mention' || !trackers.has(prefix.toUpperCase())) {
        const list = links.get(ref.id);
        if (list === undefined) links.set(ref.id, [ref]);
        else list.push(ref);
      }
      continue;
    }
    // Only rule-key annotations, `rule:` comments and titles starting with an ID can be unknown (PF13);
    // a title counts only for a rule prefix (E7). Categories and mentions never do.
    if (ref.kind === 'annotation' || ref.kind === 'rule-comment') unknown.push(ref);
    else if (ref.kind === 'test-title' && options.rules.prefixes.has(prefix)) unknown.push(ref);
  }
  return { links, unknown };
}
