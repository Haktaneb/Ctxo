import type { DomainConfig } from './domain-config.js';
import type {
  ContextNode,
  DecisionNode,
  DomainGraph,
  DomainLink,
  OpenQuestion,
  RuleNode,
  SectionNode,
  TermNode,
  UnresolvedRef,
} from './domain-graph.js';
import type { Ownership } from './ownership.js';
import type { DomainRegistry } from './registry.js';

/**
 * Read-side queries over `graph.json` (spec 11.2, 11.3): one index built per loaded graph, then pure lookups for the
 * enrichers, the domain tools and the search scope. Every order is codepoint or document order; no clock, no I/O.
 */

export type CodeLink = Extract<DomainLink, { readonly kind: 'rule-test' | 'rule-symbol' }>;
export type ProvenanceLink = Extract<DomainLink, { readonly kind: 'decision-provenance' }>;

export interface GraphIndex {
  /** By rule ID (`LEND-03`). */
  readonly rules: ReadonlyMap<string, RuleNode>;
  /** Rule node id (`rule:LEND-03`) to rule ID. */
  readonly ruleIdByNode: ReadonlyMap<string, string>;
  /** By registry context id. */
  readonly contexts: ReadonlyMap<string, ContextNode>;
  /**
   * Every registry context, its rules in card line order. A context whose card is shared with a context of a lower id
   * has an empty list: the card's rules belong to that first context (see `ruleContextByCard`).
   */
  readonly rulesByContext: ReadonlyMap<string, readonly RuleNode[]>;
  /** Card path to the context that owns the card's rules: the first by id of the contexts naming the card. */
  readonly ruleContextByCard: ReadonlyMap<string, string>;
  /** By rule ID: `rule-test` and `rule-symbol` links in graph order. */
  readonly codeLinksByRule: ReadonlyMap<string, readonly CodeLink[]>;
  /** By target symbol ID. */
  readonly codeLinksBySymbol: ReadonlyMap<string, readonly CodeLink[]>;
  /** By target file: the links without a `symbolId`. */
  readonly fileLinksByFile: ReadonlyMap<string, readonly CodeLink[]>;
  /** Date descending, then `n` ascending. */
  readonly decisionsByContext: ReadonlyMap<string, readonly DecisionNode[]>;
  /** Decision node id to the rule IDs it names, codepoint order. */
  readonly decisionRules: ReadonlyMap<string, readonly string[]>;
  /** Decision node id to its provenance links, in the order they appear in the decision text. */
  readonly decisionProvenance: ReadonlyMap<string, readonly ProvenanceLink[]>;
  /** Context (or `*` for repo-wide) to terms: card terms by line, then glossary terms by line. */
  readonly termsByContext: ReadonlyMap<string, readonly TermNode[]>;
  /** Term node id to linked symbol IDs: exact matches first, then partial, each in codepoint order. */
  readonly termIdentifiers: ReadonlyMap<string, readonly string[]>;
  readonly sectionsByContext: ReadonlyMap<string, readonly SectionNode[]>;
  readonly openQuestionsByContext: ReadonlyMap<string, readonly OpenQuestion[]>;
  /** By rule ID. */
  readonly unresolvedByRule: ReadonlyMap<string, readonly UnresolvedRef[]>;
}

export interface DomainSnapshot {
  readonly registry: DomainRegistry;
  readonly registryPath: string;
  readonly config: DomainConfig;
  readonly ownership: Ownership;
  readonly graph: DomainGraph;
  readonly index: GraphIndex;
  /** The cards or the glossary changed since `graph.json` was written. */
  readonly staleCards: boolean;
  /** Increases on every reload of the state. */
  readonly generation: number;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

export function indexGraph(graph: DomainGraph): GraphIndex {
  const rules = new Map<string, RuleNode>();
  const ruleIdOfNode = new Map<string, string>();
  for (const rule of graph.rules) {
    rules.set(rule.ruleId, rule);
    ruleIdOfNode.set(rule.id, rule.ruleId);
  }

  const contexts = new Map<string, ContextNode>();
  const rulesByContext = new Map<string, RuleNode[]>();
  const cardContexts = new Map<string, string[]>();
  for (const context of graph.contexts) {
    contexts.set(context.context, context);
    rulesByContext.set(context.context, []);
    if (context.card !== undefined) push(cardContexts, context.card, context.context);
  }
  const ruleContextByCard = new Map<string, string>();
  for (const [card, ids] of cardContexts) ruleContextByCard.set(card, [...ids].sort(compare)[0]!);
  for (const rule of [...graph.rules].sort((a, b) => compare(a.card, b.card) || a.line - b.line)) {
    push(rulesByContext, rule.context, rule);
  }

  const codeLinksByRule = new Map<string, CodeLink[]>();
  const codeLinksBySymbol = new Map<string, CodeLink[]>();
  const fileLinksByFile = new Map<string, CodeLink[]>();
  const decisionRules = new Map<string, string[]>();
  const provenance = new Map<string, ProvenanceLink[]>();
  const exact = new Map<string, string[]>();
  const partial = new Map<string, string[]>();
  for (const link of graph.links) {
    switch (link.kind) {
      case 'rule-test':
      case 'rule-symbol': {
        const ruleId = ruleIdOfNode.get(link.from);
        if (ruleId === undefined) break;
        push(codeLinksByRule, ruleId, link);
        if (link.to.symbolId !== undefined) push(codeLinksBySymbol, link.to.symbolId, link);
        else push(fileLinksByFile, link.to.file, link);
        break;
      }
      case 'decision-rule': {
        const ruleId = ruleIdOfNode.get(link.to);
        if (ruleId === undefined) break;
        const list = decisionRules.get(link.from);
        if (list === undefined) decisionRules.set(link.from, [ruleId]);
        else if (!list.includes(ruleId)) list.push(ruleId);
        break;
      }
      case 'decision-provenance':
        push(provenance, link.from, link);
        break;
      case 'term-identifier':
        push(link.match === 'exact' ? exact : partial, link.from, link.to.symbolId);
        break;
    }
  }
  for (const list of decisionRules.values()) list.sort(compare);

  const decisionsByContext = new Map<string, DecisionNode[]>();
  for (const decision of graph.decisions) push(decisionsByContext, decision.context, decision);
  for (const list of decisionsByContext.values()) list.sort(byNewest);

  // Text order from the stored offsets; the sort is stable, so equal offsets keep the graph order.
  const offsetOf = (link: ProvenanceLink): number => (Number.isFinite(link.offset) ? link.offset : Number.MAX_SAFE_INTEGER);
  const decisionProvenance = new Map<string, ProvenanceLink[]>();
  for (const [id, links] of provenance) decisionProvenance.set(id, [...links].sort((x, y) => offsetOf(x) - offsetOf(y)));

  const termsByContext = new Map<string, TermNode[]>();
  const termIdentifiers = new Map<string, string[]>();
  const firstCardLine = (term: TermNode): number | undefined => term.definitions.find((d) => d.origin === 'card')?.at.line;
  const firstLine = (term: TermNode): number => firstCardLine(term) ?? term.definitions[0]?.at.line ?? 0;
  for (const term of graph.terms) {
    push(termsByContext, term.context, term);
    termIdentifiers.set(term.id, [...(exact.get(term.id) ?? []), ...(partial.get(term.id) ?? [])]);
  }
  for (const list of termsByContext.values()) {
    list.sort((a, b) => {
      const aCard = firstCardLine(a) === undefined ? 1 : 0;
      const bCard = firstCardLine(b) === undefined ? 1 : 0;
      return aCard - bCard || firstLine(a) - firstLine(b) || compare(a.id, b.id);
    });
  }

  const sectionsByContext = new Map<string, SectionNode[]>();
  for (const section of graph.sections) push(sectionsByContext, section.context, section);
  const openQuestionsByContext = new Map<string, OpenQuestion[]>();
  for (const question of graph.openQuestions) push(openQuestionsByContext, question.context, question);
  const unresolvedByRule = new Map<string, UnresolvedRef[]>();
  for (const ref of graph.unresolved) push(unresolvedByRule, ref.rule, ref);

  return {
    rules,
    ruleIdByNode: ruleIdOfNode,
    contexts,
    rulesByContext,
    ruleContextByCard,
    codeLinksByRule,
    codeLinksBySymbol,
    fileLinksByFile,
    decisionsByContext,
    decisionRules,
    decisionProvenance,
    termsByContext,
    termIdentifiers,
    sectionsByContext,
    openQuestionsByContext,
    unresolvedByRule,
  };
}

function byNewest(a: DecisionNode, b: DecisionNode): number {
  return compare(b.date, a.date) || a.n - b.n;
}

/** The file of a canonical `<file>::<name>::<kind>` symbol ID; undefined for IDs that name no file. */
function fileOfSymbolId(id: string): string | undefined {
  const parts = id.split('::');
  return parts.length >= 3 && parts[0] !== '' ? parts[0] : undefined;
}

export interface RuleMatch {
  readonly ruleId: string;
  readonly via: readonly { readonly symbolId: string; readonly link: 'code' | 'test' }[];
}

/**
 * The rules linked to the given symbols. A code link matches a symbol when its target is that symbol, or when it
 * is a file-level link to the symbol's file. `via` lists each symbol once per link kind in input order (`code`
 * before `test` for one symbol); matches in rule ID order.
 */
export function rulesForSymbols(index: GraphIndex, symbolIds: readonly string[]): RuleMatch[] {
  const via = new Map<string, { symbolId: string; link: 'code' | 'test' }[]>();
  const seen = new Set<string>();
  for (const symbolId of symbolIds) {
    if (seen.has(symbolId)) continue;
    seen.add(symbolId);
    const file = fileOfSymbolId(symbolId);
    const links = [...(index.codeLinksBySymbol.get(symbolId) ?? []), ...(file === undefined ? [] : (index.fileLinksByFile.get(file) ?? []))];
    const kinds = new Map<string, Set<'code' | 'test'>>();
    for (const link of links) {
      const ruleId = index.ruleIdByNode.get(link.from);
      if (ruleId === undefined) continue;
      const set = kinds.get(ruleId) ?? new Set();
      set.add(link.kind === 'rule-symbol' ? 'code' : 'test');
      kinds.set(ruleId, set);
    }
    for (const [ruleId, set] of kinds) {
      for (const link of ['code', 'test'] as const) if (set.has(link)) push(via, ruleId, { symbolId, link });
    }
  }
  return [...via].sort((a, b) => compare(a[0], b[0])).map(([ruleId, list]) => ({ ruleId, via: list }));
}

const RULE_ID_VARIANT = /^([A-Za-z][A-Za-z0-9]*?)[-_]?(\d+)$/;

/** `lend03`, `Lend_03` and `LEND-03` all give `LEND-03`, when that is a rule; else undefined. */
export function canonicalRuleId(index: GraphIndex, raw: string): string | undefined {
  const match = RULE_ID_VARIANT.exec(raw.trim());
  if (match === null) return undefined;
  const id = `${match[1]!.toUpperCase()}-${match[2]!}`;
  return index.rules.has(id) ? id : undefined;
}

/**
 * The decisions of a context (F9): those naming a rule in `preferRules` (rule IDs) first, then the others, each
 * group newest first and then by `n`; at most `limit`.
 */
export function decisionsForContext(index: GraphIndex, context: string, preferRules: ReadonlySet<string>, limit = 5): DecisionNode[] {
  const preferred: DecisionNode[] = [];
  const others: DecisionNode[] = [];
  for (const decision of index.decisionsByContext.get(context) ?? []) {
    const rules = index.decisionRules.get(decision.id) ?? [];
    (rules.some((id) => preferRules.has(id)) ? preferred : others).push(decision);
  }
  return [...preferred, ...others].slice(0, Math.max(0, limit));
}

/** The rules of the given contexts without a `rule-test` link, in context then card order (`untested` kept). */
export function rulesWithoutTests(index: GraphIndex, contexts: readonly string[]): RuleNode[] {
  const out: RuleNode[] = [];
  const seen = new Set<string>();
  for (const context of contexts) {
    if (seen.has(context)) continue;
    seen.add(context);
    for (const rule of index.rulesByContext.get(context) ?? []) {
      const tested = (index.codeLinksByRule.get(rule.ruleId) ?? []).some((link) => link.kind === 'rule-test');
      if (!tested) out.push(rule);
    }
  }
  return out;
}

export interface LinkSourceView {
  readonly source: string;
  readonly annotation?: string;
  readonly file: string;
  readonly line: number;
}

export interface TestRefView {
  readonly file: string;
  readonly symbolId?: string;
  readonly testName?: string;
  readonly sources: readonly LinkSourceView[];
}

export interface CodeRefView {
  readonly file: string;
  readonly symbolId?: string;
  readonly fallback?: true;
  readonly sources: readonly LinkSourceView[];
}

export type ProvenanceView =
  | { readonly kind: 'file'; readonly path: string; readonly exists: boolean; readonly label?: string }
  | { readonly kind: 'external'; readonly value: string; readonly label?: string };

export interface DecisionView {
  readonly id: string;
  readonly date: string;
  readonly text: string;
  readonly card: string;
  readonly line: number;
  readonly rules: readonly string[];
  readonly provenance: readonly ProvenanceView[];
}

const SOURCE_ORDER: readonly string[] = ['annotation', 'category', 'test-title', 'card-code', 'rule-comment', 'card-tests', 'mention'];

function sourceRank(source: string): number {
  const rank = SOURCE_ORDER.indexOf(source);
  return rank === -1 ? SOURCE_ORDER.length : rank;
}

/** Links of one kind grouped by target (`symbolId ?? file`), targets in codepoint order, sources in source order. */
function grouped<L extends CodeLink>(links: readonly L[]): { file: string; symbolId?: string; links: L[] }[] {
  const groups = new Map<string, { file: string; symbolId?: string; links: L[] }>();
  for (const link of links) {
    const key = link.to.symbolId ?? link.to.file;
    const group = groups.get(key);
    if (group) group.links.push(link);
    else groups.set(key, { file: link.to.file, ...(link.to.symbolId === undefined ? {} : { symbolId: link.to.symbolId }), links: [link] });
  }
  return [...groups]
    .sort((a, b) => compare(a[0], b[0]))
    .map(([, group]) => {
      group.links.sort(
        (a, b) => sourceRank(a.source) - sourceRank(b.source) || compare(a.at.file, b.at.file) || a.at.line - b.at.line,
      );
      return group;
    });
}

function sourceView(link: CodeLink): LinkSourceView {
  return {
    source: link.source,
    ...(link.kind === 'rule-test' && link.annotation !== undefined ? { annotation: link.annotation } : {}),
    file: link.at.file,
    line: link.at.line,
  };
}

/** The tests of a rule, one entry per test target. */
export function testRefs(index: GraphIndex, ruleId: string): TestRefView[] {
  const links = (index.codeLinksByRule.get(ruleId) ?? []).filter(
    (link): link is Extract<CodeLink, { readonly kind: 'rule-test' }> => link.kind === 'rule-test',
  );
  return grouped(links).map((group) => {
    const testName = group.links.find((link) => link.testName !== undefined)?.testName;
    return {
      file: group.file,
      ...(group.symbolId === undefined ? {} : { symbolId: group.symbolId }),
      ...(testName === undefined ? {} : { testName }),
      sources: group.links.map(sourceView),
    };
  });
}

/** The code of a rule, one entry per target; `fallback` when every link fell back to the file. */
export function codeRefs(index: GraphIndex, ruleId: string): CodeRefView[] {
  const links = (index.codeLinksByRule.get(ruleId) ?? []).filter(
    (link): link is Extract<CodeLink, { readonly kind: 'rule-symbol' }> => link.kind === 'rule-symbol',
  );
  return grouped(links).map((group) => ({
    file: group.file,
    ...(group.symbolId === undefined ? {} : { symbolId: group.symbolId }),
    ...(group.links.every((link) => link.fallback === true) ? { fallback: true as const } : {}),
    sources: group.links.map(sourceView),
  }));
}

function provenanceView(link: ProvenanceLink): ProvenanceView {
  const label = link.label === undefined ? {} : { label: link.label };
  return link.to.kind === 'file'
    ? { kind: 'file', path: link.to.path, exists: link.to.exists, ...label }
    : { kind: 'external', value: link.to.value, ...label };
}

/** A decision with the rule IDs it names and its provenance in text order. */
export function decisionView(index: GraphIndex, decision: DecisionNode): DecisionView {
  return {
    id: decision.id,
    date: decision.date,
    text: decision.text,
    card: decision.card,
    line: decision.line,
    rules: [...(index.decisionRules.get(decision.id) ?? [])],
    provenance: (index.decisionProvenance.get(decision.id) ?? []).map(provenanceView),
  };
}
