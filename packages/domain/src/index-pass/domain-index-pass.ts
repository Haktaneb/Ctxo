import type { CtxoHost, IndexPassContext } from '@ctxo/cli/internal';
import { DomainArtifactStore, type BoundariesArtifact, type ContextsArtifact } from '../adapters/artifact-store.js';
import { readRegistry } from '../adapters/registry-reader.js';
import { computeBoundaries } from '../core/boundaries.js';
import { historyEntry, judgeRename, movedFiles, sortMovedFiles, type MovedFile } from '../core/context-metrics.js';
import { resolveDomainConfig } from '../core/domain-config.js';
import { createOwnership } from '../core/ownership.js';
import { registryHash } from '../core/registry.js';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Phase 2e of `ctxo index` for `@ctxo/domain` (spec 10.7): the file-to-context map, the cross-context edges and
 * boundary violations, and with the change log a per-commit history entry, written under `.ctxo/index/domain/`.
 *
 * - No registry: the artifacts are removed. Registry problems: a warning, and nothing is written or removed.
 * - Moved files come from the window's renames; without a change log they are kept from the existing
 *   `contexts.json`, re-judged against the current registry.
 */
export function domainIndexPass(host: CtxoHost): (ctx: IndexPassContext) => Promise<void> {
  const log = host.services.createLogger('ctxo:domain');
  return async (ctx) => {
    const started = performance.now();
    const store = new DomainArtifactStore(ctx.ctxoRoot);

    const { config, problems: configProblems } = resolveDomainConfig((ctx.config as Record<string, unknown>)['domain']);
    for (const problem of configProblems) log.warn(`${problem.path}: ${problem.message}`);

    const loaded = readRegistry(ctx.projectRoot, config.registry);
    if (loaded === undefined) {
      store.removeAll();
      return;
    }
    if (loaded.registry === undefined || loaded.problems.length > 0) {
      log.warn(
        `The domain registry at ${loaded.path} has ${loaded.problems.length} problem(s); domain artifacts not updated. Run "ctxo verify-domain".`,
      );
      return;
    }
    const registry = loaded.registry;
    const hash = registryHash(loaded.text);
    const ownership = createOwnership(registry, host.services.makeGlobMatcher);

    // File ownership over the merged index (E4: tests are listed as owned files; unowned and file counts skip them).
    const files = [...new Set(ctx.indices.map((i) => i.file.replace(/\\/g, '/')))].sort(compare);
    const owned = new Map<string, string[]>(registry.contexts.map((c) => [c.id, []]));
    const nonTestFiles = new Map<string, number>(registry.contexts.map((c) => [c.id, 0]));
    const unowned: string[] = [];
    const multiplyOwned: { file: string; contexts: string[] }[] = [];
    for (const file of files) {
      const owners = ownership.owners(file);
      if (owners.length === 1) {
        const id = owners[0]!;
        owned.get(id)!.push(file);
        if (!ctx.isTestFile(file)) nonTestFiles.set(id, nonTestFiles.get(id)! + 1);
      } else if (owners.length > 1) {
        multiplyOwned.push({ file, contexts: [...owners] });
      } else if (!ctx.isTestFile(file) && !ownership.isAllowedUnowned(file)) {
        unowned.push(file);
      }
    }

    const boundaries = computeBoundaries(ctx.graph().allEdges(), {
      registry,
      ownership,
      isTestFile: ctx.isTestFile,
      mode: config.boundaries.enforce,
      blockingRungs: config.boundaries.blockingRungs,
    });

    let moved: MovedFile[];
    if (ctx.history !== undefined) {
      moved = movedFiles(ctx.history.commits, ownership);
    } else {
      const kept: MovedFile[] = [];
      for (const m of store.readContexts()?.movedFiles ?? []) {
        const judged = judgeRename(m, ownership);
        if (judged !== undefined) kept.push(judged);
      }
      moved = sortMovedFiles(kept);
    }

    const contextsArtifact: ContextsArtifact = {
      ctxoArtifact: 'domain-contexts',
      version: 1,
      registryHash: hash,
      contexts: registry.contexts.map((c) => {
        const list = owned.get(c.id)!;
        return {
          id: c.id,
          name: c.name,
          rung: c.rung,
          ...(c.card !== undefined ? { card: c.card } : {}),
          fileCount: list.length,
          files: list,
        };
      }),
      unowned: { count: unowned.length, files: unowned },
      multiplyOwned,
      movedFiles: moved,
    };
    const boundariesArtifact: BoundariesArtifact = {
      ctxoArtifact: 'domain-boundaries',
      version: 1,
      registryHash: hash,
      mode: config.boundaries.enforce,
      blockingRungs: [...config.boundaries.blockingRungs],
      crossEdges: boundaries.crossEdges,
      violations: boundaries.violations,
    };

    store.writeIfChanged('contexts.json', contextsArtifact);
    store.writeIfChanged('boundaries.json', boundariesArtifact);
    if (ctx.history !== undefined) {
      store.writeHistory(
        historyEntry({ sha: ctx.history.head, committedAt: ctx.history.headCommittedAt }, hash, nonTestFiles, boundaries),
      );
    }

    const crossCount = boundaries.crossEdges.reduce((sum, c) => sum + c.allowed + c.violations, 0);
    const ms = Math.round(performance.now() - started);
    log.info(
      `Domain: ${registry.contexts.length} contexts, ${crossCount} cross-context edges, ${boundaries.violations.length} boundary violations (${ms} ms)`,
    );
  };
}
