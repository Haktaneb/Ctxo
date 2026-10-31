import { ruleNodeId, type CardRuleRefs, type CodeTarget, type DomainLink, type UnresolvedRef } from './domain-graph.js';
import type { RuleLinks } from './rule-id-scan.js';
import { resolveCardRef, toLocation, unresolvedKey, type RefLookup } from './rule-test-links.js';

/**
 * Rule-to-symbol links (spec 11.2, designer calls F3 and F4): the card `Code:` lines, and the resolved `rule:`
 * comments of indexed non-test files (`scanRuleComments`). A `rule:` comment in a test file stays a rule-test link.
 * Pure: the index and the file system are reached through `RefLookup`. Lines are 1-based.
 */

type RuleSymbolLink = Extract<DomainLink, { readonly kind: 'rule-symbol' }>;

function target(file: string, symbolId: string | undefined): CodeTarget {
  return symbolId === undefined ? { file } : { file, symbolId };
}

function linkKey(link: RuleSymbolLink): string {
  return [link.from, link.to.file, link.to.symbolId ?? '', link.source, link.at.file, String(link.at.line)].join('\n');
}

export function ruleSymbolLinks(input: {
  readonly cardRefs: readonly CardRuleRefs[];
  readonly codeRefs: RuleLinks;
  readonly lookup: RefLookup;
}): { readonly links: DomainLink[]; readonly unresolved: UnresolvedRef[] } {
  const links: DomainLink[] = [];
  const unresolved: UnresolvedRef[] = [];
  const seen = new Set<string>();
  const seenUnresolved = new Set<string>();
  const add = (link: RuleSymbolLink): void => {
    const key = linkKey(link);
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  for (const [id, refs] of input.codeRefs.links) {
    for (const ref of refs) {
      if (ref.kind !== 'rule-comment') continue;
      add({ kind: 'rule-symbol', from: ruleNodeId(id), to: target(ref.file, ref.symbolId), source: 'rule-comment', at: toLocation(ref.file, ref.line) });
    }
  }

  for (const card of input.cardRefs) {
    const at = toLocation(card.card, card.codeLine);
    for (const value of card.code) {
      const resolved = resolveCardRef(value, input.lookup);
      if (resolved.problem !== undefined) {
        const problem: UnresolvedRef = { rule: card.ruleId, field: 'Code', value, at, reason: resolved.problem };
        const key = unresolvedKey(problem);
        if (!seenUnresolved.has(key)) {
          seenUnresolved.add(key);
          unresolved.push(problem);
        }
      }
      if (resolved.target === undefined) continue;
      add({
        kind: 'rule-symbol',
        from: ruleNodeId(card.ruleId),
        to: resolved.target,
        source: 'card-code',
        at,
        ...(resolved.problem === 'not-a-symbol' ? { fallback: true as const } : {}),
      });
    }
  }

  return { links, unresolved };
}
