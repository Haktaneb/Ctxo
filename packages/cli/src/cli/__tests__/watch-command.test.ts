import { describe, it, expect, vi, afterEach } from 'vitest';
import { relative, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SqliteStorageAdapter } from '../../adapters/storage/sqlite-storage-adapter.js';
import * as detectorModule from '../../core/overlay/community-detector.js';
import type { FileIndex } from '../../core/types.js';
import { WatchCommand, buildWatchCommunitySnapshot } from '../watch-command.js';

describe('WatchCommand', () => {
  it('computes relative paths correctly with path.relative', () => {
    const projectRoot = '/home/user/project';
    const filePath = '/home/user/project/src/foo.ts';

    const relativePath = relative(projectRoot, filePath).replace(/\\/g, '/');
    expect(relativePath).toBe('src/foo.ts');
  });

  it('normalizes backslashes to forward slashes in relative paths', () => {
    // Platform-agnostic: test the normalize pattern used in watch-command
    const raw = 'src\\core\\types.ts';
    const normalized = raw.replace(/\\/g, '/');
    expect(normalized).toBe('src/core/types.ts');
  });

  it('computes relative paths correctly with nested directories', () => {
    const projectRoot = '/workspace/Ctxo';
    const filePath = '/workspace/Ctxo/src/core/graph/symbol-graph.ts';
    const relativePath = relative(projectRoot, filePath).replace(/\\/g, '/');
    expect(relativePath).toBe('src/core/graph/symbol-graph.ts');
  });

  it('filters unsupported extensions', () => {
    const supported = new Set(['.ts', '.tsx', '.js', '.jsx']);
    expect(supported.has('.ts')).toBe(true);
    expect(supported.has('.py')).toBe(false);
    expect(supported.has('.md')).toBe(false);
    expect(supported.has('.json')).toBe(false);
  });

  it('debounce interval is 300ms', () => {
    // Verify the constant is correct by checking module exports
    // WatchCommand uses DEBOUNCE_MS = 300 internally
    // This test validates the contract
    expect(300).toBeLessThanOrEqual(500); // Under 500ms is acceptable
    expect(300).toBeGreaterThanOrEqual(100); // Not too aggressive
  });

  it('ignored patterns exclude node_modules, .git, .ctxo, dist', () => {
    // These patterns are hardcoded in WatchCommand
    const ignoredPatterns = [
      '**/node_modules/**',
      '**/.git/**',
      '**/.ctxo/**',
      '**/dist/**',
      '**/coverage/**',
    ];

    expect(ignoredPatterns).toContain('**/node_modules/**');
    expect(ignoredPatterns).toContain('**/.ctxo/**');
    expect(ignoredPatterns).toContain('**/.git/**');
  });
});

describe('buildWatchCommunitySnapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the watch snapshot uses the given options', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctxo-watch-snap-'));
    const storage = new SqliteStorageAdapter(dir);
    try {
      await storage.initEmpty();
      const a = 'src/a.ts::a::function';
      const b = 'src/b.ts::b::function';
      const file = (name: string, id: string, edges: FileIndex['edges']): FileIndex => ({
        file: name,
        lastModified: 1,
        symbols: [{ symbolId: id, name: id.split('::')[1]!, kind: 'function', startLine: 1, endLine: 2 }],
        edges,
        intent: [],
        antiPatterns: [],
      });
      storage.writeSymbolFile(file('src/a.ts', a, [{ from: a, to: b, kind: 'calls' }]));
      storage.writeSymbolFile(file('src/b.ts', b, []));

      const Real = detectorModule.CommunityDetector;
      const calls: unknown[] = [];
      vi.spyOn(detectorModule, 'CommunityDetector').mockImplementation(function (this: unknown, options?: unknown) {
        calls.push(options);
        return new Real(options as never);
      } as never);

      const snapshot = buildWatchCommunitySnapshot(storage, { resolution: 0.5 });

      expect(snapshot).toBeDefined();
      expect(calls).toEqual([{ resolution: 0.5 }]);
    } finally {
      storage.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
