import { compareCodepoint } from '../compare-codepoint.js';
import type { CoChangeEntry } from '../types.js';

/** A file that changes together with a symbol's file but has no dependency path to the symbol. */
export interface CoChangedFile {
  readonly file: string;
  readonly frequency: number;
  readonly sharedCommits: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_FREQUENCY = 0.5;

/**
 * The files that co-change with `rootFile` at `frequency >= minFrequency` (default 0.5) and are not in
 * `impactedFiles`, strongest first (frequency, then shared commits, both descending, then file name in
 * code point order), at most `limit` of them (default 10).
 *
 * `impactedFiles` holds the files that already have a graph path to the root: the root's own file and the
 * file of every impacted symbol in any confidence tier. What is left is the evidence the graph cannot
 * give, which is why it is a separate, informational list: it never feeds the tiers, the risk scores or
 * the gate.
 *
 * Pure: it neither changes its inputs nor reads anything else, so it is safe to call on the cached map the
 * `ICoChangePort` hands to every caller.
 */
export function findCoChangedFiles(
  coChangeMap: ReadonlyMap<string, readonly CoChangeEntry[]>,
  rootFile: string,
  impactedFiles: ReadonlySet<string>,
  options: { limit?: number; minFrequency?: number } = {},
): CoChangedFile[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const minFrequency = options.minFrequency ?? DEFAULT_MIN_FREQUENCY;

  // One row per partner file. A well-formed matrix lists a pair once, but a hand-edited one may not, and a
  // file must not be listed twice: keep the strongest entry.
  const strongestByFile = new Map<string, CoChangedFile>();
  for (const entry of coChangeMap.get(rootFile) ?? []) {
    const file = entry.file1 === rootFile ? entry.file2 : entry.file1;
    if (file === rootFile || impactedFiles.has(file) || entry.frequency < minFrequency) continue;

    const candidate: CoChangedFile = { file, frequency: entry.frequency, sharedCommits: entry.sharedCommits };
    const known = strongestByFile.get(file);
    if (!known || compareStrongestFirst(candidate, known) < 0) strongestByFile.set(file, candidate);
  }

  return [...strongestByFile.values()].sort(compareStrongestFirst).slice(0, Math.max(0, limit));
}

function compareStrongestFirst(a: CoChangedFile, b: CoChangedFile): number {
  return (
    b.frequency - a.frequency ||
    b.sharedCommits - a.sharedCommits ||
    compareCodepoint(a.file, b.file)
  );
}
