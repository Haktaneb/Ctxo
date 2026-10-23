import type { SymbolNode } from '@ctxo/cli/internal';
import { REPO_WIDE_CONTEXT, type DomainLink, type TermNode } from './domain-graph.js';

/**
 * Term-to-identifier links (spec 11.2, designer call F7): a glossary or card term links to the symbols whose name
 * carries its words, as a contiguous token run with plural folding. Pure: the tokenizer is the host's
 * `splitIdentifier` and the data resource kinds are the host's `dataResourceKinds` (pre-flight P14).
 */

/** Links kept per term in the artifact; `counts` holds every match. */
export const TERM_IDENTIFIER_CAP = 50;
/** Types before members; a kind not listed sorts after `variable`. */
export const TERM_KIND_ORDER: readonly string[] = ['class', 'interface', 'type', 'table', 'view', 'procedure', 'function', 'method', 'variable'];
/** A term whose tokens are all shorter than this links nothing. */
const MIN_TOKEN_LENGTH = 3;

export type SplitIdentifier = (name: string) => string[];

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function normalise(words: readonly string[], split: SplitIdentifier): string[] {
  return words
    .flatMap((word) => split(word))
    .map((token) => token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((token) => token !== '');
}

/** The term split on whitespace, each word through `split`, lowercased, letters and digits only. */
export function termTokens(term: string, split: SplitIdentifier): string[] {
  return normalise(term.split(/\s+/).filter((w) => w !== ''), split);
}

/** The same over the last `.` segment of the name, a trailing `(...)` (C# parameters) removed first. */
export function identifierTokens(name: string, split: SplitIdentifier): string[] {
  const open = name.indexOf('(');
  const bare = open !== -1 && name.trimEnd().endsWith(')') ? name.slice(0, open) : name;
  const last = bare.slice(bare.lastIndexOf('.') + 1);
  return normalise([last], split);
}

function tokenMatches(identifier: string, term: string): boolean {
  return (
    identifier === term ||
    identifier === `${term}s` ||
    identifier === `${term}es` ||
    (term.endsWith('y') && identifier === `${term.slice(0, -1)}ies`)
  );
}

/** The term tokens as a contiguous run of identifier tokens; `exact` when the run is the whole identifier. */
export function tokensMatch(identifier: readonly string[], term: readonly string[]): 'exact' | 'partial' | undefined {
  if (term.length === 0 || term.length > identifier.length) return undefined;
  for (let start = 0; start + term.length <= identifier.length; start++) {
    if (term.every((t, i) => tokenMatches(identifier[start + i]!, t))) return term.length === identifier.length ? 'exact' : 'partial';
  }
  return undefined;
}

/** `context` absent: the symbol's file belongs to no context (only repo-wide terms reach it). */
export interface TermCandidate {
  readonly symbol: SymbolNode;
  readonly file: string;
  readonly context?: string;
  /** A symbol of a test file; it never matches a term. */
  readonly isTest?: boolean;
}

function kindRank(kind: string): number {
  const index = TERM_KIND_ORDER.indexOf(kind);
  return index === -1 ? TERM_KIND_ORDER.length : index;
}

interface Match {
  readonly candidate: TermCandidate;
  readonly match: 'exact' | 'partial';
}

function compareMatches(a: Match, b: Match): number {
  return (
    (a.match === b.match ? 0 : a.match === 'exact' ? -1 : 1) ||
    kindRank(a.candidate.symbol.kind) - kindRank(b.candidate.symbol.kind) ||
    compare(a.candidate.symbol.symbolId, b.candidate.symbol.symbolId)
  );
}

/**
 * Per term in the given order: the matching non-test symbols of its context (a repo-wide term: all), exact before
 * partial, then `TERM_KIND_ORDER`, then symbol ID; the first `TERM_IDENTIFIER_CAP` become links. `counts` is by term
 * node id.
 */
export function termIdentifierLinks(
  terms: readonly TermNode[],
  candidates: readonly TermCandidate[],
  split: SplitIdentifier,
  dataResourceKinds: readonly string[],
): { readonly links: DomainLink[]; readonly counts: ReadonlyMap<string, number> } {
  const dataKinds = new Set(dataResourceKinds);
  const unique = new Map<string, TermCandidate>();
  for (const candidate of candidates) {
    if (candidate.isTest || unique.has(candidate.symbol.symbolId)) continue;
    unique.set(candidate.symbol.symbolId, candidate);
  }
  const tokenized = [...unique.values()].map((candidate) => ({ candidate, tokens: identifierTokens(candidate.symbol.name, split) }));

  const links: DomainLink[] = [];
  const counts = new Map<string, number>();
  for (const term of terms) {
    const tokens = termTokens(term.term, split);
    const matches: Match[] = [];
    if (tokens.some((t) => t.length >= MIN_TOKEN_LENGTH)) {
      for (const { candidate, tokens: identifier } of tokenized) {
        if (term.context !== REPO_WIDE_CONTEXT && candidate.context !== term.context) continue;
        const match = tokensMatch(identifier, tokens);
        if (match) matches.push({ candidate, match });
      }
    }
    counts.set(term.id, matches.length);
    for (const { candidate, match } of matches.sort(compareMatches).slice(0, TERM_IDENTIFIER_CAP)) {
      links.push({
        kind: 'term-identifier',
        from: term.id,
        to: { file: candidate.file, symbolId: candidate.symbol.symbolId },
        source: dataKinds.has(candidate.symbol.kind) ? 'table-name' : 'symbol-name',
        match,
      });
    }
  }
  return { links, counts };
}
