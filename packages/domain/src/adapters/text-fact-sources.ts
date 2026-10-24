import type { CodeFact, FileIndex, SymbolNode, TestFileCheck } from '@ctxo/cli/internal';
import type { Ownership } from '../core/ownership.js';
import type { FactOptions } from '../core/facts/fact-types.js';
import { scanTextFacts } from '../core/text-facts.js';
import { readRepoTexts, SOURCE_SCAN_MAX_BYTES } from './repo-files.js';

/** A file the text scan reads, with the symbols its facts attach to (`[]` for an unindexed file). */
export interface TextScanTarget {
  readonly file: string;
  readonly symbols: readonly SymbolNode[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const norm = (path: string): string => path.replace(/\\/g, '/');

function extensionOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * The text scan's files (H2), in codepoint order of path, each once: indexed, non-test files with exactly one owner
 * whose index has no `facts` key (their plugin has no fact detector), and tracked, unindexed, non-test files with
 * exactly one owner whose extension is listed (lower-cased) in `extensions`.
 */
export function textScanTargets(input: {
  readonly indices: readonly FileIndex[];
  readonly tracked: readonly string[];
  readonly ownership: Ownership;
  readonly isTestFile: TestFileCheck;
  readonly extensions: readonly string[];
}): TextScanTarget[] {
  const { indices, tracked, ownership, isTestFile } = input;
  const extensions = new Set(input.extensions.map((e) => e.toLowerCase()));
  const eligible = (file: string): boolean => !isTestFile(file) && ownership.ownerOf(file) !== undefined;

  const targets = new Map<string, TextScanTarget>();
  const indexed = new Set<string>();
  for (const index of indices) {
    const file = norm(index.file);
    indexed.add(file);
    if (index.facts !== undefined || targets.has(file) || !eligible(file)) continue;
    targets.set(file, { file, symbols: index.symbols });
  }
  for (const raw of tracked) {
    const file = norm(raw);
    if (indexed.has(file) || targets.has(file) || !extensions.has(extensionOf(file)) || !eligible(file)) continue;
    targets.set(file, { file, symbols: [] });
  }
  return [...targets.values()].sort((a, b) => compare(a.file, b.file));
}

/**
 * The text-scan facts of each target, read through `readRepoTexts` (files over 1 MiB, binary, missing or outside the
 * project are skipped). Files without facts are absent; the map is in codepoint order of path.
 */
export function readTextFacts(projectRoot: string, targets: readonly TextScanTarget[], options: FactOptions): Map<string, CodeFact[]> {
  const symbolsOf = new Map<string, readonly SymbolNode[]>();
  for (const target of targets) symbolsOf.set(norm(target.file), target.symbols);
  const out = new Map<string, CodeFact[]>();
  for (const { file, text } of readRepoTexts(projectRoot, [...symbolsOf.keys()], SOURCE_SCAN_MAX_BYTES)) {
    const facts = scanTextFacts(file, text, symbolsOf.get(file) ?? [], options);
    if (facts.length > 0) out.set(file, facts);
  }
  return out;
}
