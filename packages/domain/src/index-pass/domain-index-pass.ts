import type { CtxoHost, IndexPassContext } from '@ctxo/cli/internal';
import { DomainArtifactStore, type BoundariesArtifact, type ContextsArtifact } from '../adapters/artifact-store.js';
import { readRegistry } from '../adapters/registry-reader.js';
import { readCardText, readRepoTexts, repoFileExists, repoIsFile } from '../adapters/repo-files.js';
import { readTestFiles } from '../adapters/test-file-source.js';
import { computeBoundaries } from '../core/boundaries.js';
import { parseCard, parseGlossary, type ParsedCard } from '../core/card-parser.js';
import { historyEntry, judgeRename, movedFiles, sortMovedFiles, type MovedFile } from '../core/context-metrics.js';
import { resolveDomainConfig, type DomainConfig } from '../core/domain-config.js';
import { buildDomainGraph, cardsHash, type CardInput, type DomainGraph } from '../core/domain-graph.js';
import { createOwnership, type Ownership } from '../core/ownership.js';
import { registryHash, type DomainRegistry } from '../core/registry.js';
import { buildScanOptions, resolveRuleRefs, scanRuleComments, scanTestFiles } from '../core/rule-id-scan.js';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Phase 2e of `ctxo index` for `@ctxo/domain` (spec 10.7): the file-to-context map, the cross-context edges and
 * boundary violations, the domain graph (`graph.json`, spec 11.2), and with the change log a per-commit history
 * entry, written under `.ctxo/index/domain/`. Each artifact is rewritten only when its content changed.
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

    // A graph that cannot be built skips only graph.json: the ownership and boundary artifacts are still written.
    let graph: DomainGraph | undefined;
    try {
      graph = await composeGraph(host, ctx, { registry, registryHash: hash, config, ownership, files, warn: (m) => log.warn(m) });
    } catch (err) {
      log.warn(
        `The domain graph could not be built: ${(err as Error).message}; graph.json not updated. ` +
          'Until the graph builds again, the domain tools may serve the previous graph (or report a stale registry if it changed).',
      );
    }

    store.writeIfChanged('contexts.json', contextsArtifact);
    store.writeIfChanged('boundaries.json', boundariesArtifact);
    if (graph !== undefined) store.writeIfChanged('graph.json', graph);
    if (ctx.history !== undefined) {
      store.writeHistory(
        historyEntry({ sha: ctx.history.head, committedAt: ctx.history.headCommittedAt }, hash, nonTestFiles, boundaries),
      );
    }

    const crossCount = boundaries.crossEdges.reduce((sum, c) => sum + c.allowed + c.violations, 0);
    let graphPart = '';
    if (graph !== undefined) {
      const tested = new Set(graph.links.flatMap((l) => (l.kind === 'rule-test' ? [l.from] : [])));
      const withoutTests = graph.rules.filter((rule) => !tested.has(rule.id)).length;
      graphPart = `${graph.rules.length} rules (${withoutTests} without tests), ${graph.links.length} links, `;
    }
    const ms = Math.round(performance.now() - started);
    log.info(
      `Domain: ${registry.contexts.length} contexts, ${graphPart}` +
        `${crossCount} cross-context edges, ${boundaries.violations.length} boundary violations (${ms} ms)`,
    );
  };
}

/**
 * The domain graph of a valid registry (spec 11.2): the registry's cards and the glossary, the rule references of
 * the test files and of the production `rule:` comments, composed by `buildDomainGraph`. Reads go through the
 * path-safe repo readers; external provenance is stored, never fetched.
 */
async function composeGraph(
  host: CtxoHost,
  ctx: IndexPassContext,
  input: {
    readonly registry: DomainRegistry;
    readonly registryHash: string;
    readonly config: DomainConfig;
    readonly ownership: Ownership;
    /** The indexed files, forward slashes, codepoint order. */
    readonly files: readonly string[];
    readonly warn: (message: string) => void;
  },
): Promise<DomainGraph> {
  const { projectRoot } = ctx;
  const { registry, config } = input;

  // Cards: each path read and parsed once, even when two contexts share it.
  const texts = new Map<string, string | undefined>();
  const parsed = new Map<string, ParsedCard | undefined>();
  const cards: CardInput[] = [];
  // I2: read like provenance files (real path inside the repo, no-follow open, 1 MiB cap); a skip is a missing card.
  const readText = (path: string): string | undefined => {
    if (!texts.has(path)) texts.set(path, readCardText(projectRoot, path, input.warn));
    return texts.get(path);
  };
  for (const context of registry.contexts) {
    if (context.card === undefined) continue;
    if (!parsed.has(context.card)) {
      const text = readText(context.card);
      parsed.set(context.card, text === undefined ? undefined : parseCard(text));
    }
    const card = parsed.get(context.card);
    cards.push(card === undefined ? { context, path: context.card } : { context, path: context.card, card });
  }
  const glossaryText = readText(registry.glossary);
  const glossary = glossaryText === undefined ? undefined : { path: registry.glossary, items: parseGlossary(glossaryText) };
  const hashOfCards = cardsHash([...texts].map(([path, text]) => (text === undefined ? { path } : { path, text })));

  const ruleIds = cards.flatMap((c) => (c.card?.rules ?? []).map((rule) => rule.id));
  const scanOptions = buildScanOptions(config, ruleIds, registry);

  // Test refs (P15: the shared scan), from the tracked files, else the indexed ones.
  let tracked: readonly string[] | undefined;
  try {
    tracked = await host.services.createGit(projectRoot).listTrackedFiles?.();
  } catch {
    tracked = undefined;
  }
  const testTexts = readTestFiles(projectRoot, tracked ?? input.files, ctx.isTestFile, ctx.indices);
  const testRefs = resolveRuleRefs(scanTestFiles(testTexts, ctx.indices, ctx.isTestFile, scanOptions), scanOptions);

  // Code refs: the `rule:` comments of the indexed production files.
  const byFile = new Map(ctx.indices.map((index) => [index.file.replace(/\\/g, '/'), index]));
  const production = input.files.filter((file) => !ctx.isTestFile(file));
  const commentRefs = readRepoTexts(projectRoot, production).flatMap(({ file, text }) =>
    scanRuleComments(file, text, byFile.get(file), scanOptions),
  );
  const codeRefs = resolveRuleRefs(commentRefs, scanOptions);

  return buildDomainGraph({
    registry,
    registryHash: input.registryHash,
    config,
    cards,
    ...(glossary === undefined ? {} : { glossary }),
    cardsHash: hashOfCards,
    indices: ctx.indices,
    isTestFile: ctx.isTestFile,
    ownership: input.ownership,
    testRefs,
    codeRefs,
    fileExists: (path) => repoIsFile(projectRoot, path),
    // Exists but is no regular file: a directory, never provenance.
    isDirectory: (path) => repoFileExists(projectRoot, path) && !repoIsFile(projectRoot, path),
    split: (name) => host.services.splitIdentifier(name),
    dataResourceKinds: host.services.dataResourceKinds,
    warn: input.warn,
  });
}
