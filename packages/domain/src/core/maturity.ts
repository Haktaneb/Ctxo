/**
 * Per-context maturity facts (H7 to H9, H13): characterization and contract tests, how far they reach the
 * context's main paths and contract symbols, and the co-change the context shares with other contexts.
 * The rung derivation reads these facts; this module only counts.
 */

import type { CoChangeEntry, CodeFact, FileIndex, TestFileCheck } from '@ctxo/cli/internal';
import type { GlobMatcherFactory, Ownership } from './ownership.js';
import { reachableFrom, reachedVia, type ReachGraph } from './reachability.js';
import type { DomainRegistry } from './registry.js';
import type { TestClassification } from './test-conventions.js';

/** H13: PR 0's `coChangedFiles` floor. */
export const CROSS_CONTEXT_COCHANGE_MIN = 0.5;
/** The most unreached symbol IDs one summary lists. */
export const UNREACHED_CAP = 20;
/** The most cross-context co-change pairs one context lists. */
export const COCHANGE_TOP = 10;

export interface CrossContextCoChange {
  /** The file of this context. */
  readonly file: string;
  readonly otherFile: string;
  readonly otherContext: string;
  readonly frequency: number;
  readonly sharedCommits: number;
}

export interface ReachSummary {
  readonly total: number;
  readonly reached: number;
  /** Codepoint order, at most UNREACHED_CAP. */
  readonly unreached: readonly string[];
}

export interface ContextMaturityFacts {
  readonly context: string;
  readonly tests: { readonly characterization: number; readonly contract: number };
  readonly mainPaths: ReachSummary;
  readonly contractSymbols: ReachSummary;
  readonly coChange: { readonly pairs: number; readonly top: readonly CrossContextCoChange[] };
}

/** `.ctxo/index/domain/maturity.json` (W9: declared in core, stored by the artifact store). */
export interface MaturityArtifact {
  readonly ctxoArtifact: 'domain-maturity';
  readonly version: 1;
  readonly registryHash: string;
  readonly cardsHash: string;
  readonly contexts: readonly ContextMaturityFacts[];
}

export interface MaturityInput {
  readonly registry: DomainRegistry;
  readonly ownership: Ownership;
  readonly isTestFile: TestFileCheck;
  readonly indices: readonly FileIndex[];
  /** Effective facts per file: the native facts, else the text facts. */
  readonly facts: ReadonlyMap<string, readonly CodeFact[]>;
  readonly reach: ReachGraph;
  readonly tests: TestClassification;
  readonly makeMatcher: GlobMatcherFactory;
  readonly coChange?: readonly CoChangeEntry[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const norm = (path: string): string => path.replace(/\\/g, '/');

function summarize(reach: ReachGraph, visited: ReadonlySet<string>, ids: readonly string[]): ReachSummary {
  const unreached = ids.filter((id) => reachedVia(reach, visited, id) === undefined);
  return { total: ids.length, reached: ids.length - unreached.length, unreached: unreached.slice(0, UNREACHED_CAP) };
}

function compareCoChange(a: CrossContextCoChange, b: CrossContextCoChange): number {
  return b.frequency - a.frequency || b.sharedCommits - a.sharedCommits || compare(a.file, b.file) || compare(a.otherFile, b.otherFile);
}

/** One entry per context, in registry order. */
export function buildMaturityFacts(input: MaturityInput): ContextMaturityFacts[] {
  const { registry, ownership, isTestFile, reach, tests } = input;
  const contextIds = registry.contexts.map((c) => c.id);

  // The non-test files a context owns alone, from the indices and the fact map.
  const ownedFiles = new Map<string, Set<string>>(contextIds.map((id) => [id, new Set<string>()]));
  const caseFile = new Map<string, string>();
  for (const file of [...input.indices.map((i) => i.file), ...input.facts.keys()]) {
    if (isTestFile(file)) continue;
    const owner = ownership.ownerOf(file);
    if (owner !== undefined) ownedFiles.get(owner)?.add(norm(file));
  }
  const testCases = new Set(tests.testCases);
  const hasChildren = new Set(reach.containerOf.values());
  const symbolsOf = new Map<string, string[]>();
  for (const index of input.indices) {
    const file = norm(index.file);
    const list = symbolsOf.get(file) ?? [];
    for (const symbol of index.symbols) {
      list.push(symbol.symbolId);
      if (testCases.has(symbol.symbolId)) caseFile.set(symbol.symbolId, file);
    }
    symbolsOf.set(file, list);
  }
  const factsOf = new Map<string, CodeFact[]>();
  for (const [file, list] of input.facts) {
    const key = norm(file);
    factsOf.set(key, [...(factsOf.get(key) ?? []), ...list]);
  }

  const contractSymbolsOf = new Map<string, string[]>();
  const mainPathsOf = new Map<string, string[]>();
  for (const id of contextIds) {
    const files = [...ownedFiles.get(id)!].sort(compare);
    const contract = new Set<string>();
    const main = new Set<string>();
    for (const file of files) {
      if (contextIds.some((other) => other !== id && ownership.isContract(other, file))) {
        for (const symbolId of symbolsOf.get(file) ?? []) if (!hasChildren.has(symbolId)) contract.add(symbolId);
      }
      for (const fact of factsOf.get(file) ?? []) if (fact.kind === 'endpoint') main.add(fact.symbolId);
    }
    for (const symbolId of contract) main.add(symbolId);
    contractSymbolsOf.set(id, [...contract].sort(compare));
    mainPathsOf.set(id, [...main].sort(compare));
  }

  const characterizationVisited = reachableFrom(reach, tests.characterization);
  const contractVisited = reachableFrom(reach, tests.contract);

  // W17: a test counts for the context owning its file alone; a test in an unowned or multiply owned file counts
  // for every context with a main path it reaches.
  const perTest = new Map<string, ReadonlySet<string>>();
  const visitedBy = (test: string): ReadonlySet<string> => {
    let visited = perTest.get(test);
    if (visited === undefined) {
      visited = reachableFrom(reach, [test]);
      perTest.set(test, visited);
    }
    return visited;
  };
  const countFor = (context: string, kind: ReadonlySet<string>): number => {
    let count = 0;
    for (const test of kind) {
      const file = caseFile.get(test);
      const owner = file === undefined ? undefined : ownership.ownerOf(file);
      if (owner !== undefined) {
        if (owner === context) count++;
        continue;
      }
      const visited = visitedBy(test);
      if (mainPathsOf.get(context)!.some((id) => reachedVia(reach, visited, id) !== undefined)) count++;
    }
    return count;
  };

  const coChangeOf = new Map<string, Map<string, CrossContextCoChange>>(contextIds.map((id) => [id, new Map()]));
  for (const entry of input.coChange ?? []) {
    if (!(entry.frequency >= CROSS_CONTEXT_COCHANGE_MIN)) continue;
    const a = norm(entry.file1);
    const b = norm(entry.file2);
    if (isTestFile(a) || isTestFile(b)) continue;
    const ownerA = ownership.ownerOf(a);
    const ownerB = ownership.ownerOf(b);
    if (ownerA === undefined || ownerB === undefined || ownerA === ownerB) continue;
    const add = (context: string, file: string, otherFile: string, otherContext: string): void => {
      const pairs = coChangeOf.get(context);
      const key = `${file}\n${otherFile}`;
      if (pairs === undefined) return;
      const next: CrossContextCoChange = { file, otherFile, otherContext, frequency: entry.frequency, sharedCommits: entry.sharedCommits };
      const known = pairs.get(key);
      if (known === undefined || compareCoChange(next, known) < 0) pairs.set(key, next);
    };
    add(ownerA, a, b, ownerB);
    add(ownerB, b, a, ownerA);
  }

  return contextIds.map((id) => {
    const pairs = [...coChangeOf.get(id)!.values()].sort(compareCoChange);
    return {
      context: id,
      tests: { characterization: countFor(id, tests.characterization), contract: countFor(id, tests.contract) },
      mainPaths: summarize(reach, characterizationVisited, mainPathsOf.get(id)!),
      contractSymbols: summarize(reach, contractVisited, contractSymbolsOf.get(id)!),
      coChange: { pairs: pairs.length, top: pairs.slice(0, COCHANGE_TOP) },
    };
  });
}
