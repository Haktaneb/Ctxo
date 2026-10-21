import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStorageAdapter } from '../../storage/sqlite-storage-adapter.js';
import { MaskingPipeline } from '../../../core/masking/masking-pipeline.js';
import { handleGetArchitecturalOverlay, buildCommunityOverlay } from '../get-architectural-overlay.js';
import type { CommunitySnapshot, FileIndex } from '../../../core/types.js';
import { ClusterLabelMasker } from '../../../core/overlay/cluster-label-masker.js';
import { resolveContextsViewConfig } from '../../../core/config/load-config.js';
import type { ContextCandidate, ContextsView } from '../../../core/contexts-view/contexts-view-builder.js';
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

  function candidate(id: number, label: string, fileCount: number): ContextCandidate {
    const files = Array.from({ length: fileCount }, (_, i) => `src/c${id}/file-${String(i).padStart(3, '0')}.ts`);
    return {
      id,
      label,
      fingerprint: `fp-${id}`,
      fileCount,
      files,
      cohesion: 0.5,
      topTerms: [],
      crossEdges: [],
      coChangePairs: [],
    };
  }

  function buildView(candidates: ContextCandidate[]): ContextsView {
    return {
      version: 1,
      commitSha: 'abc1234',
      settings: resolveContextsViewConfig({} as never),
      coverage: { files: 100, covered: 90, ratio: 0.9 },
      candidates,
      hubs: [],
      unclustered: { count: 20, files: Array.from({ length: 20 }, (_, i) => `src/u/f-${i}.ts`) },
      collisions: [],
    };
  }

  function port(view: ContextsView | undefined): IContextsViewPort {
    return { readContextsView: () => view };
  }

  it('mode contexts returns candidates at the top level with files capped at 15 and fileCount kept', async () => {
    const view = buildView([candidate(0, 'orders', 20)]);
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline(), undefined, undefined, undefined, port(view));
    const payload = JSON.parse((await handler({ mode: 'contexts' })).content[0]!.text);

    expect(payload.layers).toBeUndefined();
    expect(payload.candidates).toHaveLength(1);
    expect(payload.candidates[0].files).toHaveLength(15);
    expect(payload.candidates[0].fileCount).toBe(20);
    expect(payload.unclustered.files).toHaveLength(15);
    expect(payload.unclustered.count).toBe(20);
    expect(view.candidates[0]!.files).toHaveLength(20);
  });

  it('mode contexts without a view returns the run ctxo index hint', async () => {
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline(), undefined, undefined, undefined, port(undefined));
    const payload = JSON.parse((await handler({ mode: 'contexts' })).content[0]!.text);

    expect(payload.hint).toBe('No contexts view available. Run ctxo index to generate one.');
    expect(payload.candidates).toBeUndefined();
  });

  it('mode contexts caps hubs and collisions at 50 with totals', async () => {
    const hubs = Array.from({ length: 60 }, (_, i) => ({ file: `src/h${i}.ts`, reasons: ['path'], dependents: 3, damping: 0.5 }));
    const view = { ...buildView([candidate(0, 'orders', 3)]), hubs } as unknown as ContextsView;
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline(), undefined, undefined, undefined, port(view));
    const payload = JSON.parse((await handler({ mode: 'contexts' })).content[0]!.text);

    expect(payload.hubs).toHaveLength(50);
    expect(payload.hubsTotal).toBe(60);
    expect(payload.collisions).toHaveLength(0);
    expect(payload.collisionsTotal).toBe(0);
    expect(view.hubs).toHaveLength(60);
  });

  it('mode contexts truncates candidates through the envelope', async () => {
    process.env['CTXO_RESPONSE_LIMIT'] = '2048';
    const view = buildView(Array.from({ length: 40 }, (_, i) => candidate(i, `context-${i}`, 15)));
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline(), undefined, undefined, undefined, port(view));
    const payload = JSON.parse((await handler({ mode: 'contexts' })).content[0]!.text);

    expect(payload._meta.truncated).toBe(true);
    expect(payload._meta.hint).toContain('ctxo contexts --json');
    expect(payload.candidates.length).toBeLessThan(40);
  });

  it('mode contexts masks candidate labels that match masking.clusterLabels', async () => {
    const view = buildView([candidate(0, 'src/payment-core', 3), candidate(1, 'orders', 3)]);
    const masker = new ClusterLabelMasker(['src/payment*']);
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline(), undefined, undefined, masker, port(view));
    const payload = JSON.parse((await handler({ mode: 'contexts' })).content[0]!.text);

    const labels = payload.candidates.map((c: { label: string }) => c.label) as string[];
    expect(labels).toContain('[masked-cluster-1]');
    expect(labels).toContain('orders');
    expect(labels).not.toContain('src/payment-core');
  });

  it('mode both is unchanged and carries no candidates', async () => {
    const view = buildView([candidate(0, 'orders', 3)]);
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline(), undefined, undefined, undefined, port(view));
    const payload = JSON.parse((await handler({ mode: 'both' })).content[0]!.text);

    expect(payload.layers).toBeDefined();
    expect(payload.candidates).toBeUndefined();
  });

  it('layer keeps precedence over mode contexts', async () => {
    const view = buildView([candidate(0, 'orders', 3)]);
    const handler = handleGetArchitecturalOverlay(storage, new MaskingPipeline(), undefined, undefined, undefined, port(view));
    const payload = JSON.parse((await handler({ mode: 'contexts', layer: 'Domain' })).content[0]!.text);

    expect(payload.layer).toBe('Domain');
    expect(payload.candidates).toBeUndefined();
  });
});
