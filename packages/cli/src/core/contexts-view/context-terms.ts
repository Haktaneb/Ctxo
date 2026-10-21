import { compareCodepoint } from '../compare-codepoint.js';
import { SymbolTokenizer } from '../search/symbol-tokenizer.js';
import type { SymbolNode } from '../types.js';

export interface ContextTerm {
  readonly term: string;
  readonly files: number;
}

export interface TermOccurrence {
  readonly candidate: number;
  readonly file: string;
  readonly symbolId: string;
  readonly members: readonly string[];
}

export interface TermCollision {
  readonly name: string;
  readonly minJaccard: number;
  readonly occurrences: readonly TermOccurrence[];
}

export interface TermSource {
  readonly id: number;
  readonly files: readonly string[];
}

const DEFAULT_TERM_LIMIT = 10;
const COLLISION_JACCARD_THRESHOLD = 0.5;

function isTypeSymbol(symbol: SymbolNode): boolean {
  return symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'type';
}

/** C# names are namespace-qualified, so the short name is the last `.` segment. */
function shortName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(dot + 1);
}

/** Names of the symbols one level below `typeName` in the same file (`<typeName>.<member>`). */
function memberNames(typeName: string, symbols: readonly SymbolNode[]): string[] {
  const prefix = `${typeName}.`;
  const members = new Set<string>();
  for (const symbol of symbols) {
    if (!symbol.name.startsWith(prefix)) continue;
    const rest = symbol.name.slice(prefix.length);
    if (rest.length > 0 && !rest.includes('.')) members.add(rest);
  }
  return [...members].sort(compareCodepoint);
}

/**
 * Top type-name terms of a candidate (spec 7.3, Designer call 8): type names and enum members tokenized
 * with SymbolTokenizer, minus stop words, technical words and tokens shorter than 2 characters or all
 * digits, ranked by number of files, ties by code point order.
 */
export function harvestTopTerms(
  files: readonly string[],
  symbolsByFile: ReadonlyMap<string, readonly SymbolNode[]>,
  technicalTerms: readonly string[],
  limit: number = DEFAULT_TERM_LIMIT,
): ContextTerm[] {
  const technical = new Set(technicalTerms.map((term) => term.toLowerCase()));
  const fileCounts = new Map<string, number>();

  for (const file of new Set(files)) {
    const symbols = symbolsByFile.get(file) ?? [];
    const names: string[] = [];
    for (const symbol of symbols) {
      if (!isTypeSymbol(symbol)) continue;
      names.push(shortName(symbol.name));
      for (const member of memberNames(symbol.name, symbols)) names.push(member);
    }

    const terms = new Set<string>();
    for (const name of names) {
      for (const raw of SymbolTokenizer.splitName(name)) {
        const token = raw.toLowerCase();
        if (token.length < 2 || /^\d+$/.test(token)) continue;
        if (SymbolTokenizer.isStopWord(token) || technical.has(token)) continue;
        terms.add(token);
      }
    }
    for (const term of terms) fileCounts.set(term, (fileCounts.get(term) ?? 0) + 1);
  }

  return [...fileCounts.entries()]
    .map(([term, count]) => ({ term, files: count }))
    .sort((a, b) => b.files - a.files || compareCodepoint(a.term, b.term))
    .slice(0, limit);
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const left = new Set(a);
  let intersection = 0;
  for (const item of new Set(b)) if (left.has(item)) intersection++;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

/**
 * Type names (case-insensitive) that appear in two or more candidates with member sets whose Jaccard
 * similarity is below 0.5 for at least one pair of occurrences in different candidates.
 */
export function findTermCollisions(
  candidates: readonly TermSource[],
  symbolsByFile: ReadonlyMap<string, readonly SymbolNode[]>,
): TermCollision[] {
  const byName = new Map<string, TermOccurrence[]>();

  for (const candidate of candidates) {
    for (const file of new Set(candidate.files)) {
      const symbols = symbolsByFile.get(file) ?? [];
      for (const symbol of symbols) {
        if (!isTypeSymbol(symbol)) continue;
        const key = shortName(symbol.name).toLowerCase();
        const occurrence: TermOccurrence = {
          candidate: candidate.id,
          file,
          symbolId: symbol.symbolId,
          members: memberNames(symbol.name, symbols),
        };
        const list = byName.get(key);
        if (list) list.push(occurrence);
        else byName.set(key, [occurrence]);
      }
    }
  }

  const collisions: TermCollision[] = [];
  for (const [name, occurrences] of byName) {
    let min = Infinity;
    for (let i = 0; i < occurrences.length; i++) {
      for (let j = i + 1; j < occurrences.length; j++) {
        const a = occurrences[i]!;
        const b = occurrences[j]!;
        if (a.candidate === b.candidate) continue;
        min = Math.min(min, jaccard(a.members, b.members));
      }
    }
    if (min === Infinity || min >= COLLISION_JACCARD_THRESHOLD) continue;
    collisions.push({
      name,
      minJaccard: Math.round(min * 1000) / 1000,
      occurrences: [...occurrences].sort(
        (a, b) => a.candidate - b.candidate || compareCodepoint(a.symbolId, b.symbolId),
      ),
    });
  }

  return collisions.sort((a, b) => compareCodepoint(a.name, b.name));
}
