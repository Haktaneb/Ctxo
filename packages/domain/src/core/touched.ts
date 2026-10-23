import type { FileChange, RangeCommit } from '@ctxo/cli/internal';
import type { Ownership } from './ownership.js';
import type { DomainRegistry } from './registry.js';
import { parseDomainUnchanged } from './trailer.js';

export type TouchedStatus = 'card-changed' | 'acknowledged' | 'unresolved' | 'no-card';

export interface TouchedContext {
  readonly id: string;
  readonly files: readonly string[];
  readonly card?: string;
  readonly cardChanged: boolean;
  readonly acknowledged?: { readonly commit: string; readonly reason?: string };
  readonly status: TouchedStatus;
}

export interface TouchedReport {
  readonly mode: 'all' | 'committed' | 'staged';
  readonly since?: string;
  readonly base?: string;
  readonly head?: string;
  readonly contexts: readonly TouchedContext[];
  readonly unowned: readonly string[];
  readonly unresolved: readonly string[];
  readonly warnings: readonly string[];
}

export interface TouchedInput {
  readonly registry: DomainRegistry;
  readonly ownership: Ownership;
  readonly isTestFile: (path: string) => boolean;
  readonly indexedFiles?: ReadonlySet<string>;
  /** Newest first. */
  readonly commits: readonly RangeCommit[];
  readonly workingTree: readonly FileChange[];
  readonly mode: TouchedReport['mode'];
  readonly since?: string;
  readonly base?: string;
  readonly head?: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const norm = (path: string): string => path.replace(/\\/g, '/');

function collectPaths(changes: readonly FileChange[], into: Set<string>): void {
  for (const change of changes) {
    into.add(norm(change.path));
    if (change.oldPath !== undefined) into.add(norm(change.oldPath));
  }
}

/** Which named contexts the evaluated changes touched, and whether each is resolved (spec 10.3). */
export function computeTouched(input: TouchedInput): TouchedReport {
  const commits = input.mode === 'staged' ? [] : input.commits;
  const useWorkingTree = input.mode !== 'committed';

  const changed = new Set<string>();
  for (const commit of commits) collectPaths(commit.changes, changed);
  if (useWorkingTree) collectPaths(input.workingTree, changed);

  const nonTest = [...changed].filter((p) => !input.isTestFile(p));

  const filesByContext = new Map<string, Set<string>>();
  for (const path of nonTest) {
    for (const owner of input.ownership.owners(path)) {
      let set = filesByContext.get(owner);
      if (set === undefined) {
        set = new Set();
        filesByContext.set(owner, set);
      }
      set.add(path);
    }
  }

  // Newest commit first: the first commit naming an id is the newest one.
  const known = new Set(input.registry.contexts.map((c) => c.id));
  const acknowledgements = new Map<string, { commit: string; reason?: string }>();
  const warnings = new Set<string>();
  for (const commit of commits) {
    const sha7 = commit.hash.slice(0, 7);
    for (const value of commit.trailers) {
      const ack = parseDomainUnchanged(value);
      for (const id of ack.ids) {
        if (!known.has(id)) {
          warnings.add(`Domain-Unchanged in ${sha7} names unknown context "${id}"`);
          continue;
        }
        if (!acknowledgements.has(id)) {
          acknowledgements.set(id, ack.reason !== undefined ? { commit: sha7, reason: ack.reason } : { commit: sha7 });
        }
      }
    }
  }

  const contexts: TouchedContext[] = [];
  for (const context of input.registry.contexts) {
    const files = filesByContext.get(context.id);
    if (files === undefined) continue;
    const card = context.card !== undefined ? norm(context.card) : undefined;
    const cardChanged = card !== undefined && changed.has(card);
    const acknowledged = acknowledgements.get(context.id);
    let status: TouchedStatus;
    if (card === undefined) status = 'no-card';
    else if (cardChanged) status = 'card-changed';
    else if (acknowledged !== undefined) status = 'acknowledged';
    else status = 'unresolved';
    contexts.push({
      id: context.id,
      files: [...files].sort(cmp),
      ...(card !== undefined ? { card } : {}),
      cardChanged,
      ...(status === 'acknowledged' && acknowledged !== undefined ? { acknowledged } : {}),
      status,
    });
  }
  contexts.sort((a, b) => cmp(a.id, b.id));

  const indexed = input.indexedFiles;
  const unowned =
    indexed === undefined
      ? []
      : nonTest
          .filter((p) => indexed.has(p) && input.ownership.owners(p).length === 0 && !input.ownership.isAllowedUnowned(p))
          .sort(cmp);

  return {
    mode: input.mode,
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.base !== undefined ? { base: input.base } : {}),
    ...(input.head !== undefined ? { head: input.head } : {}),
    contexts,
    unowned,
    unresolved: contexts.filter((c) => c.status === 'unresolved').map((c) => c.id),
    warnings: [...warnings].sort(cmp),
  };
}
