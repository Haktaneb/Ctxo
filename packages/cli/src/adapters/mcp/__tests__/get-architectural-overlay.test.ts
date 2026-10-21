import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStorageAdapter } from '../../storage/sqlite-storage-adapter.js';
import { MaskingPipeline } from '../../../core/masking/masking-pipeline.js';
import { handleGetArchitecturalOverlay, buildCommunityOverlay } from '../get-architectural-overlay.js';
import type { CommunitySnapshot, FileIndex } from '../../../core/types.js';
import { ClusterLabelMasker } from '../../../core/overlay/cluster-label-masker.js';
import { resolveContextsViewConfig } from '../../../core/config/load-config.js';
import type { ContextCandidate, ContextHub, ContextsView } from '../../../core/contexts-view/contexts-view-builder.js';
import type { TermCollision } from '../../../core/contexts-view/context-terms.js';
import type { IContextsViewPort } from '../../../ports/i-contexts-view-port.js';

function buildSnapshot(): CommunitySnapshot {
  return {
    version: 1,
    computedAt: '2026-04-16T10:00:00.000Z',
    commitSha: 'abc1234',
    modularity: 0.4,
    communities: [
      { symbolId: 'src/core/types.ts::T::type', communityId: 0, communityLabel: 'core' },
      { symbolId: 'src/ports/i-storage.ts::I::interface', communityId: 0, communityLabel: 'core' },
      { symbolId: 'src/adapters/mcp/handler.ts::H::class', communityId: 1, communityLabel: 'adapters' },
    ],
    godNodes: [
      { symbolId: 'src/core/types.ts::T::type', bridgedCommunities: [0, 1], centralityScore: 1 },
    ],
    edgeQuality: 'full',
    crossClusterEdges: 2,
  };
}

function buildHexagonalIndices(): FileIndex[] {
  return [
    { file: 'src/core/types.ts', lastModified: 1, symbols: [], edges: [], intent: [], antiPatterns: [] },
    { file: 'src/adapters/mcp/handler.ts', lastModified: 1, symbols: [], edges: [], intent: [], antiPatterns: [] },
    { file: 'src/ports/i-storage.ts', lastModified: 1, symbols: [], edges: [], intent: [], antiPatterns: [] },
    { file: 'src/cli/index-cmd.ts', lastModified: 1, symbols: [], edges: [], intent: [], antiPatterns: [] },
    { file: 'src/utils/format.ts', lastModified: 1, symbols: [], edges: [], intent: [], antiPatterns: [] },
  ];
}

describe('GetArchitecturalOverlayHandler', () => {
  let tempDir: string;
  let storage: SqliteStorageAdapter;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ctxo-overlay-'));
    storage = new SqliteStorageAdapter(tempDir);
    await storage.initEmpty();
    storage.bulkWrite(buildHexagonalIndices());
  });

  afterEach(() => {
    storage.close();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns MCP response with layer map', async () => {
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline());
    const result = await handler({});
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.layers).toBeDefined();
    expect(payload.layers['Domain']).toContain('src/core/types.ts');
    expect(payload.layers['Domain']).toContain('src/ports/i-storage.ts');
    expect(payload.layers['Adapter']).toContain('src/adapters/mcp/handler.ts');
    expect(payload.layers['Adapter']).toContain('src/cli/index-cmd.ts');
    expect(payload.layers['Unknown']).toContain('src/utils/format.ts');
  });

  it('filters by specific layer when parameter provided', async () => {
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline());
    const result = await handler({ layer: 'Domain' });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.layer).toBe('Domain');
    expect(payload.files).toContain('src/core/types.ts');
    expect(payload.files).not.toContain('src/utils/format.ts');
  });

  it('returns empty files array for non-existent layer', async () => {
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline());
    const result = await handler({ layer: 'NonExistent' });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.files).toEqual([]);
  });

  it('returns all layers when no filter specified', async () => {
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline());
    const result = await handler({});
    const payload = JSON.parse(result.content[0]!.text);

    expect(Object.keys(payload.layers)).toContain('Domain');
    expect(Object.keys(payload.layers)).toContain('Adapter');
    expect(Object.keys(payload.layers)).toContain('Unknown');
  });

  it('handles empty index gracefully', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'ctxo-empty-'));
    const emptyStorage = new SqliteStorageAdapter(emptyDir);
    await emptyStorage.initEmpty();

    const handler = handleGetArchitecturalOverlay(emptyStorage, new MaskingPipeline());
    const result = await handler({});
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.layers).toEqual({});

    emptyStorage.close();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('includes community overlay in both mode when a snapshot is available', async () => {
    storage.writeCommunities(buildSnapshot());
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline());
    const result = await handler({});
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload.layers).toBeDefined();
    expect(payload.communities).toBeDefined();
    expect(payload.communities.modularity).toBe(0.4);
    expect(payload.communities.commitSha).toBe('abc1234');
    expect(payload.communities.clusters).toHaveLength(2);
  });

  it('drops the layers map when mode=communities', async () => {
    storage.writeCommunities(buildSnapshot());
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline());
    const result = await handler({ mode: 'communities' });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.layers).toBeUndefined();
    expect(payload.communities).toBeDefined();
  });

  it('drops the communities map when mode=regex', async () => {
    storage.writeCommunities(buildSnapshot());
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline());
    const result = await handler({ mode: 'regex' });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.layers).toBeDefined();
    expect(payload.communities).toBeUndefined();
  });

  it('returns a hint when mode=communities but no snapshot exists', async () => {
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline());
    const result = await handler({ mode: 'communities' });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.hint).toMatch(/ctxo index/);
  });

  it('buildCommunityOverlay sorts clusters by member count descending', () => {
    const overlay = buildCommunityOverlay(buildSnapshot());
    expect(overlay.clusters[0]!.id).toBe(0);
    expect(overlay.clusters[0]!.memberCount).toBe(2);
    expect(overlay.clusters[0]!.godNodes).toContain('src/core/types.ts::T::type');
  });

  it('wraps all responses with a _meta envelope', async () => {
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline());
    const full = JSON.parse((await handler({})).content[0]!.text);
    expect(full._meta).toBeDefined();
    expect(full._meta).toMatchObject({ truncated: expect.any(Boolean), totalBytes: expect.any(Number) });

    const filtered = JSON.parse((await handler({ layer: 'Domain' })).content[0]!.text);
    expect(filtered._meta).toBeDefined();
  });

  it('surfaces snapshotStaleness in _meta when git reports HEAD ahead of snapshot', async () => {
    storage.writeCommunities(buildSnapshot()); // commitSha: 'abc1234'
    const git = {
      getHeadSha: () => Promise.resolve('def5678'),
      countCommitsBetween: () => Promise.resolve(3),
    } as unknown as Parameters<typeof handleGetArchitecturalOverlay>[3];

    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline(), undefined, git);
    const payload = JSON.parse((await handler({})).content[0]!.text);
    expect(payload._meta.snapshotStaleness).toMatchObject({
      snapshotCommit: 'abc1234',
      currentHeadCommit: 'def5678',
      commitsBehind: 3,
    });
    expect(payload._meta.snapshotStaleness.hint).toMatch(/behind HEAD/);
  });

  it('omits snapshotStaleness when git port is not provided', async () => {
    storage.writeCommunities(buildSnapshot());
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline());
    const payload = JSON.parse((await handler({})).content[0]!.text);
    expect(payload._meta.snapshotStaleness).toBeUndefined();
  });

  it('masks sensitive cluster labels when a ClusterLabelMasker is wired', async () => {
    storage.writeCommunities({
      version: 1,
      computedAt: '2026-04-16T10:00:00.000Z',
      commitSha: 'abc1234',
      modularity: 0.5,
      communities: [
        { symbolId: 'src/core/types.ts::T::type', communityId: 0, communityLabel: 'internal-vault' },
        { symbolId: 'src/ports/i-storage.ts::I::interface', communityId: 1, communityLabel: 'src/core' },
      ],
      godNodes: [],
      edgeQuality: 'full',
      crossClusterEdges: 0,
    });
    const { ClusterLabelMasker } = await import('../../../core/overlay/cluster-label-masker.js');
    const masker = new ClusterLabelMasker(['internal-*']);
    const handler = handleGetArchitecturalOverlay(
      storage,
      new MaskingPipeline(),
      undefined,
      undefined,
      masker,
    );
    const payload = JSON.parse((await handler({})).content[0]!.text);
    const labels = payload.communities.clusters.map(
      (c: { label: string }) => c.label,
    ) as string[];
    expect(labels.some((l) => /^\[masked-cluster-\d+\]$/.test(l))).toBe(true);
    expect(labels).toContain('src/core');
    expect(labels).not.toContain('internal-vault');
  });
});

/** Freezes a view and everything in it, as `ContextsViewReader` hands it out: an in-place edit throws. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const MODULES = [
  'Billing',
  'Shipping',
  'Loans',
  'Members',
  'Catalog',
  'Orders',
  'Payments',
  'Reports',
  'Identity',
  'Notifications',
  'Inventory',
  'Pricing',
];

const SUMMARY_HINT = 'Pass candidate: <id> for one candidate in full; run ctxo contexts --json for the whole view.';

function candidate(id: number, label: string, fileCount: number): ContextCandidate {
  const files = Array.from({ length: fileCount }, (_, i) => `src/c${id}/file-${String(i).padStart(3, '0')}.ts`);
  const other = (id % 12) + 1;
  return {
    id,
    label,
    fingerprint: createHash('sha256').update(String(id)).digest('hex').slice(0, 16),
    fileCount,
    files,
    cohesion: 0.5,
    topTerms: Array.from({ length: 10 }, (_, i) => ({ term: `term${id}t${i}`, files: 10 - i })),
    crossEdges: [{ candidate: other, total: 7, byKind: { calls: 4, imports: 3 } }],
    coChangePairs: Array.from({ length: Math.min(10, fileCount) }, (_, i) => ({
      file: files[i]!,
      otherFile: `src/c${other}/file-${String(i).padStart(3, '0')}.ts`,
      otherCandidate: other,
      frequency: 0.5,
      sharedCommits: 3,
    })),
  };
}

/** `count` occurrences of `name` in candidates `first`, `first + 1`, ... (wrapping after 12), each with `members` members. */
function collision(name: string, count: number, members: number, first = 1): TermCollision {
  return {
    name,
    minJaccard: 0.1,
    occurrences: Array.from({ length: count }, (_, i) => {
      const file = `src/Modules/M${String(i).padStart(3, '0')}/Domain/${name}.cs`;
      return {
        candidate: ((first - 1 + i) % 12) + 1,
        file,
        symbolId: `${file}::${name}::class`,
        members: Array.from({ length: members }, (_, m) => `Member${String(m).padStart(2, '0')}`),
      };
    }),
  };
}

function buildView(candidates: ContextCandidate[], extra: Partial<ContextsView> = {}): ContextsView {
  return {
    version: 1,
    commitSha: 'abc1234',
    settings: resolveContextsViewConfig({} as never),
    coverage: { files: 100, covered: 90, ratio: 0.9 },
    candidates,
    hubs: [],
    unclustered: { count: 20, files: Array.from({ length: 20 }, (_, i) => `src/u/f-${i}.ts`) },
    collisions: [],
    ...extra,
  };
}

/**
 * Shaped like the fixture: 12 candidates of 40 files, 17 hubs (the last one unassigned) and 5 collisions, one of
 * them with 120 occurrences of 20 members. Candidate 2 takes part in `entity0` and `entity4` only.
 */
function fixtureView(): ContextsView {
  const hubs: ContextHub[] = Array.from({ length: 17 }, (_, i) => ({
    file: `src/Shared/Infrastructure/Persistence/Hub${String(i).padStart(2, '0')}DbContext.cs`,
    reasons: ['fan-in', 'god-node'],
    dependents: 40 + i,
    damping: 0.18,
    ...(i < 16 ? { candidate: (i % 12) + 1 } : {}),
  }));
  return buildView(
    MODULES.map((name, i) => candidate(i + 1, `src/Modules/${name}`, 40)),
    {
      hubs,
      collisions: [
        collision('entity0', 120, 20),
        collision('entity1', 4, 3, 4),
        collision('entity2', 4, 3, 7),
        collision('entity3', 4, 3, 10),
        collision('entity4', 4, 3, 1),
      ],
    },
  );
}

describe('GetArchitecturalOverlayHandler mode contexts', () => {
  let tempDir: string;
  let storage: SqliteStorageAdapter;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ctxo-overlay-ctx-'));
    storage = new SqliteStorageAdapter(tempDir);
    await storage.initEmpty();
    storage.bulkWrite(buildHexagonalIndices());
  });

  afterEach(() => {
    delete process.env['CTXO_RESPONSE_LIMIT'];
    storage.close();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The view as production serves it: deep-frozen and shared by every call. */
  function port(view: ContextsView | undefined): IContextsViewPort {
    const frozen = view === undefined ? undefined : deepFreeze(view);
    return { readContextsView: () => frozen };
  }

  async function call(
    view: ContextsView | undefined,
    args: Record<string, unknown>,
    masker?: ClusterLabelMasker,
  ): Promise<Record<string, any>> {
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline(), undefined, undefined, masker, port(view));
    return JSON.parse((await handler(args)).content[0]!.text);
  }

  it('the summary of a fixture-shaped view returns all 12 candidates at the default limit', async () => {
    const view = fixtureView();
    const payload = await call(view, { mode: 'contexts' });

    expect(payload._meta.truncated).toBe(false);
    expect(payload._meta.totalBytes).toBeLessThanOrEqual(8192);
    expect(Object.keys(payload).sort()).toEqual([
      '_meta',
      'candidates',
      'collisions',
      'collisionsTotal',
      'commitSha',
      'coverage',
      'hint',
      'hubs',
      'hubsTotal',
      'unclustered',
    ]);
    expect(payload.commitSha).toBe('abc1234');
    expect(payload.coverage).toEqual({ files: 100, covered: 90, ratio: 0.9 });
    expect(payload.candidates).toHaveLength(12);
    const first = view.candidates[0]!;
    expect(payload.candidates[0]).toEqual({
      id: 1,
      label: 'src/Modules/Billing',
      fingerprint: first.fingerprint,
      fileCount: 40,
      cohesion: 0.5,
      topTerms: first.topTerms.slice(0, 5),
    });
    expect(payload.hubs).toHaveLength(17);
    expect(payload.hubsTotal).toBe(17);
    expect(payload.hubs[0]).toEqual({ file: view.hubs[0]!.file, reasons: ['fan-in', 'god-node'], candidate: 1 });
    expect(payload.hubs[16]).toEqual({ file: view.hubs[16]!.file, reasons: ['fan-in', 'god-node'] });
    expect(payload.collisions).toEqual([
      { name: 'entity0', minJaccard: 0.1, candidates: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], occurrenceCount: 120 },
      { name: 'entity1', minJaccard: 0.1, candidates: [4, 5, 6, 7], occurrenceCount: 4 },
      { name: 'entity2', minJaccard: 0.1, candidates: [7, 8, 9, 10], occurrenceCount: 4 },
      { name: 'entity3', minJaccard: 0.1, candidates: [1, 10, 11, 12], occurrenceCount: 4 },
      { name: 'entity4', minJaccard: 0.1, candidates: [1, 2, 3, 4], occurrenceCount: 4 },
    ]);
    expect(payload.collisionsTotal).toBe(5);
    expect(payload.unclustered).toEqual({ count: 20 });
    expect(payload.hint).toBe(SUMMARY_HINT);
  });

  it('the summary caps hubs and collisions at 50 with totals', async () => {
    const hubs: ContextHub[] = Array.from({ length: 60 }, (_, i) => ({
      file: `src/h${i}.ts`,
      reasons: ['configured'],
      dependents: 3,
      damping: 0,
    }));
    const collisions = Array.from({ length: 55 }, (_, i) => collision(`name${String(i).padStart(2, '0')}`, 2, 1));
    const view = buildView([candidate(1, 'orders', 3)], { hubs, collisions });
    const payload = await call(view, { mode: 'contexts' });

    expect(payload.hubs).toHaveLength(50);
    expect(payload.hubsTotal).toBe(60);
    expect(payload.collisions).toHaveLength(50);
    expect(payload.collisionsTotal).toBe(55);
    expect(view.hubs).toHaveLength(60);
  });

  it('the summary truncates candidates through the envelope and points at candidate and the CLI', async () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '2048';
    const view = buildView(Array.from({ length: 40 }, (_, i) => candidate(i + 1, `context-${i}`, 15)));
    const payload = await call(view, { mode: 'contexts' });

    expect(payload._meta.truncated).toBe(true);
    expect(payload._meta.hint).toContain('candidate');
    expect(payload._meta.hint).toContain('ctxo contexts --json');
    expect(payload.candidates.length).toBeLessThan(40);
  });

  it('candidate returns that candidate in full with its hubs and the collisions it takes part in', async () => {
    const view = fixtureView();
    const payload = await call(view, { mode: 'contexts', candidate: 2 });
    const second = view.candidates[1]!;

    expect(Object.keys(payload).sort()).toEqual(['_meta', 'candidate', 'collisions', 'commitSha', 'hubs']);
    expect(payload.commitSha).toBe('abc1234');
    expect(payload.candidate).toEqual({ ...second, files: second.files.slice(0, 15) });
    expect(payload.candidate.fileCount).toBe(40);
    expect(payload.candidate.topTerms).toHaveLength(10);
    expect(payload.candidate.crossEdges).toEqual(second.crossEdges);
    expect(payload.candidate.coChangePairs).toHaveLength(10);
    expect(payload.hubs).toEqual(
      [view.hubs[1]!, view.hubs[13]!].map(({ file, reasons, dependents, damping }) => ({ file, reasons, dependents, damping })),
    );
    expect(payload.collisions.map((c: { name: string }) => c.name)).toEqual(['entity0', 'entity4']);
    expect(payload.collisions[1]).toEqual({
      name: 'entity4',
      minJaccard: 0.1,
      occurrences: view.collisions[4]!.occurrences.map((occurrence) => ({ ...occurrence, memberCount: 3 })),
      occurrenceCount: 4,
    });
  });

  it('candidate caps occurrences and members at 15 with counts, keeping all of its own occurrences', async () => {
    const view = fixtureView();
    const payload = await call(view, { mode: 'contexts', candidate: 12 });
    const entity0 = payload.collisions.find((c: { name: string }) => c.name === 'entity0');

    expect(entity0.occurrenceCount).toBe(120);
    expect(entity0.occurrences).toHaveLength(15);
    // Candidate 12 holds every 12th occurrence (10 of them, the last at index 119): the cap keeps them all and
    // fills up with the first others, and the list stays in view order.
    expect(entity0.occurrences.map((o: { candidate: number }) => o.candidate)).toEqual([
      1, 2, 3, 4, 5, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12,
    ]);
    expect(entity0.occurrences.at(-1).symbolId).toBe(view.collisions[0]!.occurrences[119]!.symbolId);
    for (const occurrence of entity0.occurrences) {
      expect(occurrence.members).toHaveLength(15);
      expect(occurrence.memberCount).toBe(20);
    }
    expect(view.collisions[0]!.occurrences).toHaveLength(120);
    expect(view.collisions[0]!.occurrences[0]!.members).toHaveLength(20);
  });

  it('an unknown candidate id is a graceful miss', async () => {
    const payload = await call(fixtureView(), { mode: 'contexts', candidate: 99 });

    expect(payload).toMatchObject({
      found: false,
      hint: 'No candidate 99 in the contexts view. Call without candidate for the list.',
    });
    expect(payload.candidate).toBeUndefined();
  });

  it('a candidate id that is not a positive integer is rejected', async () => {
    for (const bad of [0, -1, 1.5, 'one']) {
      const payload = await call(fixtureView(), { mode: 'contexts', candidate: bad });
      expect(payload.error).toBe(true);
    }
  });

  it('without a view both requests return found false with the run ctxo index hint', async () => {
    for (const args of [{ mode: 'contexts' }, { mode: 'contexts', candidate: 1 }]) {
      const payload = await call(undefined, args);
      expect(payload).toMatchObject({
        found: false,
        hint: 'No contexts view available. Run ctxo index to generate one.',
      });
      expect(payload.candidates).toBeUndefined();
    }
  });

  it('labels that match masking.clusterLabels are masked in the summary and in the detail', async () => {
    const view = buildView([candidate(1, 'src/payment-core', 3), candidate(2, 'orders', 3)]);
    const masker = new ClusterLabelMasker(['src/payment*']);

    const summary = await call(view, { mode: 'contexts' }, masker);
    const labels = summary.candidates.map((c: { label: string }) => c.label) as string[];
    expect(labels).toEqual(['[masked-cluster-1]', 'orders']);

    const detail = await call(view, { mode: 'contexts', candidate: 1 }, masker);
    expect(detail.candidate.label).toBe('[masked-cluster-1]');
    expect(JSON.stringify(detail)).not.toContain('src/payment-core');
    expect((await call(view, { mode: 'contexts', candidate: 2 }, masker)).candidate.label).toBe('orders');
  });

  it('mode both is unchanged and carries no candidates', async () => {
    const payload = await call(buildView([candidate(1, 'orders', 3)]), { mode: 'both' });

    expect(payload.layers).toBeDefined();
    expect(payload.candidates).toBeUndefined();
  });

  it('layer keeps precedence over mode contexts and candidate', async () => {
    const payload = await call(buildView([candidate(1, 'orders', 3)]), { mode: 'contexts', layer: 'Domain', candidate: 1 });

    expect(payload.layer).toBe('Domain');
    expect(payload.candidates).toBeUndefined();
    expect(payload.candidate).toBeUndefined();
  });
});

