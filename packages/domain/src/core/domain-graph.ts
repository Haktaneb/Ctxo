import { createHash } from 'node:crypto';
import type { CardDecision, GlossaryItem, ParsedCard } from './card-parser.js';
import type { DomainContext, DomainRegistry, Rung } from './registry.js';

/**
 * The domain graph model (spec 11.2, designer calls F1 and F2): node types, node IDs, the nodes built from the
 * registry, the cards and the glossary, the cards hash and the canonical sort. Pure: no I/O. Lines are 1-based.
 * Links are built elsewhere (rule to test, rule to symbol, decision, term) and composed with these nodes.
 */

export const DOMAIN_GRAPH_ARTIFACT = 'domain-graph';
/** The context of repo-wide glossary terms; no context id can be `*`. */
export const REPO_WIDE_CONTEXT = '*';

/** Repo-relative path, 1-based line. */
export interface Location {
  readonly file: string;
  readonly line: number;
}

export interface ContextNode {
  readonly id: string;
  readonly context: string;
  readonly name: string;
  readonly rung: Rung;
  readonly card?: string;
  readonly rulePrefix?: string;
}

export interface RuleNode {
  readonly id: string;
  readonly ruleId: string;
  readonly context: string;
  readonly card: string;
  readonly title: string;
  readonly line: number;
  readonly text: string;
  readonly untested?: string;
}

export interface TermDefinition {
  readonly text: string;
  readonly at: Location;
  readonly origin: 'card' | 'glossary';
}

export interface TermNode {
  readonly id: string;
  readonly context: string;
  readonly key: string;
  readonly term: string;
  readonly definitions: readonly TermDefinition[];
  readonly identifierCount: number;
}

export interface DecisionNode {
  readonly id: string;
  readonly context: string;
  readonly card: string;
  readonly date: string;
  readonly n: number;
  readonly line: number;
  readonly text: string;
}

export interface SectionNode {
  readonly id: string;
  readonly context: string;
  readonly card: string;
  readonly heading: string;
  readonly kind: 'intro' | 'contracts' | 'open-questions' | 'other';
  readonly line: number;
  readonly text: string;
  readonly references?: readonly string[];
}

export interface OpenQuestion {
  readonly context: string;
  readonly card: string;
  readonly line: number;
  readonly text: string;
}

/** No `symbolId`: a file-level link. */
export interface CodeTarget {
  readonly file: string;
  readonly symbolId?: string;
}

export type ProvenanceTarget =
  | { readonly kind: 'file'; readonly path: string; readonly exists: boolean }
  | { readonly kind: 'external'; readonly value: string };

export type RuleTestSource = 'annotation' | 'category' | 'test-title' | 'rule-comment' | 'mention' | 'card-tests';

export type DomainLink =
  | {
      readonly kind: 'rule-test';
      readonly from: string;
      readonly to: CodeTarget;
      readonly source: RuleTestSource;
      readonly at: Location;
      readonly annotation?: string;
      readonly testName?: string;
      readonly fallback?: true;
    }
  | {
      readonly kind: 'rule-symbol';
      readonly from: string;
      readonly to: CodeTarget;
      readonly source: 'card-code' | 'rule-comment';
      readonly at: Location;
      readonly fallback?: true;
    }
  | {
      readonly kind: 'decision-provenance';
      readonly from: string;
      readonly to: ProvenanceTarget;
      readonly source: 'card-link' | 'card-text';
      readonly at: Location;
      readonly label?: string;
    }
  | { readonly kind: 'decision-rule'; readonly from: string; readonly to: string; readonly source: 'card-text'; readonly at: Location }
  | {
      readonly kind: 'term-identifier';
      readonly from: string;
      readonly to: { readonly file: string; readonly symbolId: string };
      readonly source: 'symbol-name' | 'table-name';
      readonly match: 'exact' | 'partial';
    };

export interface UnresolvedRef {
  readonly rule: string;
  readonly field: 'Tests' | 'Code';
  readonly value: string;
  readonly at: Location;
  readonly reason: 'missing-file' | 'not-a-symbol';
}

export interface DomainGraph {
  readonly ctxoArtifact: 'domain-graph';
  readonly version: 1;
  readonly registryHash: string;
  readonly cardsHash: string;
  readonly contexts: readonly ContextNode[];
  readonly rules: readonly RuleNode[];
  readonly terms: readonly TermNode[];
  readonly decisions: readonly DecisionNode[];
  readonly sections: readonly SectionNode[];
  readonly openQuestions: readonly OpenQuestion[];
  readonly links: readonly DomainLink[];
  readonly unresolved: readonly UnresolvedRef[];
}

export interface CardRuleRefs {
  readonly ruleId: string;
  readonly card: string;
  readonly tests: readonly string[];
  readonly testsLine: number;
  readonly code: readonly string[];
  readonly codeLine: number;
}

/** `card` absent: the card file is missing. */
export interface CardInput {
  readonly context: DomainContext;
  readonly path: string;
  readonly card?: ParsedCard;
}

export interface GraphNodes {
  readonly contexts: ContextNode[];
  readonly rules: RuleNode[];
  readonly terms: TermNode[];
  readonly decisions: DecisionNode[];
  readonly sections: SectionNode[];
  readonly openQuestions: OpenQuestion[];
  readonly cardRefs: CardRuleRefs[];
  /** By decision node id. */
  readonly parsedDecisions: ReadonlyMap<string, CardDecision>;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const compareNumber = (a: number, b: number): number => a - b;

const LANGUAGE_H2 = 'Language';
const RULES_H2 = 'Rules and invariants';
const CONTRACTS_H2 = 'Boundary contracts';
const DECISIONS_H2 = 'Decisions';
const OPEN_QUESTIONS_H2 = 'Open questions';

export function contextNodeId(context: string): string {
  return `context:${context}`;
}

export function ruleNodeId(ruleId: string): string {
  return `rule:${ruleId}`;
}

/** Trimmed, lowercased, whitespace runs become `-`. */
export function termKey(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, '-');
}

export function termNodeId(context: string, term: string): string {
  return `term:${context}/${termKey(term)}`;
}

export function decisionNodeId(context: string, date: string, n: number): string {
  return `decision:${context}/${date}-${n}`;
}

function sectionNodeId(card: string, line: number): string {
  return `section:${card}:${line}`;
}

interface TermDraft {
  readonly context: string;
  readonly key: string;
  readonly term: string;
  readonly definitions: TermDefinition[];
}

export function buildGraphNodes(input: {
  readonly registry: DomainRegistry;
  readonly cards: readonly CardInput[];
  readonly glossary?: { readonly path: string; readonly items: readonly GlossaryItem[] };
  readonly warn?: (message: string) => void;
}): GraphNodes {
  const warn = input.warn ?? (() => undefined);

  const contexts: ContextNode[] = input.registry.contexts.map((ctx) => ({
    id: contextNodeId(ctx.id),
    context: ctx.id,
    name: ctx.name,
    rung: ctx.rung,
    ...(ctx.card === undefined ? {} : { card: ctx.card }),
    ...(ctx.rulePrefix === undefined ? {} : { rulePrefix: ctx.rulePrefix }),
  }));

  const present = input.cards.filter((c): c is CardInput & { readonly card: ParsedCard } => c.card !== undefined);

  // Rules: a duplicate ID keeps the first by card path, then line.
  const candidates = present
    .flatMap((c) => c.card.rules.map((rule) => ({ input: c, rule })))
    .sort((a, b) => compare(a.input.path, b.input.path) || compareNumber(a.rule.line, b.rule.line));
  const kept = new Map<string, string>();
  const rules: RuleNode[] = [];
  const cardRefs: CardRuleRefs[] = [];
  for (const { input: c, rule } of candidates) {
    const first = kept.get(rule.id);
    if (first !== undefined) {
      warn(`rule ${rule.id} is defined in ${first} and ${c.path}; keeping the first`);
      continue;
    }
    kept.set(rule.id, c.path);
    rules.push({
      id: ruleNodeId(rule.id),
      ruleId: rule.id,
      context: c.context.id,
      card: c.path,
      title: rule.title,
      line: rule.line,
      text: rule.text,
      ...(rule.untested === undefined ? {} : { untested: rule.untested }),
    });
    cardRefs.push({
      ruleId: rule.id,
      card: c.path,
      tests: [...rule.tests],
      testsLine: rule.testsLine ?? rule.line,
      code: [...rule.code],
      codeLine: rule.codeLine ?? rule.line,
    });
  }

  // Terms: card items first (cards in input order), then glossary items, merged by context and key.
  const drafts = new Map<string, TermDraft>();
  const addTerm = (context: string, term: string, definition: TermDefinition): void => {
    const key = termKey(term);
    const id = termNodeId(context, term);
    const draft = drafts.get(id);
    if (draft) draft.definitions.push(definition);
    else drafts.set(id, { context, key, term, definitions: [definition] });
  };
  for (const c of present) {
    for (const item of c.card.terms) {
      addTerm(c.context.id, item.term, { text: item.definition, at: { file: c.path, line: item.line }, origin: 'card' });
    }
  }
  if (input.glossary) {
    const known = new Set(input.registry.contexts.map((ctx) => ctx.id));
    for (const item of input.glossary.items) {
      let context = REPO_WIDE_CONTEXT;
      if (item.context !== undefined) {
        if (known.has(item.context)) context = item.context;
        else warn(`${input.glossary.path}:${item.line} names unknown context "${item.context}"`);
      }
      addTerm(context, item.term, { text: item.definition, at: { file: input.glossary.path, line: item.line }, origin: 'glossary' });
    }
  }
  const terms: TermNode[] = [...drafts].map(([id, draft]) => ({
    id,
    context: draft.context,
    key: draft.key,
    term: draft.term,
    definitions: draft.definitions,
    identifierCount: 0,
  }));

  // Decisions: `n` counts same-date decisions of the context in document order, from 1.
  const decisions: DecisionNode[] = [];
  const parsedDecisions = new Map<string, CardDecision>();
  const counters = new Map<string, number>();
  for (const c of present) {
    for (const decision of c.card.decisions) {
      const counterKey = `${c.context.id}\n${decision.date}`;
      const n = (counters.get(counterKey) ?? 0) + 1;
      counters.set(counterKey, n);
      const id = decisionNodeId(c.context.id, decision.date, n);
      decisions.push({ id, context: c.context.id, card: c.path, date: decision.date, n, line: decision.line, text: decision.text });
      parsedDecisions.set(id, decision);
    }
  }

  // Sections: the intro, contracts, open questions and every H2 outside the template; the rest is split above.
  const sections: SectionNode[] = [];
  const openQuestions: OpenQuestion[] = [];
  for (const c of present) {
    const base = { context: c.context.id, card: c.path };
    if (c.card.intro) {
      sections.push({
        id: sectionNodeId(c.path, c.card.intro.line),
        ...base,
        heading: c.card.title ?? '',
        kind: 'intro',
        line: c.card.intro.line,
        text: c.card.intro.text,
      });
    }
    for (const section of c.card.sections) {
      if (section.heading === LANGUAGE_H2 || section.heading === RULES_H2 || section.heading === DECISIONS_H2) continue;
      const kind = section.heading === CONTRACTS_H2 ? 'contracts' : section.heading === OPEN_QUESTIONS_H2 ? 'open-questions' : 'other';
      sections.push({
        id: sectionNodeId(c.path, section.line),
        ...base,
        heading: section.heading,
        kind,
        line: section.line,
        text: section.text,
        ...(kind === 'contracts' ? { references: [...c.card.contractRefs] } : {}),
      });
    }
    for (const question of c.card.openQuestions) openQuestions.push({ ...base, line: question.line, text: question.text });
  }

  return { contexts, rules, terms, decisions, sections, openQuestions, cardRefs, parsedDecisions };
}

function normalizeText(text: string): string {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return noBom.replace(/\r\n?/g, '\n');
}

/** First 16 hex of SHA-256 over `<path>\n<text>\n` per file in path order; `<missing>` for an absent text. */
export function cardsHash(files: readonly { readonly path: string; readonly text?: string }[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => compare(a.path, b.path))) {
    hash.update(`${file.path}\n${file.text === undefined ? '<missing>' : normalizeText(file.text)}\n`);
  }
  return hash.digest('hex').slice(0, 16);
}

function linkTargetKey(link: DomainLink): string {
  switch (link.kind) {
    case 'rule-test':
    case 'rule-symbol':
    case 'term-identifier':
      return link.to.symbolId ?? link.to.file;
    case 'decision-provenance':
      return link.to.kind === 'file' ? link.to.path : link.to.value;
    case 'decision-rule':
      return link.to;
  }
}

function compareLinks(a: DomainLink, b: DomainLink): number {
  const aAt = 'at' in a ? a.at : undefined;
  const bAt = 'at' in b ? b.at : undefined;
  return (
    compare(a.kind, b.kind) ||
    compare(a.from, b.from) ||
    compare(linkTargetKey(a), linkTargetKey(b)) ||
    compare(a.source, b.source) ||
    compare(aAt?.file ?? '', bAt?.file ?? '') ||
    compareNumber(aAt?.line ?? 0, bAt?.line ?? 0) ||
    // Links equal on every key above (a file and a symbol target of one file, differing test names) still get one
    // order, so shuffled input gives byte-identical JSON.
    compare(JSON.stringify(a), JSON.stringify(b))
  );
}

const byId = (a: { readonly id: string }, b: { readonly id: string }): number => compare(a.id, b.id);
const byCardLine = (a: { readonly card: string; readonly line: number }, b: { readonly card: string; readonly line: number }): number =>
  compare(a.card, b.card) || compareNumber(a.line, b.line);

/** The canonical order of every array, codepoint order throughout. Returns a new graph; the input is unchanged. */
export function sortGraph(graph: DomainGraph): DomainGraph {
  return {
    ctxoArtifact: graph.ctxoArtifact,
    version: graph.version,
    registryHash: graph.registryHash,
    cardsHash: graph.cardsHash,
    contexts: [...graph.contexts].sort(byId),
    rules: [...graph.rules].sort(byId),
    terms: [...graph.terms].sort(byId),
    decisions: [...graph.decisions].sort(byId),
    sections: [...graph.sections].sort((a, b) => byCardLine(a, b) || compare(a.id, b.id)),
    openQuestions: [...graph.openQuestions].sort((a, b) => byCardLine(a, b) || compare(a.text, b.text)),
    links: [...graph.links].sort(compareLinks),
    unresolved: [...graph.unresolved].sort(
      (a, b) =>
        compare(a.rule, b.rule) ||
        compare(a.field, b.field) ||
        compare(a.value, b.value) ||
        compare(a.at.file, b.at.file) ||
        compareNumber(a.at.line, b.at.line) ||
        compare(a.reason, b.reason),
    ),
  };
}
