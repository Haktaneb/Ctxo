import { ruleNodeId, type CardRuleRefs, type CodeTarget, type DomainLink, type Location, type UnresolvedRef } from './domain-graph.js';
import type { RuleLinks } from './rule-id-scan.js';

/**
 * Rule-to-test links (spec 11.2, designer calls F3 to F5): the resolved test references of the scan, and the
 * `Tests:` lines of the cards. Pure: the index and the file system are reached through `RefLookup`. Lines are 1-based.
 */

export interface RefLookup {
  hasSymbol(symbolId: string): boolean;
  symbolName(symbolId: string): string | undefined;
  fileExists(repoPath: string): boolean;
}

export interface CardRefResolution {
  readonly target?: CodeTarget;
  readonly problem?: 'missing-file' | 'not-a-symbol';
}

type RuleTestLink = Extract<DomainLink, { readonly kind: 'rule-test' }>;

/** Backslashes become `/` and a leading `./` is dropped. */
function normaliseRef(value: string): string {
  const slashed = value.trim().replace(/\\/g, '/');
  return slashed.startsWith('./') ? slashed.slice(2) : slashed;
}

/** The file part of a card value ends at the first `::` (symbol ID) or `#` (`file#Name`, P5), trimmed like 2B's testPath. */
function filePart(value: string): string {
  let end = value.length;
  const symbol = value.indexOf('::');
  const hash = value.indexOf('#');
  if (symbol >= 0) end = symbol;
  if (hash >= 0 && hash < end) end = hash;
  return value.slice(0, end).trim();
}

/** The repo file a card `Tests:` or `Code:` value names, normalised as `resolveCardRef` reads it. */
export function cardRefFile(value: string): string {
  return filePart(normaliseRef(value));
}

/** One unresolved card ref per rule, field, normalised value and location: `x` and `./x` are one finding. */
export function unresolvedKey(ref: UnresolvedRef): string {
  return [ref.rule, ref.field, normaliseRef(ref.value), ref.at.file, String(ref.at.line)].join('\n');
}

/** F3: a value with `::` is a symbol ID; one missing from the index falls back to its file. */
export function resolveCardRef(value: string, lookup: RefLookup): CardRefResolution {
  const normalised = normaliseRef(value);
  const file = filePart(normalised);
  if (normalised.includes('::')) {
    if (lookup.hasSymbol(normalised)) return { target: { file, symbolId: normalised } };
    return lookup.fileExists(file) ? { target: { file }, problem: 'not-a-symbol' } : { problem: 'missing-file' };
  }
  return lookup.fileExists(file) ? { target: { file } } : { problem: 'missing-file' };
}

/** `line` is already 1-based (P3). */
export function toLocation(file: string, line: number): Location {
  return { file, line };
}

function target(file: string, symbolId: string | undefined): CodeTarget {
  return symbolId === undefined ? { file } : { file, symbolId };
}

function linkKey(link: RuleTestLink): string {
  return [link.from, link.to.file, link.to.symbolId ?? '', link.source, link.at.file, String(link.at.line)].join('\n');
}

export function ruleTestLinks(input: {
  readonly cardRefs: readonly CardRuleRefs[];
  readonly testRefs: RuleLinks;
  readonly lookup: RefLookup;
}): { readonly links: DomainLink[]; readonly unresolved: UnresolvedRef[] } {
  const links: DomainLink[] = [];
  const unresolved: UnresolvedRef[] = [];
  const seen = new Set<string>();
  const seenUnresolved = new Set<string>();
  const add = (link: RuleTestLink): void => {
    const key = linkKey(link);
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  for (const [id, refs] of input.testRefs.links) {
    for (const ref of refs) {
      // F5: the captured test title, else the linked symbol's name.
      const testName = ref.testTitle ?? (ref.symbolId === undefined ? undefined : input.lookup.symbolName(ref.symbolId));
      add({
        kind: 'rule-test',
        from: ruleNodeId(id),
        to: target(ref.file, ref.symbolId),
        source: ref.kind,
        at: toLocation(ref.file, ref.line),
        ...(ref.annotation === undefined ? {} : { annotation: ref.annotation }),
        ...(testName === undefined ? {} : { testName }),
      });
    }
  }

  for (const card of input.cardRefs) {
    const at = toLocation(card.card, card.testsLine);
    for (const value of card.tests) {
      const resolved = resolveCardRef(value, input.lookup);
      if (resolved.problem !== undefined) {
        const problem: UnresolvedRef = { rule: card.ruleId, field: 'Tests', value, at, reason: resolved.problem };
        const key = unresolvedKey(problem);
        if (!seenUnresolved.has(key)) {
          seenUnresolved.add(key);
          unresolved.push(problem);
        }
      }
      if (resolved.target === undefined) continue;
      const symbolId = resolved.target.symbolId;
      const testName = symbolId === undefined ? undefined : input.lookup.symbolName(symbolId);
      add({
        kind: 'rule-test',
        from: ruleNodeId(card.ruleId),
        to: resolved.target,
        source: 'card-tests',
        at,
        ...(testName === undefined ? {} : { testName }),
        ...(resolved.problem === 'not-a-symbol' ? { fallback: true as const } : {}),
      });
    }
  }

  return { links, unresolved };
}
