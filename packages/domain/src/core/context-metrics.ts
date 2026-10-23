import type { CommitChangeSet } from '@ctxo/cli/internal';
import type { BoundaryResult } from './boundaries.js';
import type { Ownership } from './ownership.js';

/** One per-commit record of context metrics (`.ctxo/index/domain/history/`, E2). */
export interface ContextHistoryEntry {
  readonly ctxoArtifact: 'domain-history';
  readonly version: 1;
  readonly commitSha: string;
  /** HEAD's committer date in unix seconds. */
  readonly committedAt: number;
  readonly registryHash: string;
  readonly contexts: readonly {
    readonly id: string;
    readonly files: number;
    readonly internalEdges: number;
    readonly crossOut: number;
    readonly crossIn: number;
    readonly crossShare: number;
  }[];
}

/** A file a rename moved between contexts (or into or out of every context). */
export interface MovedFile {
  /** Path after the rename. */
  readonly file: string;
  /** Path before the rename. */
  readonly from: string;
  readonly fromContext?: string;
  readonly toContext?: string;
  readonly commit: string;
  /** Author date of the commit, ISO 8601. */
  readonly date: string;
}

export interface ContextDrift {
  readonly context: string;
  readonly crossShare: { readonly current: number; readonly previous?: number; readonly delta?: number };
  /** Oldest first, one point per history entry of the current registry. */
  readonly trend: readonly { readonly commitSha: string; readonly crossShare: number }[];
  readonly movedFiles: readonly MovedFile[];
  readonly distinctCommits: number;
  readonly confidence: 'low' | 'medium' | 'high';
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** `out / (internal + out)` rounded to 3 decimals; 0 for a context without edges (E11). */
export function crossShare(internal: number, out: number): number {
  const total = internal + out;
  return total === 0 ? 0 : round3(out / total);
}

/**
 * The history entry for HEAD. `files` is the non-test file count per context id. Contexts are listed in
 * codepoint order of their ids.
 */
export function historyEntry(
  head: { sha: string; committedAt: number },
  registryHash: string,
  files: ReadonlyMap<string, number>,
  boundaries: BoundaryResult,
): ContextHistoryEntry {
  const ids = [...new Set([...boundaries.perContext.keys(), ...files.keys()])].sort(compare);
  return {
    ctxoArtifact: 'domain-history',
    version: 1,
    commitSha: head.sha,
    committedAt: head.committedAt,
    registryHash,
    contexts: ids.map((id) => {
      const counts = boundaries.perContext.get(id) ?? { internal: 0, out: 0, in: 0 };
      return {
        id,
        files: files.get(id) ?? 0,
        internalEdges: counts.internal,
        crossOut: counts.out,
        crossIn: counts.in,
        crossShare: crossShare(counts.internal, counts.out),
      };
    }),
  };
}

function compareMoved(a: MovedFile, b: MovedFile): number {
  const ta = Date.parse(a.date);
  const tb = Date.parse(b.date);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  return compare(a.file, b.file) || compare(a.from, b.from) || compare(a.commit, b.commit);
}

/** Sorts moved files newest first by date, then by file (codepoint). */
export function sortMovedFiles(moved: readonly MovedFile[]): MovedFile[] {
  return [...moved].sort(compareMoved);
}

/** Re-judges one rename against `ownership`: undefined when its old and new owners are the same. */
export function judgeRename(
  rename: { readonly file: string; readonly from: string; readonly commit: string; readonly date: string },
  ownership: Ownership,
): MovedFile | undefined {
  const fromContext = ownership.ownerOf(rename.from);
  const toContext = ownership.ownerOf(rename.file);
  if (fromContext === toContext) return undefined;
  return {
    file: rename.file,
    from: rename.from,
    ...(fromContext !== undefined ? { fromContext } : {}),
    ...(toContext !== undefined ? { toContext } : {}),
    commit: rename.commit,
    date: rename.date,
  };
}

/** Renames (`R`) in the window whose old and new paths have different owners, newest first, then by file. */
export function movedFiles(windowCommits: readonly CommitChangeSet[], ownership: Ownership): MovedFile[] {
  const out: MovedFile[] = [];
  for (const commit of windowCommits) {
    for (const change of commit.changes) {
      if (change.status !== 'R' || change.oldPath === undefined) continue;
      const moved = judgeRename({ file: change.path, from: change.oldPath, commit: commit.hash, date: commit.date }, ownership);
      if (moved !== undefined) out.push(moved);
    }
  }
  return sortMovedFiles(out);
}

function confidenceOf(distinctCommits: number): ContextDrift['confidence'] {
  if (distinctCommits < 3) return 'low';
  if (distinctCommits < 7) return 'medium';
  return 'high';
}

/**
 * Drift of one context over the history entries of the current registry (E11): `current` from the newest
 * entry, `previous` from the newest entry of another commit. Undefined when no such entry lists the context.
 */
export function contextDrift(
  context: string,
  history: readonly ContextHistoryEntry[],
  moved: readonly MovedFile[],
  registryHash: string,
): ContextDrift | undefined {
  const points = history
    .filter((h) => h.registryHash === registryHash)
    .map((h) => ({ entry: h, metrics: h.contexts.find((c) => c.id === context) }))
    .filter((p): p is { entry: ContextHistoryEntry; metrics: ContextHistoryEntry['contexts'][number] } => p.metrics !== undefined)
    .sort((a, b) => a.entry.committedAt - b.entry.committedAt || compare(a.entry.commitSha, b.entry.commitSha));
  if (points.length === 0) return undefined;

  const newest = points[points.length - 1]!;
  const current = newest.metrics.crossShare;
  let previous: number | undefined;
  for (let i = points.length - 2; i >= 0; i--) {
    if (points[i]!.entry.commitSha !== newest.entry.commitSha) {
      previous = points[i]!.metrics.crossShare;
      break;
    }
  }
  const distinctCommits = new Set(points.map((p) => p.entry.commitSha)).size;
  return {
    context,
    crossShare: previous === undefined ? { current } : { current, previous, delta: round3(current - previous) },
    trend: points.map((p) => ({ commitSha: p.entry.commitSha, crossShare: p.metrics.crossShare })),
    movedFiles: moved.filter((m) => m.fromContext === context || m.toContext === context),
    distinctCommits,
    confidence: confidenceOf(distinctCommits),
  };
}
