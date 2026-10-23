import type { CtxoHost, FileChange, FileIndex, ResponseEnricher } from '@ctxo/cli/internal';
import { GitChangeReader } from '../adapters/git-changes.js';
import { rulesWithoutTests } from '../core/domain-graph-query.js';
import { ADDITIVE_CAP } from '../core/limits.js';
import { computeTouched } from '../core/touched.js';
import type { DomainState } from './domain-state.js';

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
export function prImpactDomainFields(host: CtxoHost, state: DomainState): ResponseEnricher {
  const log = host.services.createLogger('ctxo:domain');
  const skip = (payload: Payload, why: string): Payload => {
    log.warn(`The get_pr_impact domain fields are left out: ${why}`);
    return payload;
  };

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
    if ('error' in resolved) return skip(payload, `git cannot resolve "${since}" against HEAD`);
    const commits = await reader.committed([resolved.base]);
    if (commits === undefined) return skip(payload, `git cannot read the commits since "${since}"`);
    const workingTree = await reader.workingTree('all');
    if (workingTree === undefined) return skip(payload, 'git cannot read the working tree changes');

    let indices: FileIndex[] = [];
    try {
      indices = host.services.readIndex(host.ctxoRoot);
    } catch (err) {
      log.warn(`Cannot read the index for test file recognition: ${(err as Error).message}`);
    }
    const isTestFile = host.services.createTestFileCheck(host.services.loadConfig(host.ctxoRoot).config, indices);

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

    const changed = new Set<string>();
    for (const commit of commits) addChanged(commit.changes, changed);
    addChanged(workingTree, changed);
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
