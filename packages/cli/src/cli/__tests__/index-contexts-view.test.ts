import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeAndWriteContextsView } from '../index-contexts-view.js';
import { DEFAULT_CONFIG } from '../../core/config/config-schema.js';
import type { CoChangeEntry, CommunitySnapshot, FileIndex } from '../../core/types.js';

const FILES = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];

const SNAPSHOT: CommunitySnapshot = {
  version: 1,
  computedAt: '2026-10-21T00:00:00.000Z',
  commitSha: 'abc1234',
  modularity: 0,
  communities: [],
  godNodes: [],
  edgeQuality: 'full',
  crossClusterEdges: 0,
};

function plain(file: string): FileIndex {
  return { file, lastModified: 1, symbols: [], edges: [], intent: [], antiPatterns: [] };
}

describe('computeAndWriteContextsView', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('checks the working tree once per path, however often the file graph asks about it', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ctxo-contexts-step-'));
    dirs.push(projectRoot);
    const ctxoRoot = join(projectRoot, '.ctxo');
    mkdirSync(join(ctxoRoot, 'index'), { recursive: true });
    // Every pair co-changes, so each file is named in three entries, each listed under both of its files.
    const entries: CoChangeEntry[] = [];
    for (let i = 0; i < FILES.length; i++) {
      for (let j = i + 1; j < FILES.length; j++) {
        entries.push({ file1: FILES[i]!, file2: FILES[j]!, sharedCommits: 3, frequency: 0.5 });
      }
    }
    writeFileSync(join(ctxoRoot, 'index', 'co-changes.json'), JSON.stringify({ version: 1, timestamp: 1, entries }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const checks = new Map<string, number>();
    const exists = (path: string): boolean => {
      checks.set(path, (checks.get(path) ?? 0) + 1);
      return true;
    };

    const view = computeAndWriteContextsView({
      projectRoot,
      ctxoRoot,
      config: DEFAULT_CONFIG,
      indices: FILES.map(plain),
      snapshot: SNAPSHOT,
      symbolPageRank: new Map(),
      exists,
    });

    expect(view.coverage.files).toBe(FILES.length);
    expect([...checks.keys()].sort()).toEqual(FILES.map((file) => join(projectRoot, file)).sort());
    expect([...checks.values()]).toEqual(FILES.map(() => 1));
  });
});
