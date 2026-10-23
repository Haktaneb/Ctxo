import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { CtxoHost, FileChange, FileIndex, ResponseEnricher } from '@ctxo/cli/internal';
import { GitChangeReader } from '../adapters/git-changes.js';
import { rulesWithoutTests } from '../core/domain-graph-query.js';
import { ADDITIVE_CAP } from '../core/limits.js';
import { computeTouched } from '../core/touched.js';
import { RACY_WINDOW_MS, type DomainState } from './domain-state.js';

/**
 * The domain fields on `get_pr_impact` (spec 11.3, F8, F15): `contextsTouched`, `cardsChanged` and
 * `rulesWithoutTests`, from the changes of spec 10.3 over the tool's `since`: the commits after the merge base of
 * `since` and HEAD, plus the working tree (P10; the core `files` list stays `git diff <since>`).
 */

type Payload = Record<string, unknown>;

/** The most files one `contextsTouched` entry lists; `fileCount` holds the full count. */
export const TOUCHED_FILES_CAP = 10;

/** The tool's default `since` (get-pr-impact.ts InputSchema). */
const DEFAULT_SINCE = 'HEAD~1';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const norm = (path: string): string => path.replace(/\\/g, '/');

/** Sets `name` to the first `ADDITIVE_CAP` entries and `<name>Total` to the full count only when entries were cut. */
function setCapped(payload: Payload, name: string, list: readonly unknown[]): void {
  payload[name] = list.slice(0, ADDITIVE_CAP);
  if (list.length > ADDITIVE_CAP) payload[`${name}Total`] = list.length;
}

export interface PrImpactFieldsOptions {
  /** The clock for the racy-stamp rule; `Date.now` by default. */
  readonly now?: () => number;
}

/**
 * A stat stamp of the index folder: the number of files under it and the newest mtime of any file or folder, from
 * one walk with no parsing. Undefined (never trusted) when the newest mtime is within `RACY_WINDOW_MS` of `taken`
 * or in the future, the rule `DomainState` applies, so a rewrite inside one coarse mtime tick is not missed.
 */
function indexStamp(dir: string, taken: number): string | undefined {
  let count = 0;
  let newest = 0;
  const walk = (path: string): void => {
    let entries: Dirent[];
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      count += 1;
      try {
        newest = Math.max(newest, statSync(child).mtimeMs);
      } catch {
        // Removed during the walk: the next stamp differs.
      }
    }
  };
  walk(dir);
  if (newest > taken - RACY_WINDOW_MS) return undefined;
  return `${count}:${newest}`;
}

/**
 * The part of the index the test-file check reads: each entry's file with only its annotated symbols. The host's
 * `createTestFileCheck` derives the annotated test files and its `annotationAware` flag from annotations alone, so
 * the check built from this projection equals the one built from the full index, at a fraction of the memory.
 */
function annotationEvidence(indices: readonly FileIndex[]): FileIndex[] {
  const out: FileIndex[] = [];
  for (const index of indices) {
    const symbols = index.symbols.filter((symbol) => symbol.annotations !== undefined && symbol.annotations.length > 0);
    if (symbols.length > 0) out.push({ file: index.file, lastModified: index.lastModified, symbols, edges: [], intent: [], antiPatterns: [] });
  }
  return out;
}

function addChanged(changes: readonly FileChange[], into: Set<string>): void {
  for (const change of changes) {
    into.add(norm(change.path));
    if (change.oldPath !== undefined) into.add(norm(change.oldPath));
  }
}

/**
 * The asynchronous `get_pr_impact` enricher. Unless `state.load()` is ok it returns the payload unchanged (E3).
 * `since` is `args.since` when it is a non-empty string, else `HEAD~1`. When git cannot give the merge base, the
 * range's commits or the working tree, the payload comes back unchanged with one warning; otherwise the three
 * fields appear, possibly empty, each capped at `ADDITIVE_CAP` with `<name>Total` when cut.
 */
export function prImpactDomainFields(host: CtxoHost, state: DomainState, options: PrImpactFieldsOptions = {}): ResponseEnricher {
  const now = options.now ?? Date.now;
  const log = host.services.createLogger('ctxo:domain');
  const skip = (payload: Payload, why: string): Payload => {
    log.warn(`The get_pr_impact domain fields are left out: ${why}`);
    return payload;
  };
  const indexDir = join(host.ctxoRoot, 'index');
  let cachedStamp: string | undefined;
  let cachedEvidence: readonly FileIndex[] = [];

  /**
   * The test-file evidence of the index, cached by `indexStamp`: `readIndex` (a synchronous parse of every entry,
   * which the time bound cannot interrupt) runs again only when an entry is added, removed or rewritten, or while
   * the newest mtime is inside the racy window.
   */
  function testEvidence(): readonly FileIndex[] {
    const stamp = indexStamp(indexDir, now());
    if (stamp !== undefined && stamp === cachedStamp) return cachedEvidence;
    let indices: FileIndex[] = [];
    try {
      indices = host.services.readIndex(host.ctxoRoot);
    } catch (err) {
      log.warn(`Cannot read the index for test file recognition: ${(err as Error).message}`);
    }
    cachedEvidence = annotationEvidence(indices);
    cachedStamp = stamp;
    return cachedEvidence;
  }

  return async (payload, args) => {
    const loaded = state.load();
    if (!loaded.ok) return payload;
    const { registry, ownership, index } = loaded.snapshot;
    const since = typeof args['since'] === 'string' && args['since'] !== '' ? args['since'] : DEFAULT_SINCE;

    let reader: GitChangeReader;
    try {
      reader = new GitChangeReader(host.services.createGit(host.projectRoot));
    } catch (err) {
      return skip(payload, `git is not available (${(err as Error).message})`);
    }
    const resolved = await reader.resolveBase(since);
    if ('error' in resolved) {
      return skip(
        payload,
        resolved.error === 'no-merge-base' ? `"${since}" has no merge base with HEAD` : `git cannot resolve "${since}" against HEAD`,
      );
    }
    const commits = await reader.committed([resolved.base]);
    if (commits === undefined) return skip(payload, `git cannot read the commits since "${since}"`);
    const workingTree = await reader.workingTree('all');
    if (workingTree === undefined) return skip(payload, 'git cannot read the working tree changes');

    const changed = new Set<string>();
    for (const commit of commits) addChanged(commit.changes, changed);
    addChanged(workingTree, changed);

    // Only paths other than the cards and the glossary need the index (for test files by annotation).
    const docs = new Set<string>([norm(registry.glossary)]);
    for (const context of registry.contexts) if (context.card !== undefined) docs.add(norm(context.card));
    const needsIndex = [...changed].some((path) => !docs.has(path));
    const evidence = needsIndex ? testEvidence() : [];
    const isTestFile = host.services.createTestFileCheck(host.services.loadConfig(host.ctxoRoot).config, evidence);

    const report = computeTouched({ registry, ownership, isTestFile, commits, workingTree, mode: 'all', since });

    const contextsTouched = report.contexts.map((context) => ({
      id: context.id,
      status: context.status,
      ...(context.card !== undefined ? { card: context.card } : {}),
      cardChanged: context.cardChanged,
      ...(context.acknowledged !== undefined ? { acknowledged: context.acknowledged } : {}),
      fileCount: context.files.length,
      files: context.files.slice(0, TOUCHED_FILES_CAP),
    }));

    const cards = new Set<string>();
    for (const context of registry.contexts) {
      if (context.card !== undefined && changed.has(norm(context.card))) cards.add(norm(context.card));
    }
    const cardsChanged = [...cards].sort(compare);

    const untested = rulesWithoutTests(
      index,
      report.contexts.map((context) => context.id),
    ).map((rule) => ({
      ruleId: rule.ruleId,
      title: rule.title,
      context: rule.context,
      card: rule.card,
      ...(rule.untested !== undefined ? { untested: rule.untested } : {}),
    }));

    setCapped(payload, 'contextsTouched', contextsTouched);
    setCapped(payload, 'cardsChanged', cardsChanged);
    setCapped(payload, 'rulesWithoutTests', untested);
    return payload;
  };
}
