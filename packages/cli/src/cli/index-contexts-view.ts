import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ArchitectureArtifactsWriter } from '../adapters/storage/architecture-artifacts-writer.js';
import { CoChangeReader } from '../adapters/storage/co-change-reader.js';
import type { CtxoConfig } from '../core/config/config-schema.js';
import {
  indexIgnorePatterns,
  indexTestPatterns,
  makeGlobMatcher,
  resolveContextsViewConfig,
} from '../core/config/load-config.js';
import { buildContextsView, type ContextsView } from '../core/contexts-view/contexts-view-builder.js';
import { createTestFileClassifier } from '../core/test-files/test-file-classifier.js';
import type { CommunitySnapshot, FileIndex } from '../core/types.js';

export interface ContextsViewStepOptions {
  readonly projectRoot: string;
  readonly ctxoRoot: string;
  readonly config: CtxoConfig;
  /** The merged full index. */
  readonly indices: readonly FileIndex[];
  /** This run's snapshot: god nodes and commitSha. */
  readonly snapshot: CommunitySnapshot;
  readonly symbolPageRank: ReadonlyMap<string, number>;
}

/** The file part of a symbol ID (`<file>::<name>::<kind>`). */
function fileOfSymbol(symbolId: string): string {
  const cut = symbolId.indexOf('::');
  return cut === -1 ? symbolId : symbolId.slice(0, cut);
}

/**
 * Builds the contexts view from the merged full index and writes `contexts-view.json` (only when its content
 * changed). A node is a file that is not a test file, not matched by `index.ignore` or `contextsView.exclude`,
 * and still present in the working tree: the committed JSON of a deleted or skip-worktree file must not
 * make it a node. Throws on failure; the caller reports it and carries on.
 */
export function computeAndWriteContextsView(options: ContextsViewStepOptions): ContextsView {
  const { projectRoot, ctxoRoot, config, indices, snapshot, symbolPageRank } = options;

  const settings = resolveContextsViewConfig(config);
  const isTest = createTestFileClassifier(indexTestPatterns(config));
  const isIgnored = makeGlobMatcher(indexIgnorePatterns(config));
  const isExcluded = makeGlobMatcher([...settings.exclude]);
  const isNode = (file: string): boolean =>
    !isTest(file) && !isIgnored(file) && !isExcluded(file) && existsSync(join(projectRoot, file));

  const godNodeFiles = new Set(snapshot.godNodes.map((god) => fileOfSymbol(god.symbolId)));
  const filePageRank = new Map<string, number>();
  for (const index of indices) {
    let sum = filePageRank.get(index.file) ?? 0;
    for (const symbol of index.symbols) sum += symbolPageRank.get(symbol.symbolId) ?? 0;
    filePageRank.set(index.file, sum);
  }

  const coChangeMap = new CoChangeReader(ctxoRoot).readCoChangeMap();
  const view = buildContextsView({
    indices,
    isNode,
    ...(coChangeMap ? { coChangeMap } : {}),
    godNodeFiles,
    filePageRank,
    settings,
    commitSha: snapshot.commitSha,
  });

  new ArchitectureArtifactsWriter(ctxoRoot, { allowProductionPath: true }).writeContextsView(view);

  const { coverage } = view;
  console.error(
    `[ctxo] Contexts view: ${view.candidates.length} candidates cover ${coverage.covered}/${coverage.files} files ` +
      `(${Math.round(coverage.ratio * 100)}%), ${view.hubs.length} hubs, ${view.unclustered.count} unclustered`,
  );
  return view;
}
