import type { ResponseEnricher, TokenReservation } from '@ctxo/cli/internal';
import { buildCardExcerpt, targetExcerptTokens } from '../core/card-excerpt.js';
import { decisionsForContext, decisionView, rulesForSymbols, type DomainSnapshot } from '../core/domain-graph-query.js';
import { ADDITIVE_CAP } from '../core/limits.js';
import type { DomainState } from './domain-state.js';

/**
 * The domain graph fields on `get_blast_radius`, `get_why_context` and `get_context_for_task` (spec 11.3, F8 to
 * F10, F15). Each enricher returns the payload unchanged unless `state.load()` is ok (E3: no registry, an invalid
 * or stale registry, or no graph add nothing); then its fields appear, possibly empty. All are synchronous.
 */

type Payload = Record<string, unknown>;

/** The most decisions `get_why_context` carries (F9). */
export const DECISIONS_CAP = 5;
/** The most `via` entries one `rulesAffected` entry lists; `viaCount` holds the full count. */
export const VIA_CAP = 5;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRecord(value: unknown): value is Payload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `symbolId` strings of a payload list's entries, in list order. */
function symbolIdsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) if (isRecord(entry) && typeof entry['symbolId'] === 'string') ids.push(entry['symbolId']);
  return ids;
}

/** The file part of a symbol ID; a value without `::` is taken as a file path (PR 2B's `contextDrift` rule). */
function fileOfArg(id: string): string | undefined {
  const parts = id.split('::');
  if (parts.length === 1) return id === '' ? undefined : id;
  return parts.length >= 3 && parts[0] !== '' ? parts[0] : undefined;
}

/** Sets `name` to the first `ADDITIVE_CAP` entries and `<name>Total` to the full count only when entries were cut. */
function setCapped(payload: Payload, name: string, list: readonly unknown[]): void {
  payload[name] = list.slice(0, ADDITIVE_CAP);
  if (list.length > ADDITIVE_CAP) payload[`${name}Total`] = list.length;
}

const withSnapshot =
  (state: DomainState, apply: (payload: Payload, args: Readonly<Payload>, snapshot: DomainSnapshot) => void): ResponseEnricher =>
  (payload, args) => {
    const loaded = state.load();
    if (loaded.ok) apply(payload, args, loaded.snapshot);
    return payload;
  };

/**
 * `rulesAffected` and `cardsToUpdate` for the root (`payload.symbolId`) and the impacted symbols. Rules whose `via`
 * holds the root come first, then rule ID order; each lists its first `VIA_CAP` matched symbols and `viaCount`.
 * `cardsToUpdate` holds each card of those rules once, with the context owning its rules, in card path order.
 */
export function blastRadiusDomainFields(state: DomainState): ResponseEnricher {
  return withSnapshot(state, (payload, _args, { index }) => {
    const rootId = typeof payload['symbolId'] === 'string' ? payload['symbolId'] : undefined;
    const symbols = [...(rootId === undefined ? [] : [rootId]), ...symbolIdsOf(payload['impactedSymbols'])];
    const matches = rulesForSymbols(index, symbols);
    const viaRoot = (via: readonly { readonly symbolId: string }[]): number => (via.some((v) => v.symbolId === rootId) ? 0 : 1);
    const rules = matches
      .map((match) => ({ match, rule: index.rules.get(match.ruleId) }))
      .filter((entry) => entry.rule !== undefined)
      .sort((a, b) => viaRoot(a.match.via) - viaRoot(b.match.via) || compare(a.match.ruleId, b.match.ruleId))
      .map(({ match, rule }) => ({
        ruleId: match.ruleId,
        title: rule!.title,
        context: rule!.context,
        card: rule!.card,
        via: match.via.slice(0, VIA_CAP).map((v) => ({ symbolId: v.symbolId, link: v.link })),
        viaCount: match.via.length,
      }));
    const cards = new Map<string, { context: string; card: string }>();
    for (const rule of rules) if (!cards.has(rule.card)) cards.set(rule.card, { context: rule.context, card: rule.card });
    const cardList = [...cards.values()].sort((a, b) => compare(a.card, b.card) || compare(a.context, b.context));
    setCapped(payload, 'rulesAffected', rules);
    setCapped(payload, 'cardsToUpdate', cardList);
  });
}

/**
 * `decisions` of the single context owning the file part of `args.symbolId` (F9): those naming a rule linked to the
 * symbol first, then the others, each group newest first; at most `DECISIONS_CAP`, with `decisionsTotal` when more
 * exist. `[]` when the file has no single owner.
 */
export function whyContextDomainFields(state: DomainState): ResponseEnricher {
  return withSnapshot(state, (payload, args, { index, ownership }) => {
    const symbolId = typeof args['symbolId'] === 'string' ? args['symbolId'] : undefined;
    const file = symbolId === undefined ? undefined : fileOfArg(symbolId);
    const context = file === undefined ? undefined : ownership.ownerOf(file);
    if (symbolId === undefined || context === undefined) {
      payload['decisions'] = [];
      return;
    }
    const prefer = new Set(rulesForSymbols(index, [symbolId]).map((match) => match.ruleId));
    const all = decisionsForContext(index, context, prefer, Number.MAX_SAFE_INTEGER);
    payload['decisions'] = all.slice(0, DECISIONS_CAP).map((decision) => decisionView(index, decision));
    if (all.length > DECISIONS_CAP) payload['decisionsTotal'] = all.length;
  });
}

/**
 * `cardExcerpt` (F10) for `args.symbolId` with the code context's symbols as neighbours, in the budget the code
 * context left: `tokenBudget - totalTokens`. Left out when even the empty excerpt does not fit, so the sum never
 * exceeds the budget.
 */
export function taskContextDomainFields(state: DomainState): ResponseEnricher {
  return withSnapshot(state, (payload, args, snapshot) => {
    const symbolId = args['symbolId'];
    if (typeof symbolId !== 'string') return;
    const budget = Number(payload['tokenBudget']) - Number(payload['totalTokens']);
    if (!Number.isFinite(budget)) return;
    const excerpt = buildCardExcerpt(snapshot, symbolId, symbolIdsOf(payload['context']), Math.max(budget, 0));
    if (excerpt.tokens <= budget) payload['cardExcerpt'] = excerpt;
  });
}

/** The tokens kept back for the excerpt: `targetExcerptTokens` for `args.symbolId`, 0 when the state is not ok. */
export function taskContextReservation(state: DomainState): TokenReservation {
  return (args) => {
    const symbolId = args['symbolId'];
    if (typeof symbolId !== 'string') return 0;
    const loaded = state.load();
    return loaded.ok ? targetExcerptTokens(loaded.snapshot, symbolId) : 0;
  };
}
