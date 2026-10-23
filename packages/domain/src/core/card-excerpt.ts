import { rulesForSymbols, type DomainSnapshot } from './domain-graph-query.js';
import type { TermNode } from './domain-graph.js';
import { estimateTokens } from './token-estimate.js';

/**
 * The card excerpt `get_context_for_task` carries (spec 11.3, F10): the rules linked to the target and its
 * neighbours, the target context's terms and its outbound contracts, packed greedily into a token budget. Pure.
 */

export const EXCERPT_RULE_TEXT_MAX = 600;
export const EXCERPT_DEFINITION_MAX = 200;
export const EXCERPT_CONTRACTS_TEXT_MAX = 400;

export interface ExcerptRule {
  readonly ruleId: string;
  readonly title: string;
  readonly linkedTo: 'target' | 'neighbour';
  readonly text?: string;
}

export interface ExcerptTerm {
  readonly term: string;
  readonly definition: string;
}

export interface ExcerptContracts {
  readonly outbound: readonly { readonly target: string; readonly files: readonly string[] }[];
  readonly text?: string;
}

export interface CardExcerpt {
  readonly context?: string;
  readonly card?: string;
  readonly rules: readonly ExcerptRule[];
  readonly terms: readonly ExcerptTerm[];
  readonly contracts?: ExcerptContracts;
  readonly tokens: number;
  readonly omitted: number;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `text` cut to `max` characters, the cut ones ending with `...`. */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** The file of a canonical `<file>::<name>::<kind>` symbol ID; a value without `::` is a file path itself. */
function fileOfTarget(id: string): string | undefined {
  const parts = id.split('::');
  if (parts.length === 1) return id === '' ? undefined : id;
  return parts.length >= 3 && parts[0] !== '' ? parts[0] : undefined;
}

type Candidate =
  | { readonly kind: 'rule'; readonly value: ExcerptRule }
  | { readonly kind: 'term'; readonly value: ExcerptTerm }
  | { readonly kind: 'contracts'; readonly value: ExcerptContracts };

/**
 * The excerpt for `target` with its `neighbours` (the symbols of the code context), within `budget` tokens. Packed
 * greedily in this order, an entry that does not fit is skipped and counted in `omitted`: rules linked to the target
 * (text capped at `EXCERPT_RULE_TEXT_MAX`), rules linked only to neighbours (no text), the target context's terms
 * (those with an identifier among the target and neighbours first, then card order; definitions joined with ` / `
 * and capped at `EXCERPT_DEFINITION_MAX`), then the context's outbound registry contracts with the `Boundary
 * contracts` text capped at `EXCERPT_CONTRACTS_TEXT_MAX`. Each entry costs `estimateTokens(entry)`, the empty wrapper
 * `estimateTokens` of itself; then the excerpt is measured as sent and the last kept entry dropped (into `omitted`)
 * until it fits. `tokens` is that measurement: `estimateTokens(excerpt) === excerpt.tokens`. `context` and `card` are
 * absent when the target's file has no single owner (rules still come through links). When the wrapper alone exceeds
 * the budget, nothing is kept, every entry counts in `omitted` and `tokens` is the wrapper's size (the caller leaves
 * such an excerpt out).
 */
export function buildCardExcerpt(snapshot: DomainSnapshot, target: string, neighbours: readonly string[], budget: number): CardExcerpt {
  const { index, ownership, registry } = snapshot;
  const file = fileOfTarget(target);
  const context = file === undefined ? undefined : ownership.ownerOf(file);
  const card = context === undefined ? undefined : registry.contexts.find((c) => c.id === context)?.card;
  const head = {
    ...(context === undefined ? {} : { context }),
    ...(card === undefined ? {} : { card }),
  };

  const candidates: Candidate[] = [];
  const targetRules = rulesForSymbols(index, [target]);
  const targetIds = new Set(targetRules.map((match) => match.ruleId));
  for (const match of targetRules) {
    const rule = index.rules.get(match.ruleId);
    if (rule === undefined) continue;
    const text = cap(rule.text.trim(), EXCERPT_RULE_TEXT_MAX);
    candidates.push({
      kind: 'rule',
      value: { ruleId: rule.ruleId, title: rule.title, linkedTo: 'target', ...(text === '' ? {} : { text }) },
    });
  }
  const others = neighbours.filter((id) => id !== target);
  for (const match of rulesForSymbols(index, others)) {
    if (targetIds.has(match.ruleId)) continue;
    const rule = index.rules.get(match.ruleId);
    if (rule === undefined) continue;
    candidates.push({ kind: 'rule', value: { ruleId: rule.ruleId, title: rule.title, linkedTo: 'neighbour' } });
  }

  if (context !== undefined) {
    const nearby = new Set([target, ...others]);
    const terms = index.termsByContext.get(context) ?? [];
    const linked = (term: TermNode): boolean => (index.termIdentifiers.get(term.id) ?? []).some((id) => nearby.has(id));
    const ordered = [...terms.filter(linked), ...terms.filter((term) => !linked(term))];
    for (const term of ordered) {
      const definition = cap(term.definitions.map((d) => d.text.trim()).join(' / '), EXCERPT_DEFINITION_MAX);
      candidates.push({ kind: 'term', value: { term: term.term, definition } });
    }

    const contracts = registry.contexts.find((c) => c.id === context)?.contracts ?? {};
    const outbound = Object.keys(contracts)
      .sort(compare)
      .map((to) => ({ target: to, files: [...contracts[to]!] }));
    const section = (index.sectionsByContext.get(context) ?? []).find((s) => s.kind === 'contracts');
    const text = section === undefined ? '' : cap(section.text.trim(), EXCERPT_CONTRACTS_TEXT_MAX);
    if (outbound.length > 0 || text !== '') {
      candidates.push({ kind: 'contracts', value: { outbound, ...(text === '' ? {} : { text }) } });
    }
  }

  const wrapper = estimateTokens({ ...head, rules: [], terms: [], tokens: 0, omitted: 0 });
  if (wrapper > budget) return assemble(head, [], candidates.length);

  const kept: Candidate[] = [];
  let estimate = wrapper;
  let omitted = 0;
  for (const candidate of candidates) {
    const cost = estimateTokens(candidate.value);
    if (estimate + cost > budget) {
      omitted += 1;
      continue;
    }
    estimate += cost;
    kept.push(candidate);
  }
  // The estimate leaves out the JSON separators and the digits of `tokens` and `omitted`: measure the excerpt as it
  // is sent, and drop the last kept entry until that measurement fits.
  for (;;) {
    const excerpt = assemble(head, kept, omitted);
    if (excerpt.tokens <= budget || kept.length === 0) return excerpt;
    kept.pop();
    omitted += 1;
  }
}

/** The excerpt of the kept entries, `tokens` set to its own measured size (`estimateTokens` of the result). */
function assemble(head: { readonly context?: string; readonly card?: string }, kept: readonly Candidate[], omitted: number): CardExcerpt {
  const rules: ExcerptRule[] = [];
  const terms: ExcerptTerm[] = [];
  let contracts: ExcerptContracts | undefined;
  for (const candidate of kept) {
    if (candidate.kind === 'rule') rules.push(candidate.value);
    else if (candidate.kind === 'term') terms.push(candidate.value);
    else contracts = candidate.value;
  }
  const body = { ...head, rules, terms, ...(contracts === undefined ? {} : { contracts }) };
  // `tokens` is part of what it measures: settle on a value that equals the size of the excerpt holding it.
  let tokens = 0;
  for (let i = 0; i < 8; i++) {
    const measured = estimateTokens({ ...body, tokens, omitted });
    if (measured === tokens) break;
    tokens = Math.max(tokens, measured);
  }
  return { ...body, tokens, omitted };
}

/** The `tokens` of the excerpt for the target alone with an unlimited budget: what the reservation keeps back. */
export function targetExcerptTokens(snapshot: DomainSnapshot, target: string): number {
  return buildCardExcerpt(snapshot, target, [], Number.POSITIVE_INFINITY).tokens;
}
